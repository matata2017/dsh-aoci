/**
 * AOCI-CODE host integration for DeepSeek Harness.
 *
 * Three surfaces:
 *  - a stdio MCP server (`aoci mcp`) registered through ctx.mcpManager, so the
 *    nine AOCI tools appear as mcp__aoci__*;
 *  - an `aoci` tool for init/scan/status/ui/... CLI commands against repoRoot;
 *  - DSH equivalents of AOCI's hooks: pre-write guard via tools/pre-execute and
 *    a compaction handoff via session/event.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, realpathSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const DEFAULT_REPO = 'D:/aoci-code'
const DEFAULT_AOCI = fileURLToPath(new URL('./bin/aoci.exe', import.meta.url))
const MAX_TIMEOUT_MS = 600_000

function debug(config, message) {
  if (config?.debug !== true || config.projects !== undefined) return
  try {
    const log = resolve(legacyRepo(config), 'aoci-debug.log')
    appendFileSync(log, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch { /* diagnostics must never break the integration */ }
}

function legacyRepo(config, agent) {
  return process.env.AOCI_REPO || config?.repoRoot || agent?.session?.header?.cwd || DEFAULT_REPO
}

function rootKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isInitialized(repoRoot) {
  try {
    if (rootKey(realpathSync(repoRoot)) !== rootKey(repoRoot)) return false
    const localAsset = name => {
      const path = resolve(repoRoot, name)
      return rootKey(realpathSync(path)) === rootKey(path) && statSync(path)
    }
    return localAsset('.aoci').isDirectory()
      && ['aoci.txt', 'aoci.meta.txt', 'aoci.code.txt'].every(name => localAsset(name).isFile())
  } catch {
    return false
  }
}

function projectRegistry(config) {
  if (config?.projects === undefined) return undefined
  if (!Array.isArray(config.projects)) throw new Error('aoci: projects must be an array')
  const projects = new Map()
  const keys = new Set()
  const roots = new Set()
  for (const entry of config.projects) {
    if (entry?.enabled === false) continue
    const { projectId, repoRoot } = entry ?? {}
    if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(projectId)) {
      throw new Error('aoci: invalid projectId')
    }
    const slug = projectId.replace(/-+/g, '_').replace(/_$/, '')
    const suffix = createHash('sha256').update(projectId).digest('hex').slice(0, 8)
    const serverKey = entry.serverKey ?? (slug.length <= 27
      ? `aoci_${slug}` : `aoci_${slug.slice(0, 18).replace(/_$/, '')}_${suffix}`)
    if (typeof serverKey !== 'string' || serverKey.length > 32 || !/^aoci_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(serverKey)) {
      throw new Error(`aoci: invalid serverKey for ${projectId}`)
    }
    if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) {
      throw new Error(`aoci: ${projectId} requires an absolute repoRoot`)
    }
    let root = resolve(repoRoot)
    try {
      root = realpathSync(root)
    } catch {
      // Keep unavailable projects visible. Readiness is checked before dispatch.
    }
    const identity = rootKey(root)
    if (projects.has(projectId) || keys.has(serverKey) || roots.has(identity)) {
      throw new Error(`aoci: duplicate projectId, serverKey or repository for ${projectId}`)
    }
    projects.set(projectId, { ...entry, projectId, repoRoot: root, serverKey, mcp: false })
    keys.add(serverKey)
    roots.add(identity)
  }
  return { projects, selections: new WeakMap() }
}

function selectedProject(registry, agent) {
  return agent?.session && registry?.selections.get(agent.session)
}

function projectForPath(registry, absolutePath) {
  let owner
  for (const project of registry.projects.values()) {
    if ((relative(project.repoRoot, absolutePath) === '' || repoRelative(project.repoRoot, absolutePath))
      && (!owner || project.repoRoot.length > owner.repoRoot.length)) owner = project
  }
  return owner
}

function physicalPath(path) {
  if (existsSync(path)) return realpathSync(path)
  const parent = resolve(path, '..')
  return parent === path ? path : resolve(physicalPath(parent), basename(path))
}

function previewArgs(options) {
  const fields = new Map()
  let preview = false
  for (let i = 0; i < options.length; i++) {
    const flag = options[i]
    if (flag === '--preview' && !preview) {
      preview = true
      continue
    }
    const separator = flag.indexOf('=')
    const name = separator === -1 ? flag : flag.slice(0, separator)
    if (!['--path', '--entry'].includes(name) || fields.has(name)) return undefined
    const value = separator === -1 ? options[++i] : flag.slice(separator + 1)
    if (!value || (separator === -1 && value.startsWith('--'))) return undefined
    fields.set(name, value)
  }
  if (!preview || !fields.get('--path') || !fields.get('--entry')) return undefined
  return ['--preview', ...Array.from(fields, ([flag, value]) => `${flag}=${value}`)]
}

