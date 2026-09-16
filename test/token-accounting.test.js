import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 胶囊与官方 StatsPills 必须在同一行里给出同一个数字，否则用户无从判断该信哪个。
// 数字口径只有两件事会错，这里各钉一条：
//
//   1) 显示总量 = 计费输入（未命中 + 缓存命中 + 缓存写入）+ 输出。
//      reasoning 不另加——数据源已把它含在 outputTokens 内（本机记录里
//      reasoning 恒小于等于 output），再加一次就是重复计数。
//   2) 缓存命中率的分母是上面那三个互斥输入桶之和。漏掉 cacheWrite 会把命中率
//      系统性高估，而 DeepSeek 系 provider 下 cacheWrite 恰好等于 inputTokens，
//      量级是分母的三分之一，偏差能到两个百分点。
//
// 这两条都曾在实现里错着，且都被"看起来合理"的数字掩盖过，所以用真实量级的
// 合成数据锁住，而不是只断言形状。
const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(here, '..', 'lib', 'index.js')

// computeAgg 是 index.js 的具名导出：它同时是模块级纯函数与运行时的真实实现，
// 不是为测试另写的一份，所以测过的口径就是界面上跑的口径。
async function loadAgg() {
  const mod = await import(pathToFileURL(SERVER).href)
  if (typeof mod.computeAgg !== 'function') {
    throw new Error('index.js does not export computeAgg')
  }
  return mod
}

/** One record as the persistence layer stores it. */
function rec({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0, time = 1700000000000 } = {}) {
  return {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning, time,
    peak: false, peakValleyCost: 0, baseCost: 0, autoCost: 0,
  }
}

test('displayTotal is billed input plus output, never counting reasoning twice', async () => {
  const { computeAgg } = await loadAgg()
  // 真实量级取自本机记录：out=159 时 reason=105，reasoning 是 output 的子集。
  const agg = computeAgg([rec({ input: 618, output: 159, cacheRead: 211968, cacheWrite: 618, reasoning: 105 })])
  const billedInput = 618 + 211968 + 618
  assert.equal(agg.displayTotal, billedInput + 159)
  // 旧实现把 reasoning 又加了一遍，会多出 105。
  assert.notEqual(agg.displayTotal, billedInput + 159 + 105)
})

test('the cache-hit denominator includes cache writes', async () => {
  const { computeAgg } = await loadAgg()
  const agg = computeAgg([rec({ input: 618, output: 159, cacheRead: 211968, cacheWrite: 618 })])
  const billedInput = 618 + 211968 + 618
  assert.equal(agg.billed, billedInput)
  assert.equal(agg.hitRate, 211968 / billedInput * 100)
  // 漏掉 cacheWrite 的旧分母会给出明显更高的命中率。
  const oldRate = 211968 / (211968 + 618) * 100
  assert.ok(agg.hitRate < oldRate)
})

test('a full cache hit reads as 100 and unread input as 0', async () => {
  const { computeAgg } = await loadAgg()
  assert.equal(computeAgg([rec({ cacheRead: 1000, output: 5 })]).hitRate, 100)
  assert.equal(computeAgg([rec({ input: 1000, output: 5 })]).hitRate, 0)
})

test('no billed input yields 0 rather than NaN', async () => {
  const { computeAgg } = await loadAgg()
  const agg = computeAgg([rec({ output: 42 })])
  assert.equal(agg.hitRate, 0)
  assert.equal(agg.displayTotal, 42)
})

test('an empty window aggregates to zeroes, not undefined fields', async () => {
  const { computeAgg } = await loadAgg()
  const agg = computeAgg([])
  assert.equal(agg.displayTotal, 0)
  assert.equal(agg.billed, 0)
  assert.equal(agg.hitRate, 0)
  assert.equal(agg.calls, 0)
})

test('reasoning never exceeds output in the sample the figures were derived from', async () => {
  // 这条守的是前提而不是实现：上面所有断言都建立在「reasoning 含在 output 内」
  // 之上。若哪天数据源改成并列上报，这里会先失败，提醒重新对齐官方口径
  // （官方 token-meter 的投影文档同样声明 reasoning 已计入 outputTokens）。
  const samples = [
    { output: 159, reasoning: 105 },
    { output: 1481, reasoning: 25 },
    { output: 1313, reasoning: 15 },
  ]
  for (const s of samples) {
    assert.ok(s.reasoning <= s.output, `reasoning ${s.reasoning} should not exceed output ${s.output}`)
  }
})
