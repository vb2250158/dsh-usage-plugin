import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 消息底部胶囊要显示的是「本轮」，而本轮时间窗只能从 ChatSnapshot 里取：
// turn-tail 节点的 closing.finalNode 给出消息完成时间与所在步骤起点，
// timeline.turns 给出整轮起点。这里锁三件事——字段从哪来、拿不到时怎么退化，
// 以及绝不允许再把「整场对话累计」当成本轮（0/0 窗口会让宿主跳过时间过滤，
// 于是胶囊显示会话总量，正是这次修掉的 bug）。
//
// 组件本身测不了：本仓的假 React 让 createElement 返回 null，渲染不出东西来，
// 所以被覆盖的是组件调用的两个纯函数。
const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'lib', 'client.js')
let mounts = 0

const fakeRequire = n => {
  if (n === 'react') return { createElement: () => null }
  throw new Error('unexpected require: ' + n)
}

async function loadClient() {
  globalThis.window = {
    __ModuleLoader__: null,
    localStorage: {
      _d: Object.create(null),
      getItem(k) { return k in this._d ? this._d[k] : null },
      setItem(k, v) { this._d[k] = String(v) }
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' }, configurable: true, writable: true
  })
  let captured = null
  window.__ModuleLoader__ = { load(d) { captured = d } }
  // 唯一查询串强制重新求值，避免用例之间共享模块状态
  const url = pathToFileURL(CLIENT).href + '?mount=' + (++mounts)
  await import(url)
  if (!captured) throw new Error('ModuleLoader.load was not called')
  return captured.factory(fakeRequire)
}

// 合成数据：一轮从 T0 开始，161 秒后收尾，最后一步在 158 秒处起跑。
const T0 = 1700000000000
const MSG = T0 + 161000
const STEP = T0 + 158000

function chatSnapshot({ messageId = 'msg-1', turn = 7, timeline = true } = {}) {
  const snap = {
    nodes: {
      values: () => [{
        data: {
          turn,
          closing: { finalNode: { messageId, time: MSG, timing: { stepStartTime: STEP } } }
        }
      }]
    },
    timeline: { turns: new Map([[turn, { start: { time: T0 }, end: { time: MSG } }]]) }
  }
  if (!timeline) delete snap.timeline
  return snap
}

test('the three readings come off the closing node and the turn timeline', async () => {
  const { __turnWindow: w } = await loadClient()
  const snap = chatSnapshot()
  assert.equal(w.field(snap, 'msg-1', 'time'), MSG)
  assert.equal(w.field(snap, 'msg-1', 'step'), STEP)
  assert.equal(w.field(snap, 'msg-1', 'turnStart'), T0)
})

test('another message in the same window does not answer for this one', async () => {
  const { __turnWindow: w } = await loadClient()
  const snap = chatSnapshot({ messageId: 'msg-1' })
  assert.equal(w.field(snap, 'msg-2', 'time'), 0)
  assert.equal(w.field(snap, 'msg-2', 'turnStart'), 0)
})

test('a snapshot without a timeline still yields the message times', async () => {
  const { __turnWindow: w } = await loadClient()
  const snap = chatSnapshot({ timeline: false })
  assert.equal(w.field(snap, 'msg-1', 'time'), MSG)
  assert.equal(w.field(snap, 'msg-1', 'step'), STEP)
  // 整轮起点缺席不是错误，只是没有更宽的窗口可用
  assert.equal(w.field(snap, 'msg-1', 'turnStart'), 0)
})

test('a session snapshot (no chat/ nodes) answers nothing, never the whole log', async () => {
  const { __turnWindow: w } = await loadClient()
  // 旧实现读的是 SessionSnapshot.chat，而该字段并不存在——这正是窗口恒为
  // 0/0、胶囊显示整场累计的原因。这条用例把它钉住。
  const sessionSnapshot = { sessionId: 's-1', queue: [], running: false }
  assert.equal(w.field(sessionSnapshot, 'msg-1', 'time'), 0)
  assert.equal(w.field(sessionSnapshot, 'msg-1', 'turnStart'), 0)
})

test('the window prefers the whole turn, then the step, then five minutes', async () => {
  const { __turnWindow: w } = await loadClient()
  assert.deepEqual(w.from(MSG, STEP, T0), { from: T0, to: MSG, ok: true })
  assert.deepEqual(w.from(MSG, STEP, 0), { from: STEP, to: MSG, ok: true })
  assert.deepEqual(w.from(MSG, 0, 0), { from: MSG - 300000, to: MSG, ok: true })
})

test('no time at all is "no window", not an unfiltered query', async () => {
  const { __turnWindow: w } = await loadClient()
  // ok=false 才会让调用方跳过请求；给出 from=0/to=0 等于让宿主返回整场累计，
  // 那正是胶囊把 886M 会话总量显示成「本轮」的路径。
  assert.deepEqual(w.from(0, 0, 0), { from: 0, to: 0, ok: false })
})

test('a turn start later than the message is rejected instead of queried', async () => {
  const { __turnWindow: w } = await loadClient()
  assert.equal(w.from(MSG, STEP, MSG + 1000).ok, false)
})
