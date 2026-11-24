import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply } from '../plugin/index.js'

const SOURCE_REPO = process.env.AOCI_TEST_REPO ?? fileURLToPath(new URL('..', import.meta.url))
const TEMP = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-aoci-test-')))
const HOOK_REPO = join(TEMP, 'hook')
process.once('exit', () => rmSync(TEMP, { recursive: true, force: true }))

function prepareHookRepo() {
  mkdirSync(HOOK_REPO, { recursive: true })
  for (const name of ['aoci.txt', 'aoci.meta.txt', 'aoci.code.txt', '.gitattributes']) {
    cpSync(`${SOURCE_REPO}/${name}`, `${HOOK_REPO}/${name}`)
  }
  mkdirSync(join(HOOK_REPO, '.aoci'))
  for (const name of ['config.json', 'baseline.json']) {
    cpSync(join(SOURCE_REPO, '.aoci', name), join(HOOK_REPO, '.aoci', name))
  }
  writeFileSync(join(HOOK_REPO, 'aoci.code.txt'), '#AOCI-CODE-VOLUME: 1\n===/<repository>/===\n.gitattributes[FC5T]: F:Configure Git file attributes | R:- | A:- | S:-\n')
  const configPath = `${HOOK_REPO}/.aoci/config.json`
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.hook_strict = true
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  writeFileSync(`${HOOK_REPO}/.gitattributes`, '\n# stale-test\n', { flag: 'a' })
}

function makeAgent(cwd = HOOK_REPO) {
  const handlers = new Map()
  const injected = []
  const agent = {
    id: 'agent-test',
    session: { id: 'session-test', header: { cwd } },
    ctx: {
      on(name, handler) {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
    },
    inject(message) { injected.push(message) },
  }
  return { agent, handlers, injected }
}

function makeContext(agent) {
  const tools = []
  const mcp = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on() { return () => {} },
    tools: {
      register(definition) { tools.push(definition); return () => {} },
      definitions() { return tools },
    },
    agents: { list: () => [agent] },
    inject(deps, callback) {
      if (!deps.includes('mcpManager')) return
      const mcpManager = {
        register(name, entry) { mcp.push({ name, entry }); return () => {} },
        list: () => mcp.map(item => ({ name: item.name, configured: true, status: { state: 'connected', toolCount: 9 } })),
      }
      callback({ mcpManager, effect: fn => fn() })
    },
  }
  return { ctx, tools, mcp }
}

prepareHookRepo()

test('aoci CLI tool is registered and can run status', async () => {
  const { agent } = makeAgent(SOURCE_REPO)
  const { ctx, tools } = makeContext(agent)
  apply(ctx, { repoRoot: SOURCE_REPO, enableMcp: false, enableHooks: false })
  assert.equal(tools.length, 1)
  const tool = tools[0]
  assert.equal(tool.name, 'aoci')
  const result = await tool.execute({ command: 'status', args: ['--json'] }, { agent })
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /"index_entries"/)
})

test('first status lazily registers MCP and rejects writes on a wrong receipt root', async () => {
  const { agent, handlers } = makeAgent(SOURCE_REPO)
  const { ctx, mcp, tools } = makeContext(agent)
  const repoRoot = realpathSync(SOURCE_REPO)
  let actualRoot = repoRoot
  ctx.tools.get = name => mcp.some(server => name === `mcp__${server.name}__aoci_overview`)
  ctx.tools.execute = async () => ({ results: [{ result: {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ cognition_receipt: { runtime_repository_root: actualRoot } }) }],
  } }] })
  apply(ctx, { repoRoot, enableMcp: true, enableHooks: false })
  assert.equal(mcp.length, 0)
  const status = () => tools[0].execute({ command: 'status' }, { agent })
  const first = await status()
  assert.equal(first.binding.status, 'bound')
  assert.equal(mcp.length, 1)
  assert.match(mcp[0].name, /^aoci_auto_[0-9a-f]{20}$/)
  assert.equal(mcp[0].entry.transport, 'stdio')
  assert.deepEqual(mcp[0].entry.args, ['--repo', repoRoot, 'mcp'])

  actualRoot = HOOK_REPO
  const mismatch = await status()
  assert.equal(mismatch.binding.status, 'mismatch')
  assert.equal(mismatch.binding.actualRoot, HOOK_REPO)
  assert.equal(mismatch.exitCode, 1)
  const denied = await handlers.get('tools/pre-execute')(
    { name: `mcp__${mcp[0].name}__aoci_update_entry`, arguments: {}, agent },
    async () => assert.fail('mismatched MCP write was dispatched'),
  )
  assert.equal(denied.kind, 'deny')
  await assert.rejects(tools[0].execute({ command: 'scan' }, { agent }), /binding mismatch/)
})

