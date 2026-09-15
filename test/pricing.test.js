import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPriceIndex,
  computeCost,
  normalizeModelId,
  openRouterTable,
  resolveModelKey,
  sanitizeTable
} from '../lib/pricing.js'

// 本用例覆盖 fork 后的通用计价：原来的实现只认三个 DeepSeek 档位名，并把非
// DeepSeek 的 provider 一律计 0。价格表改为 OpenRouter 驱动的任意模型 id 后，
// 「模型名怎么匹配到价格」和「三个互斥计数怎么算」都需要固定住。

test('normalizeModelId strips the ~ alias prefix and the :variant suffix', () => {
  assert.equal(normalizeModelId('~deepseek/deepseek-pro-latest'), 'deepseek/deepseek-pro-latest')
  assert.equal(normalizeModelId('openai/gpt-6-astra:batch'), 'openai/gpt-6-astra')
  assert.equal(normalizeModelId('OpenAI/GPT-6-Astra'), 'openai/gpt-6-astra')
  assert.equal(normalizeModelId('  gpt-6-astra  '), 'gpt-6-astra')
  assert.equal(normalizeModelId(''), '')
  assert.equal(normalizeModelId(null), '')
  // 只有开头的冒号才算变体分隔符；模型名里合法的冒号不该被截断
  assert.equal(normalizeModelId(':weird'), ':weird')
})

test('resolveModelKey matches a bare model name against a provider-qualified id', () => {
  // 实录里的模型名常常没有 provider 前缀（会话日志实测为 gpt-6-astra），
  // 而价格表的 key 是 openai/gpt-6-astra。
  const index = buildPriceIndex(['openai/gpt-6-astra', 'anthropic/claude-sonnet-4.6'])
  assert.equal(resolveModelKey('gpt-6-astra', index), 'openai/gpt-6-astra')
  assert.equal(resolveModelKey('openai/gpt-6-astra', index), 'openai/gpt-6-astra')
  assert.equal(resolveModelKey('claude-sonnet-4.6', index), 'anthropic/claude-sonnet-4.6')
})

test('resolveModelKey returns empty rather than guessing a near match', () => {
  const index = buildPriceIndex(['openai/gpt-6-astra'])
  // 刻意不做近似匹配：宁可费用记 0 让人看见缺口，也不要拿别的型号价格冒充。
  assert.equal(resolveModelKey('gpt-6-astra-pro', index), '')
  assert.equal(resolveModelKey('gpt-9', index), '')
  assert.equal(resolveModelKey('', index), '')
  assert.equal(resolveModelKey(undefined, index), '')
})

test('an exact id wins over an alias pointing at the same name', () => {
  // 别名只在没有同名条目时生效，否则一个过时的别名会把精确匹配挤掉。
  const index = buildPriceIndex(['gpt-6-astra', 'openai/gpt-6-astra:batch'], { 'gpt-6-astra': 'openai/gpt-6-astra:batch' })
  assert.equal(resolveModelKey('gpt-6-astra', index), 'gpt-6-astra')
})

test('aliases resolve names the table does not carry, but never to a missing target', () => {
  const index = buildPriceIndex(['openai/gpt-6-astra'], { 'codex-route-name': 'openai/gpt-6-astra', 'dangling': 'not/in/table' })
  assert.equal(resolveModelKey('codex-route-name', index), 'openai/gpt-6-astra')
  // 指向不存在条目的别名必须被忽略，否则会把费用算成 0 却看起来「已匹配」。
  assert.equal(resolveModelKey('dangling', index), '')
})

test('computeCost treats cache-read and cache-miss input as disjoint', () => {
  // 价格表单位是「每百万 token」。
  const price = { cacheHit: 1, cacheMiss: 10, output: 50 }
  // 互斥计数：1M 命中 + 2M 未命中 → 1*1 + 2*10 = 21（不是 (1+2)*10）
  assert.equal(computeCost({ cacheReadTokens: 1e6, inputTokens: 2e6, outputTokens: 0 }, price), 21)
  assert.equal(computeCost({ inputTokens: 1e6, outputTokens: 1e6 }, price), 60)
  assert.equal(computeCost({}, price), 0)
  // 缺字段按 0 处理，不产生 NaN
  assert.equal(computeCost({ outputTokens: undefined }, price), 0)
  assert.equal(computeCost(null, price), 0)
})

