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
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REPO = 'D:/aoci-code'
const DEFAULT_AOCI = fileURLToPath(new URL('./bin/aoci.exe', import.meta.url))
const DEBUG_LOG = 'D:/aoci-dsh/aoci-debug.log'
const MAX_TIMEOUT_MS = 600_000

function debug(config, message) {
  if (config?.debug !== true) return
  try {
    mkdirSync('D:/aoci-dsh', { recursive: true })
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch { /* diagnostics must never break the integration */ }
}

function repoOf(config, agent) {
  return process.env.AOCI_REPO || config?.repoRoot || agent?.session?.header?.cwd || DEFAULT_REPO
}

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

function repoRelative(repo, filePath) {
  const rel = isAbsolute(filePath) ? relative(repo, filePath) : filePath
  // On Windows, path.relative() returns the original absolute path when the two
  // paths are on different drives; AOCI refuses drive paths.
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.replaceAll('\\', '/')
}

function aociTool(config) {
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
        },
        required: ['exitCode', 'stdout', 'stderr', 'timedOut'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stdout.length > 0 ? value.stdout : (value.stderr.length > 0 ? value.stderr : `aoci exited with code ${value.exitCode}`),
      }],
    },
    async execute(input, exec = {}) {
      const repo = repoOf(config, exec.agent)
      const args = ['--repo', repo, String(input.command)]
      if (Array.isArray(input.args)) args.push(...input.args.map(value => String(value)))
      return runAoci(args, {
        cwd: repo,
        timeoutMs: input.timeoutMs,
        signal: exec.signal,
        config,
      })
    },
  }
}

function mountMcp(ctx, config) {
  if (config?.enableMcp === false) return
  const repo = repoOf(config)
  if (!repo) {
    ctx.logger?.warn?.('aoci: no repoRoot configured; MCP server not registered')
    return
  }
  ctx.inject(['mcpManager'], mcpCtx => {
    const manager = mcpCtx.mcpManager ?? mcpCtx.get?.('mcpManager')
    if (manager === undefined) {
      ctx.logger?.warn?.('aoci: mcpManager is unavailable; MCP server not registered')
      return
    }
    mcpCtx.effect(() => manager.register('aoci', {
      transport: 'stdio',
      command: aociOf(config),
      args: ['--repo', repo, 'mcp'],
      cwd: repo,
      startupTimeoutMs: 30_000,
    }), 'aoci MCP server')
    debug(config, `mcp registered name=aoci repo=${repo}`)
    const logStatus = () => {
      try {
        const view = manager.list?.().find?.(entry => entry?.name === 'aoci')
        debug(config, `mcp status=${JSON.stringify(view)}`)
      } catch (error) {
        debug(config, `mcp list failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    setTimeout(logStatus, 800)
    setTimeout(logStatus, 4000)
    ctx.logger?.info?.(`aoci: MCP server registered (repo=${repo})`)
  })
}

function mountHooks(ctx, config) {
  if (config?.enableHooks === false) return

  const attach = agent => {
    if (agent?.ctx === undefined || agent?.session?.header?.origin === 'subagent') return
    ctx.effect(() => agent.ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (!looksLikeWriteTool(exec?.name)) return next()
        const rawPath = targetPath(exec?.arguments)
        if (rawPath === undefined) return next()
        const repo = repoOf(config, agent)
        if (!existsSync(`${repo}/.aoci`) && !existsSync(`${repo}\\.aoci`)) return next()
        const path = repoRelative(repo, rawPath)
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
        const repo = repoOf(config, agent)
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
  ctx.effect(() => {
    const dispose = ctx.tools.register(aociTool(config))
    debug(config, 'aoci CLI tool registered')
    try {
      const names = ctx.tools.definitions?.().map(definition => definition.name).filter(name => name === 'aoci')
      debug(config, `aoci tool definitions=${JSON.stringify(names)}`)
    } catch (error) {
      debug(config, `aoci tool definitions failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return dispose
  }, 'aoci CLI tool')
  mountMcp(ctx, config)
  mountHooks(ctx, config)
}
