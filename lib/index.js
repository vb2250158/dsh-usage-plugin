/**
 * dsh-usage-plugin — HOST half.
 *
 * Permanent Cordis plugin for a DeepSeek Harness web/desktop profile:
 *  - listens to `llm/stream`, records every model call's token usage,
 *    cache-hit/miss counts and finish reason;
 *  - persists records to a FIXED dedicated data directory (see resolveDataRoot),
 *  - serves a JSON API at `POST /usage/api` for the client half.
 *
 * The apply body is instrumented: every step is appended to a diagnostics
 * buffer and flushed to `dsh-usage-boot.log` (resolved relative to the fs
 * provider cwd) so activation failures are visible without app logs.
 *
 * Cross-platform note: path handling uses node:path (join / dirname) with the
 * host platform's separator, so the plugin works on Windows, macOS and Linux.
 */
import path from 'node:path'
import os from 'node:os'
import { promises as fsp, existsSync } from 'node:fs'
import {
  getBalanceProvider,
  matchesModelProvider,
  parseBalanceResponse,
  providerList,
  missingCredentialError,
  resolveBalanceEndpoint
} from './balance.js'
import {
  buildPriceIndex,
  computeCost,
  openRouterTable,
  resolveModelKey,
  sanitizeTable
} from './pricing.js'

// 周末统一按空闲价计费规则生效时间：北京时间 2026-08-23 00:00（周日）。
// 生效前（含周末）仍按原峰谷分段计费；生效后周末（周六、周日）全天统一按空闲价，工作日仍按峰谷分段。
export const WEEKEND_FLAT_AT = Date.parse('2026-08-23T00:00:00+08:00')

// 高峰时段判定：新规则（2026-08-23 起）周末（周六、周日）全天不再区分峰谷，统一按空闲价；
// 工作日仍按北京时间 9:00–12:00、14:00–18:00 为高峰；新规则生效前的调用仍按原规则判定。
// 星期取自平移后的北京时间（ts + 8h），避免 UTC 日历与北京日历在 16:00–24:00 UTC 段错位。
// 导出为独立函数，供 test/period.test.js 做回归测试（issue #9）。
export function isPeakAt(ts) {
  const d = new Date(ts + 8 * 3600 * 1000)
  const wd = d.getUTCDay() // 0=周日 1=周一 … 6=周六
  if (ts >= WEEKEND_FLAT_AT && (wd === 0 || wd === 6)) return false
  const t = d.getUTCHours() * 60 + d.getUTCMinutes()
  return (t >= 9 * 60 && t < 12 * 60) || (t >= 14 * 60 && t < 18 * 60)
}

