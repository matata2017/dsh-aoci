import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { apply } from '../plugin/index.js'

const SOURCE_REPO = process.env.AOCI_TEST_REPO ?? 'D:/aoci-code'
const HOOK_REPO = 'D:/aoci-hook-test'

function prepareHookRepo() {
  rmSync(HOOK_REPO, { recursive: true, force: true })
  mkdirSync(HOOK_REPO, { recursive: true })
  for (const name of ['aoci.txt', 'aoci.meta.txt', 'aoci.code.txt', '.gitattributes']) {
    cpSync(`${SOURCE_REPO}/${name}`, `${HOOK_REPO}/${name}`)
  }
  cpSync(`${SOURCE_REPO}/.aoci`, `${HOOK_REPO}/.aoci`, { recursive: true })
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

test('MCP manager receives a stdio AOCI registration', () => {
  const { agent } = makeAgent(SOURCE_REPO)
  const { ctx, mcp } = makeContext(agent)
  apply(ctx, { repoRoot: SOURCE_REPO, enableMcp: true, enableHooks: false })
  assert.equal(mcp.length, 1)
  assert.equal(mcp[0].name, 'aoci')
  assert.equal(mcp[0].entry.transport, 'stdio')
  assert.match(mcp[0].entry.command, /aoci\.exe$/)
  assert.deepEqual(mcp[0].entry.args, ['--repo', SOURCE_REPO, 'mcp'])
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
  assert.match(injected[0].content[0].text, /AOCI context-compaction refresh/i)
  assert.equal(injected[0].source.kind, 'aoci-hook')
})