test('openRouterTable converts per-token dollars to per-million', () => {
  // 数值取自 2026-09-15 实际抓取的 OpenRouter 目录（openai/gpt-6-astra）。
  const { table, scanned, skipped } = openRouterTable({
    data: [
      { id: 'openai/gpt-6-astra', pricing: { prompt: '0.00001', completion: '0.00005', input_cache_read: '0.000001' } }
    ]
  })
  assert.equal(scanned, 1)
  assert.equal(skipped, 0)
  assert.equal(table['openai/gpt-6-astra'].cacheMiss, 10)
  assert.equal(table['openai/gpt-6-astra'].output, 50)
  assert.equal(table['openai/gpt-6-astra'].cacheHit, 1)
})

test('openRouterTable falls back to the miss price when cache read is absent or zero', () => {
  // OpenRouter 对不支持缓存的模型也返回 input_cache_read，此时它是 0 而不是
  // 「缓存免费」。采信 0 会让命中缓存的那部分输入被算成不花钱，低估总花费。
  const { table } = openRouterTable({
    data: [
      { id: 'a/no-cache-field', pricing: { prompt: '0.000002', completion: '0.00001' } },
      { id: 'b/zero-cache', pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0' } },
      { id: 'c/real-cache', pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002' } }
    ]
  })
  assert.equal(table['a/no-cache-field'].cacheHit, 2)
  assert.equal(table['b/zero-cache'].cacheHit, 2)
  // 真正非零的缓存价如实保留（便宜 10 倍）
  assert.equal(table['c/real-cache'].cacheHit, 0.2)
})

test('openRouterTable skips malformed and unpriced entries instead of guessing', () => {
  const { table, skipped } = openRouterTable({
    data: [
      { id: 'ok/model', pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: '', pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'no/pricing' },
      // -1 是 OpenRouter 表示「价格未知」的哨兵值，不能当成负价格或免费
      { id: 'unknown/price', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'bad/text', pricing: { prompt: 'n/a', completion: 'n/a' } }
    ]
  })
  assert.deepEqual(Object.keys(table), ['ok/model'])
  assert.equal(skipped, 4)
})

test('openRouterTable tolerates a malformed payload', () => {
  assert.deepEqual(openRouterTable(null).scanned, 0)
  assert.deepEqual(openRouterTable({}).table, {})
  assert.deepEqual(openRouterTable({ data: 'nope' }).table, {})
})

test('sanitizeTable drops negative, non-numeric and all-zero entries', () => {
  const clean = sanitizeTable({
    'good/model': { cacheHit: 1, cacheMiss: 10, output: 50 },
    'negative/input': { cacheHit: -1, cacheMiss: 10, output: 50 },
    'nonnumeric': { cacheHit: 'x', cacheMiss: 10, output: 50 },
    'all/zero': { cacheHit: 0, cacheMiss: 0, output: 0 },
    'not/object': null,
    // 只输出价非零仍然合法：有些模型确实没有单独的缓存价
    'output/only': { cacheHit: 0, cacheMiss: 0, output: 7 }
  })
  assert.deepEqual(Object.keys(clean).sort(), ['good/model', 'output/only'])
  assert.equal(clean['good/model'].cacheMiss, 10)
})

test('a costed call stops being zero once its model is in the table', () => {
  // 端到端地把「索引 → 计价」串起来，对应 fork 前恒为 0 的场景：
  // 记录里 provider 是 codex（非 DeepSeek），模型名是 gpt-6-astra。
  const { table } = openRouterTable({
    data: [{ id: 'openai/gpt-6-astra', pricing: { prompt: '0.00001', completion: '0.00005', input_cache_read: '0.0000025' } }]
  })
  const prices = sanitizeTable(table)
  const index = buildPriceIndex(Object.keys(prices), {})
  const key = resolveModelKey('gpt-6-astra', index)
  assert.equal(key, 'openai/gpt-6-astra')
  const cost = computeCost({ cacheReadTokens: 400000, inputTokens: 100000, outputTokens: 20000 }, prices[key])
  // 0.4M*2.5 + 0.1M*10 + 0.02M*50 = 1 + 1 + 1 = 3
  assert.equal(Number(cost.toFixed(6)), 3)
})