const readCommands = new Set(['status', 'verify', 'check', 'doctor', 'capabilities'])
const readSubcommands = new Map(Object.entries({
  config: ['list', 'get'],
  scope: ['status', 'preview', 'show', 'explain'],
  source: ['manifest'],
  index: ['header', 'inventory', 'score', 'agent'],
}))

function aociOf(config) {
  return config?.aociPath || DEFAULT_AOCI
}

function truncate(text, max = 12_000) {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text
}

/**
 * Run the AOCI CLI. The hook must never block the workflow because of its own
 * environment fault, so spawn failures and timeouts are reported as ordinary
 * non-blocking results (exitCode -1).
 */
function runAoci(args, { cwd, timeoutMs = 120_000, signal, config } = {}) {
  const command = aociOf(config)
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    let child
    const finish = (exitCode, timedOut = false) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ exitCode, stdout: truncate(stdout), stderr: truncate(stderr), timedOut })
    }
    try {
      child = spawn(command, args, {
        cwd: cwd ?? undefined,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(-1)
      return
    }
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { stderr += String(error.message ?? error) ; finish(-1) })
    child.on('close', code => finish(typeof code === 'number' ? code : -1))
    timer = setTimeout(() => {
      try { child.kill() } catch { /* best effort */ }
      finish(-1, true)
    }, Math.min(Math.max(1, timeoutMs), MAX_TIMEOUT_MS))
    if (signal !== undefined) {
      if (signal.aborted) {
        try { child.kill() } catch { /* best effort */ }
        finish(-1)
      } else {
        signal.addEventListener('abort', () => {
          try { child.kill() } catch { /* best effort */ }
          finish(-1)
        }, { once: true })
      }
    }
  })
}

function looksLikeWriteTool(name) {
  return /(^|[_:-])(edit|write|patch|create|delete|remove|move|rename|replace)([_:-]|$)/i.test(String(name ?? ''))
}

function targetPath(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  for (const key of ['file_path', 'filePath', 'path', 'target', 'destination', 'to']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function repoRelative(repo, filePath, cwd) {
  // Relative tool paths belong to the calling agent's cwd, not automatically to
  // AOCI's configured repository. Resolve first so another checkout's path is not
  // accidentally checked against this repository.
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd ?? repo, filePath)
  const rel = relative(repo, absolute)
  // On Windows, path.relative() returns the original absolute path when the two
  // paths are on different drives; AOCI refuses drive paths.
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return rel.replaceAll('\\', '/')
}

function projectTool(registry) {
  return {
    name: 'aoci_project',
    description: 'List AOCI projects or select a project for this session. After switching, use only the listed MCP prefix and start a fresh AOCI rules/overview or maintenance flow for that project.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { projectId: { type: 'string', description: 'Omit to list projects.' } },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          selected: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          projects: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                projectId: { type: 'string' }, repoRoot: { type: 'string' },
                serverKey: { type: 'string' }, mcpPrefix: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                initialized: { type: 'boolean' },
              },
              required: ['projectId', 'repoRoot', 'serverKey', 'mcpPrefix', 'initialized'],
            },
          },
        },
        required: ['selected', 'projects'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute({ projectId }, { agent } = {}) {
      if (projectId !== undefined) {
        const project = registry.projects.get(projectId)
        if (!project || !agent?.session) throw new Error('aoci: unknown project or missing session')
        registry.selections.set(agent.session, project)
      }
      return {
        selected: selectedProject(registry, agent)?.projectId ?? null,
        projects: Array.from(registry.projects.values(), project => ({
          projectId: project.projectId, repoRoot: project.repoRoot, serverKey: project.serverKey,
          mcpPrefix: project.mcp ? `mcp__${project.serverKey}__` : null,
          initialized: isInitialized(project.repoRoot),
        })),
      }
    },
  }
}