test('an incomplete nested AOCI project does not bind to its parent', async () => {
  const nested = join(HOOK_REPO, 'nested')
  mkdirSync(join(nested, '.aoci'), { recursive: true })
  const { agent } = makeAgent(nested)
  const { ctx, mcp, tools } = makeContext(agent)
  apply(ctx, { enableHooks: false })
  const result = await tools[0].execute({ command: 'status' }, { agent })
  assert.equal(result.binding.mode, 'auto')
  assert.equal(result.binding.status, 'unbound')
  assert.equal(result.binding.repoRoot, null)
  assert.equal(mcp.length, 0)
})

test('pre-write hook blocks a stale AOCI entry with a deny decision', async () => {
  const { agent, handlers } = makeAgent(HOOK_REPO)
  const { ctx } = makeContext(agent)
  apply(ctx, { repoRoot: HOOK_REPO, enableMcp: false, enableHooks: true })
  const handler = handlers.get('tools/pre-execute')
  assert.equal(typeof handler, 'function')
  const decision = await handler(
    { name: 'write', arguments: { file_path: `${HOOK_REPO}/.gitattributes` }, agent },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /stale|blocked/i)
})

test('pre-write hook skips paths outside the repository (cross-drive)', async () => {
  const { agent, handlers } = makeAgent(HOOK_REPO)
  const { ctx } = makeContext(agent)
  apply(ctx, { repoRoot: HOOK_REPO, enableMcp: false, enableHooks: true })
  const handler = handlers.get('tools/pre-execute')
  let nextCalls = 0
  const decision = await handler(
    { name: 'write', arguments: { file_path: 'C:/Users/666/.dsh/AGENTS.md' }, agent },
    async () => { nextCalls += 1; return { kind: 'allow' } },
  )
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(nextCalls, 1)
})

test('pre-write hook skips a relative path from another repository', async () => {
  const { agent, handlers } = makeAgent('D:/some-other-repo')
  const { ctx } = makeContext(agent)
  apply(ctx, { repoRoot: HOOK_REPO, enableMcp: false, enableHooks: true })
  const handler = handlers.get('tools/pre-execute')
  let nextCalls = 0
  const decision = await handler(
    { name: 'edit', arguments: { file_path: '.trellis/tasks/example/task.json' }, agent },
    async () => { nextCalls += 1; return { kind: 'allow' } },
  )
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(nextCalls, 1)
})

test('compaction hook injects the AOCI handoff', async () => {
  const { agent, handlers, injected } = makeAgent(HOOK_REPO)
  const { ctx } = makeContext(agent)
  apply(ctx, { repoRoot: HOOK_REPO, enableMcp: false, enableHooks: true })
  const handler = handlers.get('session/event')
  assert.equal(typeof handler, 'function')
  await handler({ id: 'session-test' }, { type: 'compaction/end' })
  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /(?:AOCI context-compaction refresh|AOCI 上下文压缩后的认知刷新)/i)
  assert.equal(injected[0].source.kind, 'aoci-hook')
})
