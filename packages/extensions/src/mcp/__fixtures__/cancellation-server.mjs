// Local isolated side-effect fixture: deliberately ignores protocol cancellation.
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.env.FLUX_CANCELLATION_FIXTURE
if (!root) throw new Error('Fixture directory required')
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') respond(request.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'isolated-cancellation', version: '1' } })
  if (request.method === 'tools/list') respond(request.id, { tools: [{ name: 'write_later', description: 'Isolated fixture', inputSchema: { type: 'object', properties: {} } }] })
  if (request.method === 'notifications/cancelled') writeFileSync(join(root, 'cancelled'), 'received')
  if (request.method === 'tools/call') {
    appendFileSync(join(root, 'calls'), '1\n')
    writeFileSync(join(root, 'started'), 'started')
    setTimeout(() => {
      writeFileSync(join(root, 'effect'), 'effect after cancellation')
      respond(request.id, { content: [{ type: 'text', text: 'effect completed' }] })
    }, 300)
  }
})