function sessionBindings(ctx, config) {
  const sessions = new WeakMap()
  const servers = new Map()
  const probes = new Set()
  let manager
  if (config?.enableMcp !== false) {
    ctx.inject(['mcpManager'], scope => {
      manager = scope.mcpManager ?? scope.get?.('mcpManager')
      scope.effect(() => () => {
        manager = undefined
        for (const server of servers.values()) server.dispose()
        servers.clear()
      }, 'AOCI session MCP lifetime')
    })
  }

  function resolveBinding(agent) {
    const session = agent?.session
    const cwd = (session && ctx.get?.('workingDirectory')?.get(session)) ?? session?.header?.cwd ?? null
    const configured = config?.repoRoot || process.env.AOCI_REPO
    const mode = configured ? 'fixed' : 'auto'
    const directory = configured || cwd
    let repoRoot = null
    if (directory && isAbsolute(directory)) {
      try {
        const root = realpathSync(directory)
        if (statSync(root).isDirectory()) {
          if (mode === 'fixed') repoRoot = root
          else for (let path = root; ; path = resolve(path, '..')) {
            if (isInitialized(path)) { repoRoot = path; break }
            // An incomplete nested project must not fall through to its parent.
            if (existsSync(resolve(path, 'aoci.txt')) || existsSync(resolve(path, '.aoci'))) break
            if (resolve(path, '..') === path) break
          }
        }
      } catch { /* unavailable directory */ }
    }
    const previous = session && sessions.get(session)
    const sameRoot = repoRoot !== null && previous?.repoRoot !== null && previous?.repoRoot !== undefined
      && rootKey(previous.repoRoot) === rootKey(repoRoot)
    const binding = sameRoot ? previous : { repoRoot, actualRoot: null, status: 'unbound', serverKey: null }
    binding.cwd = cwd
    binding.mode = mode
    if (session) sessions.set(session, binding)
    return binding
  }

  async function verify(agent, signal) {
    const binding = resolveBinding(agent)
    const { repoRoot } = binding
    if (!repoRoot || !isInitialized(repoRoot) || !manager) return binding
    const identity = rootKey(repoRoot)
    let server = servers.get(identity)
    try {
      if (!server) {
        const key = `aoci_auto_${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`
        const dispose = manager.register(key, {
          transport: 'stdio', command: aociOf(config), args: ['--repo', repoRoot, 'mcp'], cwd: repoRoot,
          startupTimeoutMs: 5000, toolCallTimeoutMs: 5000, failOnStartupError: false,
        })
        server = { key, dispose }
        servers.set(identity, server)
      }
      binding.serverKey = server.key
      const name = `mcp__${server.key}__aoci_overview`
      const deadline = AbortSignal.timeout(6000)
      const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      while (!ctx.tools.get(name, agent)) {
        await delay(25, undefined, { signal: probeSignal })
      }
      const id = randomUUID()
      probes.add(id)
      let result
      try {
        const { results } = await ctx.tools.execute({ agent, signal: probeSignal, calls: [{
          type: 'tool_call', id, name, arguments: JSON.stringify({ check_only: true }),
        }] })
        result = results[0]?.result
      } finally {
        probes.delete(id)
      }
      if (!result || result.isError) throw new Error(result?.error?.message ?? 'MCP overview failed')
      const payload = JSON.parse(result.content.find(item => item.type === 'text').text)
      const actual = payload.assessment?.cognition_receipt?.runtime_repository_root
        ?? payload.cognition_receipt?.runtime_repository_root
      if (typeof actual !== 'string' || !isAbsolute(actual)) throw new Error('MCP receipt lacks a repository root')
      binding.actualRoot = actual
      binding.status = rootKey(resolve(actual)) === identity ? 'bound' : 'mismatch'
    } catch (error) {
      binding.actualRoot = null
      binding.status = 'unavailable'
      ctx.logger?.warn?.(`aoci: ${error.message}`)
    }
    return resolveBinding(agent)
  }

  return { resolve: resolveBinding, verify, isProbe: exec => probes.has(exec.callId) && exec.name.endsWith('__aoci_overview') && exec.arguments?.check_only === true }
}

function bindingText(binding) {
  return [
    `AOCI session cwd: ${binding.cwd ?? '-'}`,
    `AOCI binding mode: ${binding.mode}`,
    `AOCI target repoRoot: ${binding.repoRoot ?? '-'}`,
    `AOCI MCP actual root: ${binding.actualRoot ?? '-'}`,
    `AOCI binding status: ${binding.status}`,
    `AOCI MCP server key: ${binding.serverKey ?? '-'}`,
  ].join('\n')
}

