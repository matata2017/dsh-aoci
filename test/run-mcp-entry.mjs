import { spawn } from 'node:child_process'
import fs from 'node:fs'

const repo = process.argv[2]
if (!repo) throw new Error('usage: node run-mcp-entry.mjs <repo>')
const child = spawn('D:/aoci-dsh/plugin/bin/aoci.exe', ['--repo', repo, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
const req = (method, params, id) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
let buffer = ''

function onMessage(message) {
  if (message.error) {
    console.error('MCP error=', JSON.stringify(message.error))
    child.kill()
    return
  }
  if (message.id === 2) {
    const result = JSON.parse(message.result.content[0].text)
    console.log('maintain status=', result.status)
    console.log('batch=', result.code_plan.batch_id)
    console.log('candidates=', result.candidates.map(candidate => candidate.path).join(','))
    console.log('targets=', result.code_plan.total_targets, 'included=', result.code_plan.included)
    if (result.candidates.length !== 1) throw new Error(`expected one candidate, got ${result.candidates.length}`)
    const body = {
      code_batch_id: result.code_plan.batch_id,
      entries: [{
        path: result.candidates[0].path,
        candidate_id: result.candidates[0].candidate_id,
        new_entry: 'AOCI_MCP_TEST.md[CG3T]: F:AOCI MCP entry pipeline test file | R:- | A:- | S:-',
        source_sha256: result.candidates[0].source_sha256,
      }],
    }
    child.stdin.write(req('tools/call', { name: 'aoci_update_entry', arguments: body }, 3))
  }
  if (message.id === 3) {
    const result = JSON.parse(message.result.content[0].text)
    fs.writeFileSync(process.argv[3] ?? 'D:/aoci-entry-result.json', JSON.stringify(result, null, 2))
    console.log('update status=', result.status, 'applied=', result.applied, 'findings=', result.finding_count)
    child.kill()
  }
}

child.stdout.on('data', chunk => {
  buffer += String(chunk)
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.trim() === '') continue
    onMessage(JSON.parse(line))
  }
})
child.stderr.on('data', chunk => process.stderr.write(chunk))
child.stdin.write(req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aoci-test', version: '1.0.0' } }, 1))
setTimeout(() => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'), 100)
setTimeout(() => child.stdin.write(req('tools/call', { name: 'aoci_maintain', arguments: {} }, 2)), 300)
setTimeout(() => child.kill(), 60000)
