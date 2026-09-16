import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 会话排行那一列到底显示什么、能不能点，全由 sessionRowView 一个纯函数决定。
// 组件本身测不了：本仓的假 React 让 createElement 返回 null，渲染不出东西来。
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

test('a session the host list knows shows its name and becomes clickable', async () => {
  const exports = await loadClient()
  exports.__i18n.setLang('zh')
  const r = exports.__sessionRow.view('session-abc', { displayTitle: '修复登录流程' }, true)
  assert.equal(r.label, '修复登录流程')
  assert.equal(r.linkable, true)
  // title 里要能同时看到完整名字和原始 id：名字被截断时靠它核对，id 用来对日志
  assert.match(r.hint, /修复登录流程/)
  assert.match(r.hint, /session-abc/)
  assert.match(r.hint, /点击跳转/)
})

test('a name with no opener stays plain text', async () => {
  const exports = await loadClient()
  exports.__i18n.setLang('zh')
  const r = exports.__sessionRow.view('session-abc', { displayTitle: '修复登录流程' }, false)
  assert.equal(r.label, '修复登录流程')
  assert.equal(r.linkable, false)
  assert.doesNotMatch(r.hint, /点击跳转/)
})

test('a session missing from the host list falls back to its id', async () => {
  const exports = await loadClient()
  exports.__i18n.setLang('zh')
  // 用量记录里有一批裸 UUID，host 列表里没有对应会话 —— sessions.open() 对它们会抛错，
  // 所以必须退成不可点的纯文本，而不是留一个点了没反应的假链接
  const r = exports.__sessionRow.view('00436b47-cacf-4406-9773-ee8bcca7a7ba', null, true)
  assert.equal(r.linkable, false)
  assert.equal(r.label.length, exports.__sessionRow.LABEL_MAX + 1)
  assert.ok(r.label.startsWith('00436b47-cacf-4406-9773'))
  assert.ok(r.label.endsWith('…'))
  assert.equal(r.hint, '00436b47-cacf-4406-9773-ee8bcca7a7ba')
})

test('an empty displayTitle falls back to the id', async () => {
  const exports = await loadClient()
  const r = exports.__sessionRow.view('session-abc', { displayTitle: '' }, true)
  assert.equal(r.label, 'session-abc')
  assert.equal(r.linkable, false)
})

test('a name at the limit is not truncated', async () => {
  const exports = await loadClient()
  const name = 'x'.repeat(exports.__sessionRow.LABEL_MAX)
  const r = exports.__sessionRow.view('s', { displayTitle: name }, true)
  assert.equal(r.label, name)
  assert.ok(!r.label.endsWith('…'))
})

test('a missing sid does not throw', async () => {
  const exports = await loadClient()
  const r = exports.__sessionRow.view(undefined, null, true)
  assert.equal(r.linkable, false)
  assert.equal(typeof r.label, 'string')
})
