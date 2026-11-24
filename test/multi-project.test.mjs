import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { apply } from '../plugin/index.js'

function host() {
  const tools = new Map()
  const servers = new Map()
  const hooks = new Map()
  const agent = { session: {}, ctx: { on: (name, callback) => hooks.set(name, callback) } }
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    agents: { list: () => [agent] },
    on() {},
    effect: callback => callback(),
    inject: (_keys, callback) => callback({
      effect: fn => fn(),
      mcpManager: {
        list: () => [...servers.keys()].map(name => ({ name })),
        register: (name, entry) => servers.set(name, entry),
      },
    }),
  }
  return { agent, ctx, hooks, servers, tools }
}

async function overview(entry) {
  const child = spawn(entry.command, entry.args, { cwd: entry.cwd, stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = createInterface({ input: child.stdout })
  const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  let timer
  let exited = new Promise(resolve => child.once('close', resolve))
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => reject(new Error(`MCP exited before its response (${code})`)))
      timer = setTimeout(() => reject(new Error('MCP response timed out')), 6000)
      lines.on('line', line => {
        try {
          const message = JSON.parse(line)
          if (message.error) return reject(new Error(JSON.stringify(message.error)))
          if (message.id === 1) {
            send(undefined, 'notifications/initialized', {})
            send(2, 'tools/call', { name: 'aoci_overview', arguments: { check_only: true } })
          }
          if (message.id === 2) {
            assert.ok(!message.result.isError, JSON.stringify(message.result))
            resolve(JSON.parse(message.result.content[0].text))
          }
        } catch (error) { reject(error) }
      })
      send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'multi-project-test', version: '1' } })
    })
  } finally {
    clearTimeout(timer)
    lines.close()
    child.kill()
    await exited
  }
}

function fixtures(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-aoci-multi-')))
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5 }))
  return projectId => {
    const repoRoot = join(temp, projectId)
    mkdirSync(join(repoRoot, '.aoci'), { recursive: true })
    for (const name of ['aoci.txt', 'aoci.code.txt', 'aoci.meta.txt', '.aoci/config.json', '.aoci/baseline.json']) {
      cpSync(new URL(`../${name}`, import.meta.url), join(repoRoot, name))
    }
    return { projectId, repoRoot }
  }
}

test('one session switches repository-bound MCP instances and denied calls leave both indexes intact', async t => {
  const fixture = fixtures(t)
  const a = fixture('loan')
  const b = fixture('pinrong')
  const missing = { projectId: 'template', repoRoot: join(a.repoRoot, '..', 'unavailable') }
  const { agent, ctx, hooks, servers, tools } = host()
  apply(ctx, { projects: [a, b, missing], enableHooks: false })
  assert.deepEqual([...servers.keys()], ['aoci_loan', 'aoci_pinrong'])
  const select = projectId => tools.get('aoci_project').execute({ projectId }, { agent })
  const call = (server, method, next) => hooks.get('tools/pre-execute')({ name: `mcp__${server}__${method}`, agent }, next)
  const snapshots = [a, b].map(project => readFileSync(join(project.repoRoot, 'aoci.code.txt')))
  const deny = () => assert.fail('request to the wrong repository reached the server')
  assert.equal((await call('aoci_loan', 'aoci_maintain', deny)).kind, 'deny')
  for (const [project, other] of [[a, b], [b, a]]) {
    const result = await select(project.projectId)
    const key = `aoci_${project.projectId}`
    assert.equal(result.selected, project.projectId)
    assert.equal((await call(`aoci_${other.projectId}`, 'aoci_update_entry', deny)).kind, 'deny')
    assert.equal((await call('aoci', 'aoci_maintain', deny)).kind, 'deny')
    const report = await call(key, 'aoci_overview', () => overview(servers.get(key)))
    assert.equal(realpathSync(report.assessment.cognition_receipt.runtime_repository_root), project.repoRoot)
    const cli = tools.get('aoci')
    assert.equal((await cli.execute({ command: 'status', projectId: project.projectId, args: ['--json'] }, { agent })).exitCode, 0)
    await assert.rejects(cli.execute({ command: 'status', args: [`--repo=${other.repoRoot}`] }, { agent }), /owned by project routing/)
    await assert.rejects(cli.execute({ command: 'update-entry', args: ['--path=x', '--entry=y'] }, { agent }), /requires --preview/)
  }
  await select('template')
  assert.equal((await call('aoci_template', 'aoci_maintain', deny)).kind, 'deny')
  for (const [i, project] of [a, b].entries()) assert.deepEqual(readFileSync(join(project.repoRoot, 'aoci.code.txt')), snapshots[i])
})

test('multi-project write hook checks the selected repository and denies writes to another', async t => {
  const fixture = fixtures(t)
  const a = fixture('loan')
  const b = fixture('pinrong')
  const configPath = join(a.repoRoot, '.aoci', 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.hook_strict = true
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(join(a.repoRoot, 'aoci.code.txt'), '#AOCI-CODE-VOLUME: 1\n===/<repository>/===\n.gitattributes[FC5T]: F:Configure Git file attributes | R:- | A:- | S:-\n')
  const managedPath = join(a.repoRoot, '.gitattributes')
  cpSync(new URL('../.gitattributes', import.meta.url), managedPath)

  const { agent, ctx, hooks, tools } = host()
  const injected = []
  agent.session.header = { cwd: a.repoRoot }
  agent.inject = message => injected.push(message)
  apply(ctx, { projects: [a, b], enableMcp: false, enableHooks: true })
  await tools.get('aoci_project').execute({ projectId: a.projectId }, { agent })
  const write = (filePath, next) => hooks.get('tools/pre-execute')(
    { name: 'write', arguments: { file_path: filePath }, agent }, next,
  )
  let nextCalls = 0
  const next = async () => { nextCalls++; return { kind: 'allow' } }

  const crossProject = await write(join(b.repoRoot, 'new.txt'), next)
  assert.equal(crossProject.kind, 'deny')
  assert.match(crossProject.reason, /belongs to pinrong/)
  assert.equal(nextCalls, 0)

  assert.equal((await write('.gitattributes', next)).kind, 'allow')
  assert.equal(nextCalls, 1)
  assert.match(injected[0]?.content[0].text, /Configure Git file attributes/)

  writeFileSync(managedPath, '\n# stale-test\n', { flag: 'a' })
  const stale = await write('.gitattributes', next)
  assert.equal(stale.kind, 'deny')
  assert.match(stale.reason, /stale|blocked/i)
  assert.equal(nextCalls, 1)
})