function aociTool(config, registry, sessions) {
  return {
    name: 'aoci',
    description: 'Run an AOCI-CODE CLI command against the configured AOCI repository. Use this for init, scan, status, verify, check, doctor, index, config, scope, source, database, ui, capabilities and update-entry. The MCP tools handle index reads and maintenance; this tool owns the setup/scan/UI commands.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: 'AOCI command to run, for example init, scan, status, verify, check, doctor, index or ui.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments passed after the command, for example ["--locale","en-US","--agent","codex"].',
        },
        projectId: {
          type: 'string',
          description: 'Optional assertion of the session project selected with aoci_project.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional command timeout in milliseconds (default 120000, maximum 600000).',
        },
      },
      required: ['command'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          timedOut: { type: 'boolean' },
          binding: { type: 'object' },
        },
        required: ['exitCode', 'stdout', 'stderr', 'timedOut'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [value.binding && bindingText(value.binding), value.stdout || value.stderr || `aoci exited with code ${value.exitCode}`].filter(Boolean).join('\n'),
      }],
    },
    async execute(input, exec = {}) {
      let options = input.args ?? []
      let repo
      let binding
      if (sessions) {
        if (!/^[a-z][a-z-]*$/.test(input.command) || options.some(arg => /^--repo(?:=|$)/.test(arg))) {
          throw new Error('aoci: --repo is owned by session binding')
        }
        binding = await sessions.verify(exec.agent, exec.signal, input.command === 'status')
        if (input.command !== 'status' && binding.status === 'mismatch') {
          throw new Error('aoci: repository binding mismatch. Run aoci status before proceeding.')
        }
        repo = binding.repoRoot ?? (input.command === 'init' && binding.mode === 'auto' ? binding.cwd : null)
        if (!repo && input.command === 'status') return { exitCode: 1, stdout: '', stderr: '', timedOut: false, binding: { ...binding } }
        if (!repo) throw new Error('aoci: no project bound. Open a project directory and run aoci status, or initialize it with init --here.')
      }
      if (registry) {
        const project = selectedProject(registry, exec.agent)
        if (!project || (input.projectId !== undefined && input.projectId !== project.projectId)) {
          throw new Error('aoci: select the target project with aoci_project first')
        }
        if (options.some(arg => /^--repo(?:=|$)/.test(arg))) throw new Error('aoci: --repo is owned by project routing')
        if (input.command === 'update-entry') {
          options = previewArgs(options)
          if (!options) throw new Error('aoci: update-entry requires --preview, --path and --entry. Use MCP for writes.')
          if (!isInitialized(project.repoRoot)) throw new Error('aoci: the selected repository is not initialized')
        } else {
          const subcommands = readSubcommands.get(input.command)
          const readOnly = readCommands.has(input.command) || (subcommands?.includes(options[0])
            && (input.command !== 'index' || options[0] !== 'agent' || options[1] === 'guide'))
          if (!readOnly) throw new Error('aoci: use the selected project MCP instance for index maintenance')
        }
        repo = project.repoRoot
      }
      const args = ['--repo', repo, String(input.command), ...options]
      const result = await runAoci(args, {
        cwd: repo,
        timeoutMs: input.timeoutMs,
        signal: exec.signal,
        config,
      })
      return binding && input.command === 'status' ? { ...result, binding: { ...binding } } : result
    },
  }
}

function mountMcp(ctx, config, registry) {
  if (config?.enableMcp === false) return
  const projects = registry?.projects.values() ?? [{ repoRoot: legacyRepo(config), serverKey: 'aoci' }]
  ctx.inject(['mcpManager'], mcpCtx => {
    const manager = mcpCtx.mcpManager ?? mcpCtx.get?.('mcpManager')
    if (manager === undefined) {
      ctx.logger?.warn?.('aoci: mcpManager is unavailable; MCP server not registered')
      return
    }
    for (const project of projects) {
      const { repoRoot, serverKey } = project
      if (!repoRoot || project.enableMcp === false) continue
      if (registry && !isInitialized(repoRoot)) {
        ctx.logger?.warn?.(`aoci: skipped ${serverKey}, AOCI is unavailable or incomplete at ${repoRoot}`)
        continue
      }
      mcpCtx.effect(() => {
        try {
          if (registry && manager.list?.().some(server => server?.name === serverKey)) {
            throw new Error('MCP server key already in use')
          }
          const dispose = manager.register(serverKey, {
            transport: 'stdio',
            command: aociOf(config),
            args: ['--repo', repoRoot, 'mcp'],
            cwd: repoRoot,
            startupTimeoutMs: 30_000,
            failOnStartupError: false,
          })
          project.mcp = true
          ctx.logger?.info?.(`aoci: registered ${serverKey} for ${repoRoot}`)
          return () => {
            project.mcp = false
            dispose()
          }
        } catch (error) {
          ctx.logger?.warn?.(`aoci: could not register ${serverKey}: ${error.message}`)
        }
      }, `AOCI MCP ${serverKey}`)
    }
  })
}

