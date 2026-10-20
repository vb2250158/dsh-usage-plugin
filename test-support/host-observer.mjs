import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import plugin from '../lib/index.js'

const root = process.argv[2]
assert.equal(path.dirname(root), os.tmpdir())
os.homedir = () => path.join(root, 'home')
globalThis.fetch = async () => { throw new Error('Network is unavailable in this fixture') }
const directory = path.join(process.env.DSH_USAGE_DATA_DIR, 'dsh-usage')
await fs.mkdir(directory, { recursive: true })
await fs.writeFile(path.join(directory, 'pricing.json'), JSON.stringify({
  base: { 'fixture-model': { cacheHit: 1, cacheMiss: 2, output: 3 } },
  currency: 'USD', meta: { source: 'fixture', syncedAt: Date.now(), count: 1 },
}))
const listeners = new Map(), routes = new Map()
plugin.apply({
  on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name) },
  get: name => name === 'webServer' ? { register: route => routes.set(route.path, route.handler) } : undefined,
})
async function api(body) {
  let value
  await routes.get('/usage/api')(Readable.from([JSON.stringify(body)]), {
    writeHead() {}, end: text => { value = JSON.parse(text) },
  })
  assert.equal(value.ok, true)
  return value
}
await api({ action: 'list' })
const chunks = [{ type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }, { type: 'finish', reason: { kind: 'stop' } }]
const observed = []
for await (const chunk of listeners.get('llm/stream')({ provider: 'fixture', model: 'fixture-model', sessionId: 'synthetic' }, async function* () { yield* chunks })) observed.push(chunk)
assert.deepEqual(observed, chunks)
const upstreamError = new Error('Expected upstream failure')
await assert.rejects(async () => {
  for await (const chunk of listeners.get('llm/stream')({ provider: 'fixture', model: 'fixture-model', sessionId: 'synthetic' }, async function* () { throw upstreamError })) void chunk
}, error => error === upstreamError)
listeners.get('session/event')({ id: 'synthetic' }, {
  type: 'web/deepseek-search-llm-request', time: Date.now(),
  data: { endpoint: 'https://api.deepseek.com/anthropic/v1/messages', body: { model: 'fixture-model', messages: [{ role: 'user', content: 'Synthetic search' }] } },
})
const result = await api({ action: 'list' })
assert.equal(result.records.length, 3)
const ordinary = result.records.find(row => row.origin === 'probe' && !row.interrupted)
const search = result.records.find(row => row.origin === 'search-backend')
assert.equal(ordinary.autoCost, 13 / 1e6)
assert.equal(search.autoCost, search.inputTokens * 2 / 1e6)
assert.equal(search.estimated, true)
await api({ action: 'setPrices', prices: { 'fixture-model': { cacheHit: 100, cacheMiss: 200, output: 300 } } })
const repriced = await api({ action: 'list' })
assert.equal(repriced.records.find(row => row.recordId === ordinary.recordId).autoCost, ordinary.autoCost)
assert.equal(repriced.records.find(row => row.recordId === search.recordId).autoCost, search.autoCost)
console.log(JSON.stringify({ streamedChunks: observed.length, recordedCalls: result.records.length, upstreamErrorPreserved: true }))
