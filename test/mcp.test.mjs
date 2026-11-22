import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

const AOCI = 'D:/aoci-dsh/plugin/bin/aoci.exe'
const REPO = 'D:/aoci-code'

function request(method, params, id) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
}

test('aoci_rules is callable over MCP', async () => {
  const child = spawn(AOCI, ['--repo', REPO, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let response
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP aoci_rules timed out')), 8000)
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        const message = JSON.parse(line)
        if (message.id === 3) {
          response = message
          clearTimeout(timer)
          resolve()
        }
      }
    })
    child.on('error', reject)
  })
  child.stdin.write(request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'aoci-dsh-test', version: '1.0.0' },
  }, 1))
  await new Promise(resolve => setTimeout(resolve, 100))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(request('tools/call', { name: 'aoci_rules', arguments: {} }, 3))
  await done
  child.kill()
  assert.equal(response.result.isError, undefined)
  assert.match(response.result.content[0].text, /AOCI Runtime Contract/i)
})

test('aoci MCP server exposes the nine AOCI tools', async () => {
  const child = spawn(AOCI, ['--repo', REPO, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  const responses = new Map()
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP tools/list timed out')), 8000)
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        const message = JSON.parse(line)
        if (message.id !== undefined) responses.set(message.id, message)
        if (responses.has(2)) {
          clearTimeout(timer)
          resolve(responses.get(2))
        }
      }
    })
    child.on('error', reject)
  })
  child.stdin.write(request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'aoci-dsh-test', version: '1.0.0' },
  }, 1))
  await new Promise(resolve => setTimeout(resolve, 100))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(request('tools/list', {}, 2))
  const response = await done
  child.kill()
  const names = response.result.tools.map(tool => tool.name).sort()
  assert.deepEqual(names, [
    'aoci_get_entries',
    'aoci_header',
    'aoci_maintain',
    'aoci_overview',
    'aoci_remove_entry',
    'aoci_report',
    'aoci_rules',
    'aoci_search',
    'aoci_update_entry',
  ])
})
