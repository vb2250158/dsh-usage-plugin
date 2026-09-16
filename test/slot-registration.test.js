import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// apply() 到底往哪些 slot 注册了入口，是「余额查询面板关掉没有」的唯一真实证据——
// 只看源码里的开关常量会漏掉注册点。所以这里用假 ctx 真跑一遍 apply 并收集结果。
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
  const url = pathToFileURL(CLIENT).href + '?mount=' + (++mounts)
  await import(url)
  if (!captured) throw new Error('ModuleLoader.load was not called')
  return captured.factory(fakeRequire)
}

/** 用一个只记账的假 slots 跑 apply，返回它注册的条目（形如 `slot:id`）。 */
function collectRegistrations(exports) {
  const entries = []
  const slots = {
    inject(_name, callback) { callback() },
    register(options) {
      entries.push(options.name + ':' + (options.id === undefined ? '' : options.id))
      return () => {}
    }
  }
  const ctx = {
    // timer / locale / sessions 一律缺席：注册路径不应该依赖它们
    get(name) { return name === 'slots' ? slots : undefined },
    on() {}
  }
  exports.apply(ctx)
  return entries
}

test('the balance panel registers nothing while its switch is off', async () => {
  const exports = await loadClient()
  assert.equal(exports.__slots.balancePanelEnabled, false,
    '本机构建应关闭余额查询；若有意改回 true，请一并更新本用例')
  const entries = collectRegistrations(exports)
  assert.deepEqual(entries.filter(e => e.includes('balance')), [],
    '余额面板的两个入口（conversation.view:balance-view 与 settings.section:balance）都不应注册')
})

test('the three usage entries still register, in order', async () => {
  const exports = await loadClient()
  assert.deepEqual(collectRegistrations(exports), [
    'conversation.view:usage-cost-view',
    'settings.section:usage-cost',
    'conversation.chat.assistant-actions:usage-token'
  ])
})
