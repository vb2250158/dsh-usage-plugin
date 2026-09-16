import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 弹窗渲染冒烟测。
//
// 起因：这段渲染逻辑原本是组件内的闭包族，`turnStats()` 里引用了 `msgTime` /
// `stepStart` 两个只存在于 `turnWindowFrom()` 形参表里的名字，并不在本作用域。
// 这不是类型错误，lint 也拦不住 —— JS 到运行时才炸，而且只在「有数据 + 展开弹窗」
// 这条路上炸。真机上表现为整个弹窗空白 + 控制台一条 ReferenceError，用户只看到
// 「点了没反应」。
//
// 现在渲染逻辑提成了模块级纯函数 renderTokenPanel(view)，依赖全部显式列在 view 上，
// 于是可以脱离 React 直接喂一个 view 渲染到底 —— 这条路径一旦再引入未定义引用，
// 这里必然抛错。
const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'lib', 'client.js')
let mounts = 0

async function loadClient() {
  const storage = { _d: Object.create(null), getItem() { return null }, setItem() {} }
  globalThis.window = { __ModuleLoader__: null, localStorage: storage }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true })
  let captured = null
  window.__ModuleLoader__ = { load(d) { captured = d } }
  const url = pathToFileURL(CLIENT).href + '?smoke=' + (++mounts)
  await import(url)
  const el = function (type, props, ...children) {
    return { type, props: props || {}, children: children.filter(c => c !== null && c !== undefined && c !== false) }
  }
  const react = {
    createElement: el,
    useState: v => [typeof v === 'function' ? v() : v, () => {}],
    useEffect() {}, useMemo: fn => fn(), useRef: v => ({ current: v }), useCallback: fn => fn,
  }
  const exports = captured.factory(n => {
    if (n === 'react') return react
    throw new Error('unexpected require: ' + n)
  })
  return { exports, el }
}

/** 与本机真实记录同量级的一轮数据。 */
function view(overrides) {
  const agg = {
    calls: 3, input: 618, output: 159, cacheRead: 211968, cacheWrite: 618, reasoning: 105,
    peakCost: 0, offCost: 0, baseCost: 0, totalCost: 0.42,
    hitRate: 211968 / (618 + 211968 + 618) * 100,
    billed: 618 + 211968 + 618, displayTotal: 618 + 211968 + 618 + 159,
    time: { start: 1700000000000, end: 1700000060000 },
  }
  const convo = {
    calls: 9, totalCost: 1.5, hitRate: 96.1, displayTotal: 5_000_000,
    time: { start: 1699999000000, end: 1700000060000 },
  }
  const recs = [
    { model: 'deepseek-v4', modelKey: 'deepseek-v4', inputTokens: 618, outputTokens: 159, cacheReadTokens: 211968, cacheWriteTokens: 618, reasoningTokens: 105, peak: false, autoCost: 0.42, time: 1700000000000 },
    { model: 'gpt-6-astra', modelKey: 'gpt-6-astra', inputTokens: 74, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, peak: true, autoCost: 0.08, time: 1700000030000 },
  ]
  const modelRows = [
    { model: 'deepseek-v4', calls: 1, input: 618, cacheRead: 211968, cacheWrite: 618, output: 159, reasoning: 105, peakCost: 0, offCost: 0.42, totalCost: 0.42 },
    { model: 'gpt-6-astra', calls: 1, input: 74, cacheRead: 0, cacheWrite: 0, output: 11, reasoning: 0, peakCost: 0.08, offCost: 0, totalCost: 0.08 },
  ]
  return Object.assign({
    status: 'done', convo, agg2: agg, recs, modelRows,
    convoTokens: convo.displayTotal, turnTokens: agg.displayTotal,
    stepStart: 1699999900000, hasWindow: true, winTo: 1700000060000,
  }, overrides)
}

/** 把渲染出的树拍平成文本，便于断言「用户能看到什么」。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) textOf(c, out); return out }
  if (node.children) for (const c of node.children) textOf(c, out)
  return out
}

test('the expanded panel renders end to end (regression: msgTime / stepStart scope error)', async () => {
  const { exports } = await loadClient()
  assert.equal(typeof exports.__renderTokenPanel, 'function', 'client.js must export __renderTokenPanel')
  let tree
  try {
    tree = exports.__renderTokenPanel(view())
  } catch (e) {
    assert.fail('renderTokenPanel threw: ' + (e && e.stack || e))
  }
  assert.ok(tree, 'render produced nothing')
  const text = textOf(tree).join(' | ')
  // 两段标题都在，且顺序是「本轮」在前 —— 顺序即语义。
  assert.match(text, /本轮明细/)
  assert.match(text, /本会话累计/)
  assert.ok(text.indexOf('本轮明细') < text.indexOf('本会话累计'), 'the turn section must come first')
  // 过时措辞不得复现。
  assert.doesNotMatch(text, /对话累计/)
})

test('the panel prints the billed total, not billed-plus-reasoning', async () => {
  const { exports } = await loadClient()
  const v = view()
  const text = textOf(exports.__renderTokenPanel(v)).join(' | ')
  // 本轮 token 是 displayTotal（计费输入 + 输出）= 213,363 → 官方压缩格式取整为 213K。
  // 若 reasoning 被重复计入会得到 213,468，压缩后同样是 213K —— 所以这里同时钉精确值：
  // title 属性上挂着千分位原值，两个数一起对才排得掉「凑巧撞上」。
  assert.match(text, /本轮 token[\s\S]*?213K tok/, 'turn total should print the billed figure, got: ' + text)
  const tree = exports.__renderTokenPanel(v)
  const titles = []
  const walk = n => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props && n.props.title) titles.push(n.props.title)
    if (n.children) n.children.forEach(walk)
  }
  walk(tree)
  assert.ok(titles.includes('213,363'), 'exact billed total 213,363 should be on a title attribute, got: ' + JSON.stringify(titles))
  assert.ok(!titles.includes('213,468'), 'billed total must not include reasoning')
})

test('every non-ready status renders a message instead of throwing', async () => {
  const { exports } = await loadClient()
  const cases = [
    ['loading', /获取中/],
    ['error', /查询失败/],
    ['nowindow', /本轮时间窗不可用/],
  ]
  for (const [status, re] of cases) {
    const text = textOf(exports.__renderTokenPanel(view({ status }))).join(' | ')
    assert.match(text, re, status + ' should render its own message')
  }
  // idle：既无 convo 也无 agg → 「无 Token 数据」
  const idle = textOf(exports.__renderTokenPanel(view({ status: 'idle', convo: null, agg2: null, recs: [], modelRows: [] }))).join(' | ')
  assert.match(idle, /无 Token 数据/)
})

test('a zero-usage turn says so instead of printing an empty panel', async () => {
  const { exports } = await loadClient()
  const zeroAgg = {
    calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    totalCost: 0, hitRate: 0, billed: 0, displayTotal: 0,
    time: { start: 0, end: 0 },
  }
  const text = textOf(exports.__renderTokenPanel(view({ convo: null, agg2: zeroAgg, recs: [], modelRows: [], turnTokens: 0 }))).join(' | ')
  assert.match(text, /本期无消耗/)
})

test('a missing turn window still renders the panel with no span, not a crash', async () => {
  const { exports } = await loadClient()
  // hasWindow=false 且 stepStart=0：耗时回退到记录自身的起止，不得抛错
  const text = textOf(exports.__renderTokenPanel(view({ hasWindow: false, stepStart: 0, winTo: 0 }))).join(' | ')
  assert.match(text, /本轮明细/)
  assert.match(text, /本轮耗时/)
})