export default {
  inject: ['fs', 'webServer', 'subprocess', 'credentials', 'settings', 'sandboxPolicy', 'agents'],
  apply(ctx) {
    const diag = { ok: true, steps: [], error: null }
    const push = (s) => { try { diag.steps.push(String(s)) } catch (e) {} }
    const flushDiag = () => {
      try {
        const fs = ctx.get('fs')
        if (fs && typeof fs.resolve === 'function' && typeof fs.writeText === 'function') {
          fs.resolve('dsh-usage-boot.log')
            .then((target) => fs.writeText(target, JSON.stringify({ time: Date.now(), ...diag }, null, 2)))
            .catch(() => {})
        }
      } catch (e) {}
    }
    try {
      push('apply-start')

      const records = []
      const MAX_RECORDS = 100000

      // ── 通用模型价格表 ──────────────────────────────────────────────────
      // 价格由 OpenRouter 的公开目录端点填充（见 syncPrices），键是模型 id（小写），
      // 值是「每 100 万 token」的单价，字段与 OpenRouter 一一对应：
      //   cacheHit  缓存命中的输入单价  ← pricing.input_cache_read
      //   cacheMiss 未命中的输入单价    ← pricing.prompt
      //   output    输出单价            ← pricing.completion
      //
      // base / peakValley 两档保留是为了兼容既有 UI、API 与持久化文件：两档写入
      // 同一个平价，于是「高峰 / 空闲」退化为按北京时间对花费做时间分档，不再表示
      // 供应商的峰谷定价差异——OpenRouter 目录里没有按时段变价的模型。
      const PRICING = { base: {}, peakValley: {} }
      let DEFAULT_PRICING = { base: {}, peakValley: {} }
      let PRICE_MODELS = []
      // 模型名 → 价格表 key 的查找索引，由 rebuildPriceIndex() 维护。
      let priceIndex = {}
      let priceMeta = { source: '', syncedAt: 0, count: 0, error: '' }
      // 价格表与展示金额的货币。OpenRouter 以美元计价，故默认 USD。
      let currency = 'USD'
      // 别名表：记录里出现的模型名 → 价格表 id。用于 route 名与供应商型号名不一致
      // 的情况（如 codex 通道把 gpt-6-astra 报成别的名字）。可通过 setAliases 增补。
      const ALIASES = {
        'gpt-6-astra': 'openai/gpt-6-astra',
        'gpt-6-astra-pro': 'openai/gpt-6-astra-pro'
      }
      let FX = { rate: 0, inverse: 0, date: '', queriedAt: 0, source: 'Frankfurter', stale: false, error: '' }
      // 保留导出的常量与开关以兼容既有客户端与测试；价格表已不再按时间切换档位。
      const EFFECTIVE_AT = 0

      // 高峰/空闲判定使用模块级 isPeakAt（含周末规则与生效时间保护；实现见文件顶部导出，供回归测试）
      const isPeak = isPeakAt

      // 匹配与计价规则都在 ./pricing.js（纯逻辑，可独立测试）；这里只维护状态。
      function rebuildPriceIndex() {
        priceIndex = buildPriceIndex(Object.keys(PRICING.peakValley), ALIASES)
      }

      // 解析一条记录里的模型名到价格表 key；解析不到返回 ''（费用按 0，不猜测，
      // 也不拿相似型号的价格顶替）。
      function modelKey(model) {
        return resolveModelKey(model, priceIndex)
      }

      // 用一张 { id: {cacheHit, cacheMiss, output} } 平价表合并进当前价格表。
      // 非法条目（负数 / 非数字 / 全零）跳过，返回实际写入的条目数。
      // PRICE_MODELS 始终从整表重建，避免局部更新后模型列表与表内容不一致。
      function applyFlatPrices(table) {
        const clean = sanitizeTable(table)
        const ids = Object.keys(clean)
        for (const id of ids) {
          const entry = clean[id]
          PRICING.base[id] = entry
          PRICING.peakValley[id] = { offPeak: entry, peak: entry }
        }
        if (ids.length) {
          PRICE_MODELS = Object.keys(PRICING.peakValley)
          rebuildPriceIndex()
        }
        return ids.length
      }

      // 整表替换：清掉旧键后载入新表。resetPrices 用它回到最近一次同步的快照。
      function replaceFlatPrices(table) {
        for (const id of Object.keys(PRICING.peakValley)) {
          delete PRICING.base[id]
          delete PRICING.peakValley[id]
        }
        PRICE_MODELS = []
        priceIndex = {}
        return applyFlatPrices(table)
      }

      // Third-party providers are priced only when a verified provider/model
      // mapping exists. Unknown mappings deliberately remain zero rather than
      // inheriting DeepSeek prices from a similar model name.
      // 按价格表计算一次调用的费用。provider 不参与判定：价格表以模型 id 为键，
      // 同一模型换通道价格相同。表中查不到即费用为 0，这是刻意的——宁可显示 0
      // 让人看见缺口，也不要拿相似型号的价格冒充（旧实现按 provider 白名单归零，
      // 导致非 DeepSeek 通道即使有公开价格也一律计 0）。
      //
      // 三个 token 计数互斥：cacheReadTokens 是命中缓存的输入，inputTokens 是未命中
      // 的输入，两者相加才是计费输入，因此各乘自己的单价。cacheWriteTokens 没有独立
      // 单价（OpenRouter 目录不提供），不计费。
      function costFor(rec, regime) {
        const mk = modelKey(rec.model)
        if (!mk) return 0
        if (regime === 'base') {
          const p = PRICING.base[mk]
          return p ? computeCost(rec, p) : 0
        }
        const pv = PRICING.peakValley[mk]
        if (!pv) return 0
        // 两档同价（见 PRICING 注释）：保留时间分档只为沿用既有的高峰 / 空闲花费拆分。
        return computeCost(rec, isPeak(rec.time) ? pv.peak : pv.offPeak)
      }

      // 过滤内部/占位调用（如 harness 内部 dsh2shell-* + model "fake"）：
      // 这些不是用户调用的 API 服务商，不出现在用量明细 / 消耗明细 / 日历统计里。
      function isRealCall(rec) {
        const model = String(rec.model || '').trim().toLowerCase()
        const provider = String(rec.provider || '').trim().toLowerCase()
        if (!model || model === 'fake' || model === 'unknown') return false
        if (!provider || provider === 'unknown') return false
        // 内部 agent/工具路由（dsh2shell-* 等）不计入用户可见明细
        if (provider.indexOf('dsh') === 0) return false
        return true
      }

      // 把一条记录投影为 API 响应形状（供 list / tokenForMessage 共用，含成本与峰谷判定）。
      function projectRecord(r) {
        return {
          time: r.time, model: r.model, provider: r.provider, purpose: r.purpose, sessionId: r.sessionId || '',
          inputTokens: r.inputTokens, outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens,
          reasoningTokens: r.reasoningTokens, finishReason: r.finishReason,
          interrupted: !!r.interrupted,
          usdCnyRate: r.usdCnyRate || 0, fxDate: r.fxDate || '',
          modelKey: modelKey(r.model),
          baseCost: costFor(r, 'base'), peakValleyCost: costFor(r, 'peakValley'), autoCost: costFor(r, 'auto'),
          peak: isPeak(r.time)
        }
      }

      // 对已投影的记录做聚合（对话累计 / 本轮明细共用）。
      function computeAgg(items) {
        const agg = { calls: items.length, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, peakCost: 0, offCost: 0, baseCost: 0, totalCost: 0, hitRate: 0 }
        let firstTime = 0, lastTime = 0
        for (const it of items) {
          agg.input += it.inputTokens; agg.output += it.outputTokens
          agg.cacheRead += it.cacheReadTokens; agg.cacheWrite += it.cacheWriteTokens
          agg.reasoning += it.reasoningTokens
          if (it.peak) agg.peakCost += it.peakValleyCost; else agg.offCost += it.peakValleyCost
          agg.baseCost += it.baseCost; agg.totalCost += it.autoCost
          if (!firstTime || it.time < firstTime) firstTime = it.time
          if (it.time > lastTime) lastTime = it.time
        }
        const denom = agg.cacheRead + agg.input
        agg.hitRate = denom > 0 ? (agg.cacheRead / denom * 100) : 0
        agg.time = { start: firstTime, end: lastTime }
        return agg
      }

      const msg = (e) => String((e && e.message) || e)
      const fail = (message) => ({ ok: false, error: message })
      const pad2 = (n) => (n < 10 ? '0' : '') + n
      const fmtInt = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      const fmtTime = (ts) => {
        const d = new Date(ts + 8 * 3600 * 1000)
        return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
      }
      const fmtMoney = (n) => {
        if (!n) return '0.0000'
        if (n < 0.0001) return n.toExponential(2)
        if (n < 1) return n.toFixed(4)
        return n.toFixed(2)
      }
      const IS_WIN = typeof process !== 'undefined' && process.platform === 'win32'
      const IS_MAC = typeof process !== 'undefined' && process.platform === 'darwin'
      const normPath = (p) => {
        const s = String(p == null ? '' : p)
        return IS_WIN ? s.replace(/\//g, '\\') : s
      }
      const joinPath = (...parts) => path.join(...parts.map((p) => String(p == null ? '' : p)))
      // 插件自身持久化统一走宿主进程的 node:fs（不经 ctx.fs 沙箱），
      // 因此可稳定写入工作区之外的系统目录，切换工作区也不会丢失历史。
      const nfsWriteText = async (filePath, content) => {
        await fsp.mkdir(path.dirname(filePath), { recursive: true })
        await fsp.writeFile(filePath, content, 'utf8')
      }
      const nfsReadText = async (filePath) => fsp.readFile(filePath, 'utf8')
      const nfsExists = (filePath) => { try { return existsSync(filePath) } catch (e) { return false } }
      const stamp = () => {
        const d = new Date()
        return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
      }

      function bjKey(ts) {
        const d = new Date(Number(ts) + 8 * 3600 * 1000)
        return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
      }

      function buildDays() {
        const map = {}
        for (const r of records) {
          if (!isRealCall(r)) continue;
          const key = bjKey(r.time)
          let d = map[key]
          if (!d) {
            d = {
              day: key, calls: 0, miss: 0, hit: 0, write: 0, out: 0, reason: 0,
              peakCalls: 0, offPeakCalls: 0, baseCost: 0, peakValleyCost: 0, autoCost: 0,
              basePeakCost: 0, baseOffPeakCost: 0,
              pvPeakCost: 0, pvOffPeakCost: 0,
              autoPeakCost: 0, autoOffPeakCost: 0
            }
            map[key] = d
          }
          d.calls++
          d.miss += r.inputTokens || 0
          d.hit += r.cacheReadTokens || 0
          d.write += r.cacheWriteTokens || 0
          d.out += r.outputTokens || 0
          d.reason += r.reasoningTokens || 0
          const cBase = costFor(r, 'base')
          const cPv = costFor(r, 'peakValley')
          const cAuto = costFor(r, 'auto')
          if (isPeak(r.time)) {
            d.peakCalls++
            d.basePeakCost += cBase
            d.pvPeakCost += cPv
            d.autoPeakCost += cAuto
          } else {
            d.offPeakCalls++
            d.baseOffPeakCost += cBase
            d.pvOffPeakCost += cPv
            d.autoOffPeakCost += cAuto
          }
          d.baseCost += cBase
          d.peakValleyCost += cPv
          d.autoCost += cAuto
        }
        const days = []
        for (const k in map) days.push(map[k])
        days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
        return days
      }

      const fs = ctx.get('fs')
      push('fs=' + (fs ? 'present' : 'undefined'))
      let root = ''
      let dataPath = ''
      let pricingPath = ''
      let budgetPath = ''
      let budget = null // { monthly: number|null } — 月度预算（元），null 表示未设置
      let persistOk = false
      let persistError = ''
      let initPromise = null
      let writeChain = Promise.resolve()
      let cachedPolicy = null

      const dirs = () => ({
        data: joinPath(root, 'dsh-usage'),
        csv: joinPath(root, 'dsh-usage', 'csv'),
        json: joinPath(root, 'dsh-usage', 'json'),
        images: joinPath(root, 'dsh-usage', 'images')
      })

      function currentAgent() {
        try {
          const agents = ctx.get('agents')
          if (agents && typeof agents.currentInitiator === 'function') return agents.currentInitiator()
        } catch (e) {}
        return undefined
      }

      function sessionPolicy() {
        if (cachedPolicy) return cachedPolicy
        try {
          const agent = currentAgent()
          const sp = ctx.get('sandboxPolicy')
          if (sp && typeof sp.resolve === 'function' && agent && agent.session) {
            const policy = sp.resolve({ session: agent.session })
            if (policy && policy.workspaceRoot) {
              cachedPolicy = policy
              return policy
            }
          }
        } catch (e) {}
        return undefined
      }

      // SSE 实时推送：数据变化（新记录写入 / 导入 / 清除等）时通知订阅者。
      // 订阅端点 /usage/api/events。无订阅者时是 no-op，插件独立使用不受影响。
      const sseClients = new Set()
      function notifyChanged() {
        if (sseClients.size === 0) return
        const payload = 'data: {"type":"changed","at":' + Date.now() + '}\n\n'
        for (const res of sseClients) {
          try { res.write(payload) } catch (e) { sseClients.delete(res) }
        }
      }

      function persistNow() {
        if (!dataPath || !persistOk) return Promise.resolve()
        const text = JSON.stringify(records)
        writeChain = writeChain.then(() => nfsWriteText(dataPath, text)).then(() => { notifyChanged() }).catch(() => {})
        return writeChain
      }

      function persistPricing() {
        if (!pricingPath || !persistOk) return Promise.resolve()
        const doc = { base: PRICING.base, peakValley: PRICING.peakValley, currency, meta: priceMeta, aliases: ALIASES }
        return nfsWriteText(pricingPath, JSON.stringify(doc)).catch(() => {})
      }

      function persistBudget() {
        if (!budgetPath || !persistOk) return Promise.resolve()
        return nfsWriteText(budgetPath, JSON.stringify(budget)).catch(() => {})
      }

      async function loadBudget() {
        if (!budgetPath) return
        try {
          const data = JSON.parse(await nfsReadText(budgetPath))
          if (!data || typeof data !== 'object') return
          const m = Number(data.monthly)
          budget = { monthly: Number.isFinite(m) && m >= 0 ? m : null }
        } catch (e) {}
      }

      async function loadPricing() {
        if (!pricingPath) return
        try {
          const data = JSON.parse(await nfsReadText(pricingPath))
          if (!data || typeof data !== 'object') return
          // 价格表键是任意的模型 id，不能再按固定模型列表读取。优先取 base 档
          // （平价表的规范存放处），缺失时退回 peakValley 的空闲档，以兼容
          // 早期只写了 peakValley 的文件。
          const flat = {}
          for (const [id, row] of Object.entries(data.base || {})) {
            if (row && typeof row === 'object') flat[id] = row
          }
          for (const [id, pv] of Object.entries(data.peakValley || {})) {
            if (flat[id]) continue
            const row = pv && typeof pv === 'object' ? (pv.offPeak || pv.peak) : null
            if (row && typeof row === 'object') flat[id] = row
          }
          if (Object.keys(flat).length) {
            replaceFlatPrices(flat)
            DEFAULT_PRICING = JSON.parse(JSON.stringify(PRICING))
          }
          if (typeof data.currency === 'string' && data.currency) currency = data.currency
          if (data.meta && typeof data.meta === 'object') {
            priceMeta = {
              source: String(data.meta.source || ''),
              syncedAt: Number(data.meta.syncedAt) || 0,
              count: Number(data.meta.count) || 0,
              error: String(data.meta.error || '')
            }
          }
          if (data.aliases && typeof data.aliases === 'object') {
            for (const [alias, target] of Object.entries(data.aliases)) {
              if (typeof target === 'string' && target) ALIASES[String(alias).toLowerCase()] = target
            }
            rebuildPriceIndex()
          }
        } catch (e) {}
      }

      function normalizeRecord(raw) {
        if (!raw || typeof raw !== 'object') return null
        const time = Number(raw.time)
        if (!Number.isFinite(time) || time <= 0) return null
        const toNum = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d) }
        return {
          time,
          model: String(raw.model || ''),
          provider: String(raw.provider || ''),
          purpose: String(raw.purpose || ''),
          sessionId: String(raw.sessionId || ''),
          inputTokens: toNum(raw.inputTokens),
          outputTokens: toNum(raw.outputTokens),
          cacheReadTokens: toNum(raw.cacheReadTokens),
          cacheWriteTokens: toNum(raw.cacheWriteTokens),
          reasoningTokens: toNum(raw.reasoningTokens),
          finishReason: String(raw.finishReason || ''),
          interrupted: !!raw.interrupted,
          usdCnyRate: toNum(raw.usdCnyRate),
          fxDate: String(raw.fxDate || '')
        }
      }

      async function tryInitWithRoot(candidate) {
        const tryPath = joinPath(normPath(candidate), 'dsh-usage', 'usage-records.json')
        try {
          if (nfsExists(tryPath)) {
            const arr = JSON.parse(await nfsReadText(tryPath))
            if (Array.isArray(arr) && arr.length > 0) {
              const existing = {}
              for (let i = 0; i < records.length; i++) existing[records[i].time] = true
              for (let i = 0; i < arr.length; i++) {
                const rec = normalizeRecord(arr[i])
                if (!rec || existing[rec.time]) continue
                existing[rec.time] = true
                records.push(rec)
              }
              if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
              records.sort((a, b) => a.time - b.time)
            }
          }
        } catch (e) {}
        try {
          // 真实试写以确认该目录可写；用宿主进程的 node:fs，不受 workspace-write
          // 沙箱约束，因此活动数据根会落在工作区之外的系统/用户目录。
          await nfsWriteText(tryPath, JSON.stringify(records))
          root = normPath(candidate)
          dataPath = tryPath
          pricingPath = joinPath(path.dirname(dataPath), 'pricing.json')
          budgetPath = joinPath(path.dirname(dataPath), 'budget.json')
          await loadPricing()
          await loadBudget()
          persistOk = true
          persistError = ''
          return { ok: true }
        } catch (e) {
          return { ok: false, error: msg(e) }
        }
      }

      async function migrateLegacy(candidates) {
        const paths = []
        for (const c of candidates) {
          paths.push(joinPath(normPath(c), '.dsh-usage-records.json'))
          paths.push(joinPath(normPath(c), 'dsh-usage', 'usage-records.json'))
        }
        for (const p of paths) {
          try {
            if (!nfsExists(p)) continue
            const arr = JSON.parse(await nfsReadText(p))
            if (Array.isArray(arr)) {
              const existing = {}
              for (let j = 0; j < records.length; j++) existing[records[j].time] = true
              for (const raw of arr) {
                const rec = normalizeRecord(raw)
                if (!rec || existing[rec.time]) continue
                existing[rec.time] = true
                records.push(rec)
              }
              if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
              records.sort((a, b) => a.time - b.time)
            }
          } catch (e) {}
        }
      }

      // 固定、专用的数据目录：不随工作区漂移，也绝不放进工作目录。
      // 优先级：环境变量 DSH_USAGE_DATA_DIR >
      // 系统应用数据目录(LOCALAPPDATA 或 APPDATA 下的 dsh-usage-plugin) >
      // 用户主目录下的专用文件夹 dsh-usage-data。
      // 这些目录由宿主进程 node:fs 直接写入，不受 workspace-write 沙箱约束，
      // 因此数据稳定地落在工作区之外——切换工作区也不会丢失历史。
      // 仅在以上目录全部不可写时，才兜底写到工作区（极少见，且会提示用户）。
      function resolveDataRoot() {
        const out = []
        const env = ((typeof process !== 'undefined' && process.env && process.env.DSH_USAGE_DATA_DIR) || '').trim()
        if (env) out.push(normPath(env))
        const localApp = (typeof process !== 'undefined' && process.env) ? (process.env.LOCALAPPDATA || '') : ''
        if (localApp) out.push(joinPath(normPath(localApp), 'dsh-usage-plugin'))
        const roamingApp = (typeof process !== 'undefined' && process.env) ? (process.env.APPDATA || '') : ''
        if (roamingApp) out.push(joinPath(normPath(roamingApp), 'dsh-usage-plugin'))
        out.push(joinPath(normPath(os.homedir()), 'dsh-usage-data'))
        // 兜底（极少见）：以上均不可写时落到工作区，保证不丢数据并提示用户。
        try {
          const sp = ctx.get('sandboxPolicy')
          if (sp && sp.workspaceRoot) out.push(joinPath(normPath(String(sp.workspaceRoot)), 'dsh-usage'))
        } catch (e) {}
        return out
      }

      // 已知可能遗留旧数据的目录（用于一次性合并迁移），不再作为活动根。
      function knownLegacyRoots() {
        const home = normPath(os.homedir())
        const roots = [home, joinPath(home, '.dsh')]
        try {
          const sp = ctx.get('sandboxPolicy')
          if (sp && sp.workspaceRoot) roots.push(normPath(String(sp.workspaceRoot)))
        } catch (e) {}
        const agent = currentAgent()
        if (agent && agent.session && agent.session.header && agent.session.header.cwd) {
          roots.push(normPath(String(agent.session.header.cwd)))
        }
        return roots
      }

      // 会话激活后不再切换根目录（避免路径漂移/历史被拆散）；仅把工作区里
      // 可能遗留的旧记录并入固定的数据根。
      async function ensureSessionRoot() {
        if (!persistOk) return
        await migrateLegacy(knownLegacyRoots())
        persistNow()
      }

      async function initPersistence() {
        const candidates = resolveDataRoot()
        let lastError = ''
        for (const c of candidates) {
          const r = await tryInitWithRoot(c)
          if (r.ok) {
            // 首次初始化时把散落在 主目录/.dsh/各工作区 的历史记录合并进来
            await migrateLegacy(knownLegacyRoots())
            persistNow()
            return
          }
          lastError = r.error || '写入失败'
        }
        persistError = lastError || '未找到可写的持久化目录'
        persistOk = false
        root = ''
        dataPath = ''
      }

      const ensureInit = () => (initPromise ||= initPersistence())
      try { ensureInit() } catch (e) { push('ensureInit-threw: ' + msg(e)) }

      // ── capture ────────────────────────────────────────────────────────────
      try {
        ctx.on('llm/stream', function (options, next) {
          const source = next()
          const model = (options && options.model) || ''
          const provider = (options && options.provider) || ''
          const purpose = options && options.purpose ? String(options.purpose) : ''
          let sessionId = options && options.sessionId ? String(options.sessionId) : ''
          const startedAt = Date.now()
          let usage = null
          let finishReason = ''

          async function* observe() {
            try {
              for await (const chunk of source) {
                if (chunk && chunk.type === 'usage' && chunk.usage) {
                  usage = chunk.usage
                } else if (chunk && chunk.type === 'finish') {
                  const r = chunk.reason
                  finishReason = r ? String(r.kind || '') : ''
                }
                yield chunk
              }
            } finally {
              if (!sessionId) {
                try { const ag = currentAgent(); if (ag && ag.session && ag.session.id) sessionId = String(ag.session.id) } catch (e) {}
              }
              if (provider === 'digital-ocean' || provider === 'digitalocean') {
                try { await refreshFxRate(false) } catch (e) {}
              }
              const isDO = provider === 'digital-ocean' || provider === 'digitalocean'
              if (usage) {
                // 兼容性：DeepSeek 系 provider 的 usage 不单独上报 cacheWriteTokens
                // （缓存写入发生在未命中时，即 cacheWriteTokens == inputTokens）。
                // 当上游未提供该字段时，用未命中 token 数（inputTokens）兜底，避免
                // "缓存写入"列长期为空。
                const cacheWrite = usage.cacheWriteTokens || usage.inputTokens || 0
                records.push({
                  time: startedAt,
                  model,
                  provider,
                  purpose,
                  sessionId,
                  inputTokens: usage.inputTokens || 0,
                  outputTokens: usage.outputTokens || 0,
                  cacheReadTokens: usage.cacheReadTokens || 0,
                  cacheWriteTokens: cacheWrite,
                  reasoningTokens: usage.reasoningTokens || 0,
                  finishReason,
                  usdCnyRate: isDO ? (FX.rate || 0) : 0,
                  fxDate: isDO ? (FX.date || '') : ''
                })
              } else if (isRealCall({ model, provider, time: startedAt })) {
                // 兜底：harness 在流被中断（aborted / error / timeout）时不会产出
                // usage chunk（usage 只在收到 [DONE] 哨兵后才由 adapter yield），
                // 但官方后台仍会按该次请求的实际 token 计费。这里补记一条 0-token
                // 的「中断调用」，使调用次数与官方口径对齐；token 与费用均为 0，
                // 不会虚增消耗。interrupted 标记供客户端 UI 区分展示。
                records.push({
                  time: startedAt,
                  model,
                  provider,
                  purpose,
                  sessionId,
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  reasoningTokens: 0,
                  finishReason: finishReason || 'aborted',
                  interrupted: true,
                  usdCnyRate: 0,
                  fxDate: ''
                })
              }
              if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
              try {
                const agent = currentAgent()
                const sp = ctx.get('sandboxPolicy')
                if (sp && typeof sp.resolve === 'function' && agent && agent.session) {
                  const policy = sp.resolve({ session: agent.session })
                  if (policy && policy.workspaceRoot) cachedPolicy = policy
                }
              } catch (e) {}
              ensureSessionRoot().then(persistNow).catch(() => {})
            }
          }

          return observe()
        })
        push('llm-stream-listener-ok')
      } catch (e) {
        push('llm-stream-listener-threw: ' + (e && e.stack ? e.stack : msg(e)))
      }

      // ── balance / network helpers ──────────────────────────────────────────
      async function safeCwd() {
        if (root) {
          try {
            await fsp.stat(root)
            return root
          } catch (e) {}
        }
        return (typeof process !== 'undefined' && typeof process.cwd === 'function' && process.cwd()) || '.'
      }

      async function runCollect(argv, opts) {
        const subprocess = ctx.get('subprocess')
        if (!subprocess) return { ok: false, error: '命令执行服务不可用' }
        let handle
        try {
          handle = subprocess.spawn({
            argv,
            cwd: await safeCwd(),
            stdio: opts && opts.stdinData != null
              ? { stdin: { data: opts.stdinData }, stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }
              : { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
            graceMs: (opts && opts.graceMs) || 15000,
            ...(opts && opts.env ? { env: opts.env } : {})
          })
        } catch (e) { return { ok: false, error: '启动失败：' + msg(e) } }
        let outcome
        try { outcome = await handle.done } catch (e) { return { ok: false, error: '执行失败：' + msg(e) } }
        const outText = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        const errText = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
        return { ok: outcome.exitCode === 0, exitCode: outcome.exitCode, out: outText, err: errText }
      }

      const isElectron = typeof process !== 'undefined' && !!(process.versions && process.versions.electron)
      function nodeCandidates() {
        const list = IS_WIN
          ? ['node.exe', 'node', 'C:\\Program Files\\nodejs\\node.exe']
          : ['node']
        if (typeof process !== 'undefined' && process.execPath && !list.includes(process.execPath)) list.push(process.execPath)
        return list
      }

      async function spawnNode(script, stdinData, env) {
        const subprocess = ctx.get('subprocess')
        if (!subprocess) return { ok: false, error: '命令执行服务不可用' }
        let exe = null
        for (const c of nodeCandidates()) {
          try { exe = await subprocess.resolveExecutable(c); if (exe) break } catch (e) {}
        }
        if (!exe) return { ok: false, error: '未找到 node 可执行文件' }
        const finalEnv = env || {}
        if (isElectron && exe === process.execPath && !('ELECTRON_RUN_AS_NODE' in finalEnv)) {
          finalEnv.ELECTRON_RUN_AS_NODE = '1'
        }
        const r = await runCollect([exe, '-e', script], { stdinData, env: finalEnv })
        if (!r.ok) {
          if (r.exitCode != null) return { ok: false, error: 'node 退出码 ' + r.exitCode + (r.err ? '：' + r.err.trim() : '') }
          return { ok: false, error: r.error || '执行失败' }
        }
        return { ok: true, out: r.out }
      }

      function bjTodayKey() {
        const d = new Date(Date.now() + 8 * 3600 * 1000)
        return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
      }

      // 拉取 OpenRouter 公开目录并转成平价表。价格字段是「每 token 美元」的字符串，
      // 乘 1e6 得到本表使用的「每百万 token」单价。
      //
      // 缓存读价缺失或为 0 时退回未命中价：OpenRouter 对不支持缓存的模型也返回
      // input_cache_read，此时它是 0 而不是「缓存免费」。直接采信会低估花费。
      async function fetchOpenRouterPrices() {
        const script = [
          'const https=require("https");',
          'const u="https://openrouter.ai/api/v1/models";',
          'const req=https.get(u,{headers:{Accept:"application/json","User-Agent":"dsh-usage-plugin"}},function(res){',
          'let b="";res.on("data",c=>b+=c);res.on("end",()=>process.stdout.write(JSON.stringify({status:res.statusCode,body:b})));',
          '});',
          'req.on("error",e=>process.stdout.write(JSON.stringify({error:String(e&&e.message||e)})));',
          'req.setTimeout(30000,()=>req.destroy(new Error("timeout")));'
        ].join('\n')
        const r = await spawnNode(script)
        if (!r.ok) throw new Error(r.error || '价格请求失败')
        const wrapper = JSON.parse(r.out)
        if (wrapper.error || wrapper.status !== 200) throw new Error(wrapper.error || ('HTTP ' + wrapper.status))
        const payload = JSON.parse(wrapper.body)
        const { table, scanned, skipped } = openRouterTable(payload)
        if (!scanned) throw new Error('价格响应中没有模型')
        return { table, scanned, skipped }
      }

      // 同步价格表并落盘。失败时保留上一份表不动，只记录错误——网络故障不应该把
      // 已有价格清空成 0。
      async function syncPrices() {
        try {
          const { table, scanned, skipped } = await fetchOpenRouterPrices()
          const n = applyFlatPrices(table)
          if (!n) throw new Error('价格表中没有可用条目')
          // 快照为重置基线：resetPrices 回到的是最近一次同步的结果。
          DEFAULT_PRICING = JSON.parse(JSON.stringify(PRICING))
          priceMeta = { source: 'openrouter', syncedAt: Date.now(), count: n, error: '' }
          await persistPricing()
          return { ok: true, ...priceMeta, scanned, skipped }
        } catch (e) {
          priceMeta = { ...priceMeta, error: msg(e) }
          return { ok: false, error: msg(e), source: priceMeta.source, syncedAt: priceMeta.syncedAt, count: priceMeta.count }
        }
      }

      // 价格表为空或超过 staleMs 未更新时，在后台补一次同步。不阻塞调用方，
      // 失败也不上报——首次安装后用户第一次打开面板就能看到价格，而不必先手动点同步。
      const PRICE_STALE_MS = 7 * 24 * 3600 * 1000
      let priceSyncInFlight = null
      function ensurePricesFresh() {
        if (priceSyncInFlight) return priceSyncInFlight
        const stale = !priceMeta.syncedAt || (Date.now() - priceMeta.syncedAt) > PRICE_STALE_MS
        if (!stale && PRICE_MODELS.length) return Promise.resolve(null)
        priceSyncInFlight = syncPrices().catch(() => null).then((r) => { priceSyncInFlight = null; return r })
        return priceSyncInFlight
      }

      async function refreshFxRate(force) {
        if (!force && FX.rate > 0 && FX.queriedAt && bjKey(FX.queriedAt) === bjTodayKey()) return FX
        const script = [
          'const https=require("https");',
          'const u="https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY";',
          'const req=https.get(u,{headers:{Accept:"application/json","User-Agent":"dsh-usage-plugin"}},function(res){',
          'let b="";res.on("data",c=>b+=c);res.on("end",()=>process.stdout.write(JSON.stringify({status:res.statusCode,body:b})));',
          '});',
          'req.on("error",e=>process.stdout.write(JSON.stringify({error:String(e&&e.message||e)})));',
          'req.setTimeout(15000,()=>req.destroy(new Error("timeout")));'
        ].join('\n')
        const r = await spawnNode(script)
        if (!r.ok) {
          FX = { ...FX, stale: FX.rate > 0, error: r.error || '汇率请求失败', queriedAt: Date.now() }
          return FX
        }
        try {
          const wrapper = JSON.parse(r.out)
          if (wrapper.error || wrapper.status !== 200) throw new Error(wrapper.error || ('HTTP ' + wrapper.status))
          const arr = JSON.parse(wrapper.body)
          const row = Array.isArray(arr) ? arr.find((x) => x && x.base === 'USD' && x.quote === 'CNY') : null
          const rate = Number(row && row.rate)
          if (!(rate > 0)) throw new Error('响应中缺少 USD/CNY 汇率')
          FX = { rate, inverse: 1 / rate, date: String(row.date || ''), queriedAt: Date.now(), source: 'Frankfurter', stale: false, error: '' }
        } catch (e) {
          FX = { ...FX, stale: FX.rate > 0, error: msg(e), queriedAt: Date.now() }
        }
        return FX
      }

      async function resolveCredential(credentials, candidates) {
        const seen = new Set()
        for (const candidate of candidates) {
          const name = typeof candidate === 'string' ? candidate : candidate.name
          if (!name || seen.has(name)) continue
          seen.add(name)
          try {
            const hit = await credentials.resolve(name)
            if (hit && hit.value) {
              return {
                name,
                value: hit.value,
                source: String(hit.source || ''),
                route: typeof candidate === 'string' ? '' : String(candidate.route || '')
              }
            }
          } catch (e) {}
        }
        return null
      }

      async function configuredModelProvider(provider) {
        if (!provider || provider.queryMode !== 'direct') return null
        try {
          const settings = ctx.get('settings')
          if (!settings || typeof settings.get !== 'function') return null
          const section = await settings.get('llm-pi-ai')
          const profiles = section && section.providers
          if (!profiles || typeof profiles !== 'object') return null
          for (const route of Object.keys(profiles)) {
            const profile = profiles[route]
            if (!profile || typeof profile !== 'object') continue
            if (!matchesModelProvider(provider.id, route, profile.displayName)) continue
            return {
              route,
              apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : '',
              baseURL: typeof profile.baseURL === 'string' ? profile.baseURL.trim() : ''
            }
          }
        } catch (e) {}
        return null
      }

      function balanceFailure(provider, error, fields) {
        return {
          ok: false,
          provider: provider.id,
          providerName: provider.name,
          error,
          credentialHelpUrl: provider.credentialHelpUrl || '',
          ...(fields || {})
        }
      }

      const DIGITALOCEAN_CREDENTIAL = 'DIGITALOCEAN_TOKEN'

      async function credentialDescription(credentials, name) {
        if (credentials && typeof credentials.describe === 'function') {
          try {
            const info = await credentials.describe(name)
            return {
              configured: !!(info && info.configured),
              source: String((info && info.source) || ''),
              writable: !!(info && info.writable)
            }
          } catch (e) {}
        }
        const hit = await resolveCredential(credentials, [{ name, route: '' }])
        return {
          configured: !!hit,
          source: hit ? hit.source : '',
          writable: !!(credentials && typeof credentials.set === 'function')
        }
      }

      async function balanceCredentialStatus(providerId) {
        const provider = getBalanceProvider(providerId)
        if (!provider) return fail('不支持的余额服务商：' + String(providerId || ''))
        const credentials = ctx.get('credentials')
        if (!credentials) return balanceFailure(provider, '凭据服务不可用', { errorCode: 'credentials-unavailable' })
        if (provider.id === 'siliconflow') {
          const profile = await configuredModelProvider(provider)
          if (!profile) {
            return balanceFailure(provider, '未在“设置 → 模型”中找到 Provider ID 或显示名为 siliconflow 的模型提供商。', { errorCode: 'model-provider-missing' })
          }
          if (!profile.apiKeyEnv) {
            return balanceFailure(provider, '模型提供商 ' + profile.route + ' 没有配置 apiKeyEnv；请编辑该模型提供商并保存 API Key。', { errorCode: 'model-credential-ref-missing', modelProviderRoute: profile.route })
          }
          const info = await credentialDescription(credentials, profile.apiKeyEnv)
          return {
            ok: true,
            provider: provider.id,
            configured: info.configured,
            source: info.source,
            writable: info.writable,
            masked: info.configured ? '••••••••••••' : '',
            credentialName: profile.apiKeyEnv,
            modelProviderRoute: profile.route
          }
        }
        if (provider.id === 'digitalocean') {
          let credentialName = DIGITALOCEAN_CREDENTIAL
          let info = await credentialDescription(credentials, credentialName)
          if (!info.configured) {
            for (const candidate of provider.credentialNames) {
              if (candidate === DIGITALOCEAN_CREDENTIAL) continue
              const candidateInfo = await credentialDescription(credentials, candidate)
              if (!candidateInfo.configured) continue
              credentialName = candidate
              info = candidateInfo
              break
            }
          }
          return {
            ok: true,
            provider: provider.id,
            configured: info.configured,
            source: info.source,
            writable: info.writable,
            masked: info.configured ? '••••••••••••' : '',
            credentialName
          }
        }
        return balanceFailure(provider, '该服务商不支持在余额页管理凭据', { errorCode: 'credential-management-unsupported' })
      }

      async function saveBalanceCredential(providerId, rawValue) {
        const provider = getBalanceProvider(providerId)
        if (!provider || provider.id !== 'digitalocean') return fail('仅支持在余额页保存 DigitalOcean 账户 Token')
        const value = String(rawValue || '').trim()
        if (!/^dop_v1_[A-Za-z0-9_-]{20,}$/.test(value)) {
          return balanceFailure(provider, 'Token 格式不正确：请输入 DigitalOcean 控制台创建的 dop_v1_ Personal Access Token，不要使用 DO AI 推理 Key。', { errorCode: 'invalid-credential-format' })
        }
        const credentials = ctx.get('credentials')
        if (!credentials || typeof credentials.set !== 'function') {
          return balanceFailure(provider, '当前 Harness 凭据服务不支持安全保存 Token', { errorCode: 'credentials-read-only' })
        }
        const info = await credentialDescription(credentials, DIGITALOCEAN_CREDENTIAL)
        if (info.configured && !info.writable) {
          return balanceFailure(provider, 'DIGITALOCEAN_TOKEN 当前由只读来源 ' + (info.source || '环境变量') + ' 提供，不能在页面覆盖；请修改该来源后重启。', { errorCode: 'credential-read-only', credentialSource: info.source })
        }
        try {
          await credentials.set(DIGITALOCEAN_CREDENTIAL, value)
        } catch (e) {
          return balanceFailure(provider, '保存 Token 失败：' + msg(e), { errorCode: 'credential-save-failed' })
        }
        const saved = await credentialDescription(credentials, DIGITALOCEAN_CREDENTIAL)
        if (!saved.configured) return balanceFailure(provider, 'Token 保存后未能从凭据服务中重新读取', { errorCode: 'credential-save-unverified' })
        return {
          ok: true,
          provider: provider.id,
          configured: true,
          source: saved.source,
          writable: saved.writable,
          masked: '••••••••••••',
          credentialName: DIGITALOCEAN_CREDENTIAL
        }
      }
// ── Qwen / 百炼 Token Plan (console-token) ────────────────────────────
      // 复用 bl CLI 保存的百炼控制台 OAuth access_token（~/.bailian/config.json），
      // 调用百炼内部门户网关查询 Token Plan 配额用量，不需要阿里云 AccessKey。
      const QWEN_GATEWAYS = {
        'cn-beijing-domestic': { host: 'bailian-cs.console.aliyun.com', action: 'BroadScopeAspnGateway' },
        'cn-beijing-international': { host: 'bailian-cs.console.alibabacloud.com', action: 'BroadScopeAspnGateway' },
        'ap-southeast-1-domestic': { host: 'modelstudio-cs.console.aliyun.com', action: 'IntlBroadScopeAspnGateway' },
        'ap-southeast-1-international': { host: 'bailian-singapore-cs.alibabacloud.com', action: 'IntlBroadScopeAspnGateway' }
      }
      const QWEN_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'

      function readBailianConfigPath() {
        const base = process.env.BAILIAN_CONFIG_DIR || joinPath(os.homedir(), '.bailian')
        return joinPath(base, 'config.json')
      }

      async function readQwenConsoleToken() {
        const cfgPath = readBailianConfigPath()
        let raw
        try { raw = await nfsReadText(cfgPath) } catch (e) {
          throw new Error('未找到 ' + cfgPath + '。请先运行 `bl auth login --console` 完成百炼控制台登录。')
        }
        let cfg
        try { cfg = JSON.parse(raw) } catch (e) {
          throw new Error(cfgPath + ' 不是合法的 JSON 配置')
        }
        let token = cfg.access_token || cfg.accessToken
        const active = cfg.active_config || 'default'
        const profile = cfg[active]
        if (profile && typeof profile === 'object') {
          token = token || profile.access_token || profile.accessToken
        }
        if (!token || !String(token).trim()) {
          throw new Error('配置中没有 access_token，请先运行 `bl auth login --console` 完成百炼控制台登录。')
        }
        return { token: String(token).trim(), region: String(cfg.console_region || 'cn-beijing'), site: String(cfg.console_site || 'domestic') }
      }

      async function queryQwenTokenPlan() {
        const { token, region, site } = await readQwenConsoleToken()
        const gw = QWEN_GATEWAYS[region + '-' + site] || QWEN_GATEWAYS['cn-beijing-domestic']
        if (!gw) throw new Error('不支持的控制台地域/站点：' + region + '/' + site)
        const payload = {
          Api: QWEN_API,
          V: '1.0',
          Data: {
            cornerstoneParam: {
              protocol: 'V2',
              console: 'ONE_CONSOLE',
              productCode: 'p_efm',
              switchUserType: 3,
              consoleSite: 'BAILIAN_ALIYUN'
            }
          }
        }
        const body = 'params=' + encodeURIComponent(JSON.stringify(payload)) + '&region=' + encodeURIComponent(region)
        const url = 'https://' + gw.host + '/cli/api.json'
          + '?action=' + encodeURIComponent(gw.action)
          + '&product=sfm_bailian&api=' + encodeURIComponent(QWEN_API)
        // 与 bl CLI 一致：用 undici 的 EnvHttpProxyAgent 自动读取 HTTPS_PROXY/https_proxy
        // 环境变量，走代理转发；未设置代理时则直连（EnvHttpProxyAgent 内部处理）。
        // 因为子进程不保证能按模块名解析到 undici，这里预先算出 undici 的绝对入口路径并传给子进程。
        let undiciPath = ''
        try {
          undiciPath = new URL(import.meta.resolve('undici')).pathname
        } catch (e) {
          // undici 是插件依赖，正常安装后必然存在；这里留空交由子进程报清楚错误。
          undiciPath = ''
        }
        const script = [
          'const token=process.env.BAILIAN_TOKEN||"";',
          'const url=process.env.BAILIAN_API_URL||"";',
          'const body=process.env.BAILIAN_BODY||"";',
          'const undiciPath=process.env.UNDICI_PATH||"";',
          'if(!undiciPath){process.stdout.write(JSON.stringify({error:"undici 不可用，请确认插件依赖已安装"}));process.exit(0);}',
          'const m=require(undiciPath);',
          'try{m.setGlobalDispatcher(new m.EnvHttpProxyAgent())}catch(e){}',
          'const timeout=setTimeout(()=>{process.stdout.write(JSON.stringify({error:"timeout"}));process.exit(0)},20000);',
          '(async()=>{',
          '  try{',
          '    const res=await m.fetch(url,{method:"POST",headers:{Authorization:"Bearer "+token,Accept:"*/*","Content-Type":"application/x-www-form-urlencoded","User-Agent":"dsh-usage-plugin"},body:body});',
          '    clearTimeout(timeout);',
          '    const b=await res.text();',
          '    process.stdout.write(JSON.stringify({statusCode:res.status,contentType:String(res.headers.get("content-type")||""),body:b}));',
          '  }catch(e){',
          '    clearTimeout(timeout);',
          '    process.stdout.write(JSON.stringify({error:String(e&&e.message||e)}));',
          '  }',
          '})();'
        ].join('\n')
        const r = await spawnNode(script, null, {
          BAILIAN_TOKEN: token,
          BAILIAN_API_URL: url,
          BAILIAN_BODY: body,
          UNDICI_PATH: undiciPath
        })
        if (!r.ok) throw new Error(r.error || '请求失败')
        let parsed
        try { parsed = JSON.parse(r.out) } catch (e) { throw new Error('无法解析百炼网关输出') }
        if (parsed.error) throw new Error(parsed.error)
        if (parsed.statusCode !== 200) {
          const hint = parsed.statusCode === 401 || parsed.statusCode === 403 ? ' 登录可能已过期，请重新运行 `bl auth login --console`。' : ''
          throw new Error('接口返回 HTTP ' + parsed.statusCode + '：' + String(parsed.body || '').slice(0, 300) + hint)
        }
        // 网关返回的是带外层包装的 JSON（data.DataV2.data.data 才是配额字段），
        // 这里解包后把扁平化的 JSON 文本交给 parseBalanceResponse。
        let wrapper
        try { wrapper = JSON.parse(parsed.body) } catch (e) { throw new Error('无法解析百炼网关响应') }
        let inner = wrapper && wrapper.data
        if (inner && inner.DataV2) {
          const d2 = inner.DataV2.data
          inner = (d2 && d2.data) != null ? d2.data : (d2 != null ? d2 : inner.DataV2)
        } else if (inner) {
          inner = inner.data || inner
        }
        if (!inner || typeof inner !== 'object') throw new Error('百炼网关响应格式不符合预期')
        return JSON.stringify(inner)
      }

      async function queryBalance(providerId) {
        const provider = getBalanceProvider(providerId)
        if (!provider) return fail('不支持的余额服务商：' + String(providerId || ''))
        if (provider.queryMode === 'unsupported') {
          return balanceFailure(provider, 'AMD GPU Cloud 当前未公开可由推理 API Key 调用的余额查询端点；请在 AMD Developer Cloud 控制台查看 credits。', { unsupported: true, errorCode: 'unsupported' })
        }
        if (provider.queryMode === 'console-token') {
          try {
            const bodyText = await queryQwenTokenPlan()
            const normalized = parseBalanceResponse(provider.id, bodyText)
            if (!normalized.ok) {
              normalized.provider = provider.id
              normalized.providerName = provider.name
              normalized.credentialHelpUrl = provider.credentialHelpUrl || ''
            } else {
              normalized.credentialName = '百炼控制台 token'
              normalized.credentialSource = readBailianConfigPath()
            }
            return normalized
          } catch (e) {
            return balanceFailure(provider, msg(e), { errorCode: 'console-token-error' })
          }
        }
        const credentials = ctx.get('credentials')
        if (!credentials) return balanceFailure(provider, '凭据服务不可用', { errorCode: 'credentials-unavailable' })
        const modelProfile = await configuredModelProvider(provider)
        const credentialCandidates = []
        if (provider.id === 'siliconflow' && !modelProfile) {
          return balanceFailure(provider, '未在“设置 → 模型”中找到 Provider ID 或显示名为 siliconflow 的模型提供商。请先添加该提供商、填写 API Key 并保存，然后返回此页查询。', { errorCode: 'model-provider-missing' })
        }
        if (provider.id === 'siliconflow' && modelProfile && !modelProfile.apiKeyEnv) {
          return balanceFailure(provider, '模型提供商 ' + modelProfile.route + ' 没有配置 API Key。请在“设置 → 模型”中编辑该提供商并保存 API Key。', { errorCode: 'model-credential-ref-missing', modelProviderRoute: modelProfile.route })
        }
        if (modelProfile && modelProfile.apiKeyEnv) credentialCandidates.push({ name: modelProfile.apiKeyEnv, route: modelProfile.route })
        if (provider.id !== 'siliconflow') {
          for (const name of provider.credentialNames) credentialCandidates.push({ name, route: '' })
        }
        const hit = await resolveCredential(credentials, credentialCandidates)
        if (!hit) {
          const message = provider.id === 'digitalocean'
            ? '尚未保存 DigitalOcean 账户 Personal Access Token。请在此页面输入 dop_v1_ Token，保存后查询。'
            : provider.id === 'siliconflow'
              ? '模型提供商 ' + modelProfile.route + ' 引用了 ' + modelProfile.apiKeyEnv + '，但该凭据未配置。请在“设置 → 模型”中重新填写 API Key 并保存。'
              : missingCredentialError(provider).error
          return balanceFailure(provider, message, { errorCode: 'missing-credential', modelProviderRoute: modelProfile ? modelProfile.route : '' })
        }
        const endpoint = resolveBalanceEndpoint(provider.id, modelProfile && modelProfile.baseURL)
        const script = [
          'const https=require("https");',
          'const key=process.env.BALANCE_API_KEY||"";',
          'const url=process.env.BALANCE_API_URL||"";',
          'const req=https.get(url,{headers:{Authorization:"Bearer "+key,Accept:"application/json","User-Agent":"dsh-usage-plugin"}},function(res){',
          'var body="";',
          'res.on("data",function(c){body+=c});',
          'res.on("end",function(){process.stdout.write(JSON.stringify({statusCode:res.statusCode,contentType:String(res.headers["content-type"]||""),body:body}))});',
          '});',
          'req.on("error",function(e){process.stdout.write(JSON.stringify({error:String(e&&e.message||e)}))});',
          'req.setTimeout(20000,function(){req.destroy(new Error("timeout"))});'
        ].join('\n')
        const r = await spawnNode(script, null, { BALANCE_API_KEY: hit.value, BALANCE_API_URL: endpoint })
        if (!r.ok) return balanceFailure(provider, r.error, { errorCode: 'request-failed' })
        let parsed
        try { parsed = JSON.parse(r.out) } catch (e) { return balanceFailure(provider, '无法解析 node 输出', { errorCode: 'invalid-response' }) }
        if (parsed.error) return balanceFailure(provider, parsed.error, { errorCode: 'request-failed' })
        if (parsed.statusCode !== 200) {
          const authHint = parsed.statusCode === 401 || parsed.statusCode === 403 ? ' 请检查凭据是否属于该账户、是否有效及是否具备余额/账单读取权限。' : ''
          return balanceFailure(provider, '接口返回 HTTP ' + parsed.statusCode + '：' + String(parsed.body || '').slice(0, 300) + authHint, {
            errorCode: parsed.statusCode === 401 || parsed.statusCode === 403 ? 'unauthorized' : 'http-error',
            statusCode: parsed.statusCode,
            credentialName: hit.name,
            credentialSource: hit.source,
            modelProviderRoute: hit.route || (modelProfile ? modelProfile.route : '')
          })
        }
        if (!String(parsed.contentType || '').toLowerCase().includes('application/json')) {
          return balanceFailure(provider, '接口返回了非 JSON 内容（Content-Type: ' + String(parsed.contentType || '未知') + '），请求可能被网络代理拦截。', { errorCode: 'invalid-content-type', statusCode: parsed.statusCode })
        }
        const normalized = parseBalanceResponse(provider.id, parsed.body)
        if (normalized.ok) {
          normalized.credentialName = hit.name
          normalized.credentialSource = hit.source
          normalized.modelProviderRoute = hit.route || (modelProfile ? modelProfile.route : '')
          normalized.endpoint = endpoint
        } else {
          normalized.provider = provider.id
          normalized.providerName = provider.name
          normalized.credentialHelpUrl = provider.credentialHelpUrl || ''
        }
        return normalized
      }

      // ── export helpers ─────────────────────────────────────────────────────
      function csvCell(s) {
        s = String(s == null ? '' : s)
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
        return s
      }

      function buildCsv() {
        const header = ['time', 'model', 'provider', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'finishReason', 'period', 'baseCost', 'peakValleyCost', 'autoCost']
        const lines = [header.join(',')]
        for (const r of records) {
          lines.push([
            r.time, r.model, r.provider, r.inputTokens, r.cacheReadTokens, r.cacheWriteTokens,
            r.outputTokens, r.reasoningTokens, r.finishReason,
            isPeak(r.time) ? 'peak' : 'offPeak', costFor(r, 'base'), costFor(r, 'peakValley'), costFor(r, 'auto')
          ].map(csvCell).join(','))
        }
        return lines.join('\r\n')
      }

      async function writePngFile(base64, outPath) {
        try {
          await fsp.mkdir(path.dirname(outPath), { recursive: true })
          await fsp.writeFile(outPath, Buffer.from(base64, 'base64'))
          return { ok: true }
        } catch (e) { return { ok: false, error: msg(e) } }
      }

      async function writeTextFileViaNode(content, outPath) {
        try {
          await fsp.mkdir(path.dirname(outPath), { recursive: true })
          await fsp.writeFile(outPath, Buffer.from(content, 'utf8'))
          return { ok: true }
        } catch (e) { return { ok: false, error: msg(e) } }
      }

      async function mkdirViaNode(dir) {
        try { await fsp.mkdir(dir, { recursive: true }); return { ok: true } } catch (e) { return { ok: false, error: msg(e) } }
      }

      async function pickDirectory() {
        const subprocess = ctx.get('subprocess')
        if (!subprocess) return fail('命令执行服务不可用')
        if (IS_MAC) {
          let exe = null
          try { exe = await subprocess.resolveExecutable('osascript') } catch (e) {}
          if (!exe) return fail('未找到 osascript（macOS 需安装命令行工具 Command Line Tools）')
          const r = await runCollect([exe, '-e', 'POSIX path of (choose folder)'], { graceMs: 120000 })
          if (!r.ok && r.error) return fail(r.error)
          const picked = normPath(r.out.trim())
          if (!picked) return { ok: false, cancelled: true }
          return { ok: true, path: picked }
        }
        if (!IS_WIN) {
          for (const c of ['zenity', 'kdialog']) {
            let exe = null
            try { exe = await subprocess.resolveExecutable(c) } catch (e) {}
            if (!exe) continue
            const argv = c === 'zenity'
              ? [exe, '--file-selection', '--directory', '--title=选择导出目录']
              : [exe, '--getexistingdirectory', '选择导出目录']
            const r = await runCollect(argv, { graceMs: 120000 })
            if (!r.ok && r.error) return fail(r.error)
            const picked = normPath(r.out.trim())
            if (!picked) return { ok: false, cancelled: true }
            return { ok: true, path: picked }
          }
          return fail('未找到目录选择工具（请安装 zenity 或 kdialog）')
        }
        let exe = null
        for (const c of ['powershell.exe', 'pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']) {
          try { exe = await subprocess.resolveExecutable(c); if (exe) break } catch (e) {}
        }
        if (!exe) return fail('未找到 PowerShell')
        const script = 'Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = "选择导出目录"; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }'
        const r = await runCollect([exe, '-NoProfile', '-STA', '-NonInteractive', '-Command', script], { graceMs: 120000 })
        if (!r.ok && r.error) return fail(r.error)
        const picked = normPath(r.out.trim())
        if (!picked) return { ok: false, cancelled: true }
        return { ok: true, path: picked }
      }

      async function revealDir(dirArg) {
        const subprocess = ctx.get('subprocess')
        if (!subprocess) return fail('命令执行服务不可用')
        let target = ''
        const isKey = dirArg === 'csv' || dirArg === 'json' || dirArg === 'images' || dirArg === 'data'
        if (isKey) {
          const d = dirs()
          target = dirArg === 'csv' ? d.csv : dirArg === 'json' ? d.json : dirArg === 'images' ? d.images : d.data
          target = normPath(target)
          try {
            await nfsWriteText(joinPath(target, '.keep'), '')
          } catch (e) {}
        } else {
          target = normPath(dirArg)
          await mkdirViaNode(target)
        }
        const revealCmd = IS_WIN ? 'explorer.exe' : (IS_MAC ? 'open' : 'xdg-open')
        let exe = null
        try { exe = await subprocess.resolveExecutable(revealCmd) } catch (e) {}
        if (!exe) return fail('未找到 ' + revealCmd)
        try {
          subprocess.spawn({ argv: [exe, target], cwd: await safeCwd(), stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 5000 })
          return { ok: true }
        } catch (e) { return fail(msg(e)) }
      }

      // ── API ────────────────────────────────────────────────────────────────
      async function routeApi(body) {
        const action = body && body.action ? String(body.action) : ''
        try { await ensureInit() } catch (e) {}
        switch (action) {
          case 'list': {
            try { await refreshFxRate(false) } catch (e) {}
            // 价格表为空（首次安装）时同步等一次，让面板立刻有价格可显示；
            // 只是过期则后台刷新，不拖慢这次响应。
            try {
              if (!PRICE_MODELS.length) await ensurePricesFresh()
              else ensurePricesFresh().catch(() => {})
            } catch (e) {}
            const items = records.filter(isRealCall).map(projectRecord)
            const toolItems = records.filter((r) => !isRealCall(r)).map(projectRecord)
            return { ok: true, records: items, count: items.length, toolCalls: toolItems, dataPath, persistOk, persistError, pricing: PRICING, priceModels: PRICE_MODELS, priceMeta, currency, effectiveAt: EFFECTIVE_AT, days: buildDays(), fx: FX, budget }
          }
          case 'tokenForMessage': {
            // 消息底部弹窗：分两层统计——整场对话累计（conversation）+ 本轮明细（aggregate/records）。
            const sid = body && body.sessionId ? String(body.sessionId) : ''
            const from = Number(body && body.from) || 0
            const to = Number(body && body.to) || 0
            let sessionRecs = records.filter(isRealCall)
            if (sid) sessionRecs = sessionRecs.filter((r) => String(r.sessionId || '') === sid)
            let turnRecs = sessionRecs
            if (from > 0) turnRecs = turnRecs.filter((r) => r.time >= from)
            if (to > 0) turnRecs = turnRecs.filter((r) => r.time <= to)
            const convoAgg = computeAgg(sessionRecs.map(projectRecord))
            const turnAgg = computeAgg(turnRecs.map(projectRecord))
            return { ok: true, records: turnRecs.map(projectRecord), aggregate: turnAgg, conversation: convoAgg, count: turnRecs.length, from, to }
          }
          case 'clear': {
            const n = records.length
            records.length = 0
            persistNow()
            return { ok: true, cleared: n }
          }
          case 'setPrices': {
            // 接受平价表 { <id>: {cacheHit, cacheMiss, output} }，也兼容旧的
            // { base | peakValley: { <id>: ... } } 形状。只覆盖传入的 id。
            const prices = body && body.prices
            if (!prices || typeof prices !== 'object') return fail('缺少价格数据')
            const flat = {}
            const takeFlat = (src) => {
              for (const [id, row] of Object.entries(src || {})) {
                if (!row || typeof row !== 'object') continue
                const inner = row.offPeak || row.peak
                flat[id] = inner && typeof inner === 'object' ? inner : row
              }
            }
            if (prices.base || prices.peakValley) {
              takeFlat(prices.base)
              for (const [id, row] of Object.entries(prices.peakValley || {})) {
                if (flat[id]) continue
                if (row && typeof row === 'object') flat[id] = row.offPeak || row.peak || row
              }
            } else {
              takeFlat(prices)
            }
            const n = applyFlatPrices(flat)
            if (!n) return fail('没有可用的价格更新（价格必须是非负数字，且至少一项大于 0）')
            priceMeta = { ...priceMeta, source: priceMeta.source || 'manual' }
            persistPricing()
            return { ok: true, count: n, priceModels: PRICE_MODELS }
          }
          case 'resetPrices': {
            // 回到最近一次同步 / 载入得到的快照（整表替换，含被删掉的模型）。
            const n = replaceFlatPrices(DEFAULT_PRICING.base || {})
            persistPricing()
            return { ok: true, count: n, priceModels: PRICE_MODELS }
          }
          case 'syncPrices': {
            const r = await syncPrices()
            return { ...r, priceModels: PRICE_MODELS, currency }
          }
          case 'setCurrency': {
            const raw = String((body && body.currency) || '').trim().toUpperCase()
            if (!raw) return fail('缺少货币')
            // 价格表存的是 OpenRouter 的美元价，切换货币只改展示符号，不做换算。
            if (raw !== 'USD' && raw !== 'CNY') return fail('仅支持 USD 或 CNY')
            currency = raw
            persistPricing()
            return { ok: true, currency }
          }
          case 'setAliases': {
            // 把记录里出现的模型名映射到价格表 id（route 名 ≠ 供应商型号名时用）。
            const aliases = body && body.aliases
            if (!aliases || typeof aliases !== 'object') return fail('缺少别名数据')
            let n = 0
            for (const [alias, target] of Object.entries(aliases)) {
              const a = String(alias || '').trim().toLowerCase()
              const t = String(target || '').trim().toLowerCase()
              if (a && t) { ALIASES[a] = t; n++ }
            }
            if (!n) return fail('没有可用的别名')
            rebuildPriceIndex()
            persistPricing()
            return { ok: true, count: n, aliases: ALIASES }
          }
          case 'setBudget': {
            // 设置月度预算（元）；传入非负数字生效，null/NaN/负数视为清除预算。
            const raw = Number(body && body.monthly)
            if (Number.isFinite(raw) && raw >= 0) budget = { monthly: raw }
            else budget = null
            persistBudget()
            return { ok: true, budget }
          }
          case 'fxRefresh': {
            const fx = await refreshFxRate(true)
            return { ok: fx.rate > 0, fx, error: fx.rate > 0 ? '' : (fx.error || '无法获取汇率') }
          }
          case 'balance':
            return queryBalance(body && body.provider)
          case 'balanceProviders':
            return { ok: true, providers: providerList() }
          case 'balanceCredentialStatus':
            return balanceCredentialStatus(body && body.provider)
          case 'saveBalanceCredential':
            return saveBalanceCredential(body && body.provider, body && body.value)
          case 'pickDir':
            return pickDirectory()
          case 'export': {
            if (!root) return fail('未找到数据根目录')
            const kind = (body && body.kind) === 'json' ? 'json' : 'csv'
            const name = 'dsh-usage-' + stamp() + (kind === 'json' ? '.json' : '.csv')
            const content = kind === 'json'
              ? JSON.stringify({ exportedAt: Date.now(), pricing: PRICING, records }, null, 2)
              : buildCsv()
            const dirArg = body && body.dir ? normPath(String(body.dir)) : ''
            if (dirArg) {
              const outPath = joinPath(dirArg, name)
              const r = await writeTextFileViaNode(content, outPath)
              if (!r.ok) return fail(r.error)
              return { ok: true, path: outPath, name, dir: dirArg }
            }
            const outPath = joinPath(kind === 'json' ? dirs().json : dirs().csv, name)
            try {
              await nfsWriteText(outPath, content)
              return { ok: true, path: normPath(outPath), name, dir: kind === 'json' ? 'json' : 'csv' }
            } catch (e) { return fail(msg(e)) }
          }
          case 'exportPng': {
            const dataUrl = body && body.dataUrl ? String(body.dataUrl) : ''
            if (!dataUrl) return fail('缺少图片数据')
            const idx = dataUrl.indexOf('base64,')
            const b64 = idx >= 0 ? dataUrl.slice(idx + 7) : dataUrl
            if (!root) return fail('未找到数据根目录')
            const name = 'dsh-usage-report-' + stamp() + '.png'
            const dirArg = body && body.dir ? normPath(String(body.dir)) : ''
            const outPath = normPath(joinPath(dirArg || dirs().images, name))
            const r = await writePngFile(b64, outPath)
            if (!r.ok) return fail(r.error)
            return { ok: true, path: outPath, name, dir: dirArg || 'images' }
          }
          case 'import': {
            const content = body && body.content != null ? String(body.content) : ''
            const filename = body && body.filename ? String(body.filename) : ''
            if (!content) return fail('请选择要导入的文件')
            let parsed
            if (String(filename || '').toLowerCase().indexOf('.csv') >= 0) {
              const lines = String(content).split(/\r?\n/).filter((l) => l.trim().length > 0)
              const header = lines[0] ? parseCsvLine(lines[0]) : []
              const idx = {}
              header.forEach((h, i) => { idx[String(h).trim()] = i })
              parsed = lines.slice(1).map((line) => {
                const cells = parseCsvLine(line)
                const get = (name) => (idx[name] === undefined ? '' : (cells[idx[name]] === undefined ? '' : cells[idx[name]]))
                return {
                  time: get('time'), model: get('model'), provider: get('provider'),
                  inputTokens: get('inputTokens'), outputTokens: get('outputTokens'),
                  cacheReadTokens: get('cacheReadTokens'), cacheWriteTokens: get('cacheWriteTokens'),
                  reasoningTokens: get('reasoningTokens'), finishReason: get('finishReason')
                }
              })
            } else {
              try {
                const data = JSON.parse(content)
                parsed = Array.isArray(data) ? data : (data && Array.isArray(data.records) ? data.records : null)
              } catch (e) { parsed = null }
            }
            if (!parsed || !Array.isArray(parsed)) return fail('文件内容不是可识别的用量数据（支持 JSON 或 CSV）')
            let imported = 0, skipped = 0, invalid = 0
            const existing = {}
            for (const r of records) existing[r.time] = true
            for (const raw of parsed) {
              const rec = normalizeRecord(raw)
              if (!rec) { invalid++; continue }
              if (existing[rec.time]) { skipped++; continue }
              existing[rec.time] = true
              records.push(rec)
              imported++
            }
            if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
            records.sort((a, b) => a.time - b.time)
            persistNow()
            return { ok: true, imported, skipped, invalid, total: records.length }
          }
          case 'reveal': {
            const dirArg = body && body.dir ? String(body.dir) : 'data'
            return revealDir(dirArg)
          }
          default:
            return fail('未知操作：' + action)
        }
      }

      function parseCsvLine(line) {
        const cells = []
        let cur = ''
        let inQ = false
        for (let i = 0; i < line.length; i++) {
          const ch = line[i]
          if (inQ) {
            if (ch === '"') {
              if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
            } else cur += ch
          } else if (ch === '"') inQ = true
          else if (ch === ',') { cells.push(cur); cur = '' }
          else cur += ch
        }
        cells.push(cur)
        return cells
      }

      function readBody(req) {
        return new Promise((resolve) => {
          let d = ''
          req.on('data', (c) => { d += c })
          req.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { resolve({}) } })
          req.on('error', () => resolve({}))
        })
      }

      function sendJson(res, obj) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(obj))
      }

      const webServer = ctx.get('webServer')
      push('webServer=' + (webServer ? 'present' : 'undefined'))
      if (webServer && typeof webServer.register === 'function') {
        try {
          webServer.register({
            kind: 'exact',
            path: '/usage/api',
            handler: async (req, res) => {
              try {
                const body = await readBody(req)
                sendJson(res, await routeApi(body))
              } catch (e) {
                sendJson(res, { ok: false, error: msg(e) })
              }
            }
          })
          push('route-registered')
        } catch (e) {
          push('route-register-threw: ' + (e && e.stack ? e.stack : msg(e)))
        }
        try {
          // SSE 实时推送端点：数据变化时向订阅者推送 {"type":"changed"}。
          // 桌面端数据中心订阅该流即可即时感知用量数据更新。
          webServer.register({
            kind: 'exact',
            path: '/usage/api/events',
            handler: (req, res) => {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
              })
              res.write(':ok\n\n')
              sseClients.add(res)
              req.on('close', () => { sseClients.delete(res) })
            }
          })
        } catch (e) {
          push('events-route-register-threw: ' + msg(e))
        }
      } else {
        push('route-not-registered (no webServer)')
      }

      push('apply-end')
      diag.ok = true
    } catch (e) {
      diag.ok = false
      diag.error = (e && e.stack) ? e.stack : String(e)
    }
    flushDiag()
  }
}