function mountHooks(ctx, config, registry) {
  const attach = agent => {
    if (agent?.ctx === undefined) return
    ctx.effect(() => agent.ctx.on('tools/pre-execute', async (exec, next) => {
      if (registry && /^mcp__aoci(?:_|__)/.test(exec.name)) {
        const project = selectedProject(registry, agent)
        if (!project?.mcp || !exec.name.startsWith(`mcp__${project.serverKey}__`)
          || !isInitialized(project.repoRoot)) {
          return { kind: 'deny', reason: 'AOCI MCP call does not belong to the selected, initialized project. Use aoci_project first.' }
        }
        return next()
      }
      if (config?.enableHooks === false || agent.session?.header?.origin === 'subagent') return next()
      try {
        if (!looksLikeWriteTool(exec?.name)) return next()
        const rawPath = targetPath(exec?.arguments)
        if (rawPath === undefined) return next()
        const cwd = agent.session?.header?.cwd
        if (registry && !isAbsolute(rawPath) && !cwd) return next()
        const target = registry ? physicalPath(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)) : rawPath
        const project = registry && projectForPath(registry, target)
        if (registry && !project) return next()
        const selection = selectedProject(registry, agent)
        if (project && selection && project !== selection) {
          return { kind: 'deny', reason: `AOCI target belongs to ${project.projectId}. Select it before editing.` }
        }
        if (project && (project.enableHooks === false || !isInitialized(project.repoRoot))) return next()
        const repo = project?.repoRoot ?? legacyRepo(config, agent)
        if (!existsSync(resolve(repo, '.aoci'))) return next()
        const path = repoRelative(repo, target, cwd)
        if (path === undefined) return next()
        const result = await runAoci([
          '--repo', repo,
          'hook', 'pretool',
          '--agent', 'codex',
          '--tool', String(exec.name),
          '--path', path,
        ], { cwd: repo, timeoutMs: 20_000, signal: exec?.signal, config })
        debug(config, `pretool agent=${agent.id} tool=${exec.name} path=${path} exit=${result.exitCode}`)
        if (result.exitCode === 2 || result.exitCode === 4) {
          return { kind: 'deny', reason: (result.stderr || result.stdout || 'AOCI pre-write check blocked this write').slice(0, 4000) }
        }
        if (result.exitCode === 0 && result.stdout.trim() !== '') {
          try {
            agent.inject?.({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: result.stdout.trim() }],
              source: { kind: 'aoci-hook' },
            })
          } catch { /* hook context is best effort */ }
        }
        return next()
      } catch (error) {
        ctx.logger?.warn?.(`aoci: pre-write hook failed; allowing the tool: ${error instanceof Error ? error.message : String(error)}`)
        return next()
      }
    }), 'aoci pre-write hook')

    ctx.effect(() => agent.ctx.on('session/event', async (session, event) => {
      try {
        if (event?.type !== 'compaction/end' && event?.type !== 'compaction/summary') return
        if (config?.enableHooks === false || agent.session?.header?.origin === 'subagent') return
        const project = selectedProject(registry, agent)
        if (registry && (!project?.mcp || project.enableHooks === false || !isInitialized(project.repoRoot))) return
        const repo = project?.repoRoot ?? legacyRepo(config, agent)
        const result = await runAoci(['--repo', repo, 'hook', 'codex-compact'], {
          cwd: repo,
          timeoutMs: 20_000,
          signal: undefined,
          config,
        })
        debug(config, `compact agent=${agent.id} event=${event.type} exit=${result.exitCode}`)
        if (result.exitCode === 0 && result.stdout.trim() !== '') {
          agent.inject?.({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: result.stdout.trim() }],
            source: { kind: 'aoci-hook' },
          })
        }
      } catch (error) {
        ctx.logger?.warn?.(`aoci: compaction hook failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }), 'aoci compaction hook')
    debug(config, `hooks attached agent=${agent.id}`)
  }

  for (const agent of ctx.agents?.list?.() ?? []) attach(agent)
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => attach(agent)), 'aoci agent hook wiring')
}

export const inject = ['tools', 'agents']

export function apply(ctx, config) {
  const registry = projectRegistry(config)
  if (registry) ctx.effect(() => ctx.tools.register(projectTool(registry)), 'AOCI project selection')
  ctx.effect(() => {
    const dispose = ctx.tools.register(aociTool(config, registry))
    debug(config, 'aoci CLI tool registered')
    try {
      const names = ctx.tools.definitions?.().map(definition => definition.name).filter(name => name === 'aoci')
      debug(config, `aoci tool definitions=${JSON.stringify(names)}`)
    } catch (error) {
      debug(config, `aoci tool definitions failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return dispose
  }, 'aoci CLI tool')
  mountHooks(ctx, config, registry)
  mountMcp(ctx, config, registry)
}
