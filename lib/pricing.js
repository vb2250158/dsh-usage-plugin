/**
 * 通用模型价格表 —— 纯逻辑，无 IO、无状态。
 *
 * 从 host 半侧抽出来单独成模块，是为了让计价规则能被直接测试：原来的实现把这部分
 * 写在 apply() 闭包里，只能靠启动整个插件来间接验证。
 *
 * 价格条目形状（每 100 万 token 的单价）：
 *   cacheHit  缓存命中的输入单价   ← OpenRouter pricing.input_cache_read
 *   cacheMiss 未命中的输入单价     ← OpenRouter pricing.prompt
 *   output    输出单价             ← OpenRouter pricing.completion
 */

/**
 * 归一化模型 id，供模糊匹配使用。
 * @param {unknown} id
 * @returns {string}
 */
export function normalizeModelId(id) {
  let s = String(id == null ? '' : id).trim().toLowerCase()
  if (!s) return ''
  // OpenRouter 用 ~ 前缀标记「指向最新版本」的别名条目，用 :suffix 标记变体
  // （:batch / :free / :thinking 等）。两者都不该影响与实录模型名的匹配。
  if (s.charAt(0) === '~') s = s.slice(1)
  const colon = s.indexOf(':')
  if (colon > 0) s = s.slice(0, colon)
  return s
}

/**
 * 建立「模型名 → 价格表 key」的查找索引。
 *
 * 登记顺序决定优先级，先到先得（后写入不覆盖已有项），因此精确 id 永远优先于末段名：
 *   1. 末段模型名（gpt-6-astra）—— 实录里常常只有型号名，没有 provider 前缀
 *   2. 归一化后的完整 id（openai/gpt-6-astra）
 *   3. 别名表的显式映射（优先级最低，只在前面都没登记时生效）
 *
 * @param {readonly string[]} modelIds 价格表里已有的 key
 * @param {Record<string, string>} [aliases] 模型名 → 价格表 key
 * @returns {Record<string, string>}
 */
export function buildPriceIndex(modelIds, aliases) {
  const idx = {}
  const claim = (name, key) => { if (name && idx[name] === undefined) idx[name] = key }
  for (const key of modelIds || []) {
    const norm = normalizeModelId(key)
    if (!norm) continue
    const slash = norm.lastIndexOf('/')
    // 末段先登记，让 provider/model 的型号名可用；同一末段出现多次时保留先出现的。
    if (slash >= 0) claim(norm.slice(slash + 1), key)
    claim(norm, key)
  }
  const known = new Set(modelIds || [])
  for (const alias of Object.keys(aliases || {})) {
    const target = aliases[alias]
    if (known.has(target)) claim(normalizeModelId(alias), target)
  }
  return idx
}

/**
 * 把一条记录里的模型名解析成价格表 key。
 * @param {unknown} model
 * @param {Record<string, string>} index
 * @returns {string} 解析不到时返回 ''——调用方据此把费用记为 0，不做相似型号的近似匹配。
 */
export function resolveModelKey(model, index) {
  const raw = String(model == null ? '' : model).trim().toLowerCase()
  if (!raw) return ''
  if (index[raw] !== undefined) return index[raw]
  const norm = normalizeModelId(raw)
  if (norm && index[norm] !== undefined) return index[norm]
  return ''
}

/**
 * 按价格条目计算一次调用的费用（与币种无关，单位随价格表）。
 *
 * 三个计数互斥：cacheReadTokens 是命中缓存的输入，inputTokens 是未命中的输入，
 * 两者相加才是计费输入。把它们混为一谈（例如用 inputTokens 乘输入价再加缓存价）
 * 会重复计费。
 *
 * @param {{cacheReadTokens?: number, inputTokens?: number, outputTokens?: number}} counts
 * @param {{cacheHit: number, cacheMiss: number, output: number}} price
 * @returns {number}
 */
export function computeCost(counts, price) {
  const hit = Number(counts && counts.cacheReadTokens) || 0
  const miss = Number(counts && counts.inputTokens) || 0
  const out = Number(counts && counts.outputTokens) || 0
  return (hit * price.cacheHit + miss * price.cacheMiss + out * price.output) / 1e6
}

/**
 * 把 OpenRouter `/api/v1/models` 的响应体转成平价表。
 *
 * 价格字段是「每 token 美元」的字符串，乘 1e6 得到本表使用的「每百万 token」单价。
 * 缓存读价缺失或为 0 时退回未命中价：OpenRouter 对不支持缓存的模型也返回
 * input_cache_read，此时它是 0 而非「缓存免费」，直接采信会低估花费。
 * 价格缺失或不合法的条目跳过，不做猜测。
 *
 * @param {unknown} payload
 * @returns {{table: Record<string, {cacheHit: number, cacheMiss: number, output: number}>, scanned: number, skipped: number}}
 */
export function openRouterTable(payload) {
  const data = payload ? payload.data : null
  const models = Array.isArray(data) ? data : []
  const perM = (v) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return NaN
    // 每 token 的美元小数乘 1e6 会带出浮点误差：0.0000002 → 0.19999999999999998。
    // 四舍五入到 6 位小数（精确到 $0.000001/M）足够表达任何真实价格，同时让落盘的
    // 价格表可读、可逐字节比较。
    return Math.round(n * 1e12) / 1e6
  }
  const table = {}
  let skipped = 0
  for (const m of models) {
    const id = String((m && m.id) || '').trim().toLowerCase()
    if (!id) { skipped++; continue }
    const pr = (m && m.pricing) || {}
    const miss = perM(pr.prompt)
    const out = perM(pr.completion)
    if (!Number.isFinite(miss) || !Number.isFinite(out)) { skipped++; continue }
    const rawHit = perM(pr.input_cache_read)
    const hit = Number.isFinite(rawHit) && rawHit > 0 ? rawHit : miss
    table[id] = { cacheHit: hit, cacheMiss: miss, output: out }
  }
  return { table, scanned: models.length, skipped }
}

/**
 * 校验并过滤平价表条目。丢掉非法值（负数 / 非数字）与全零条目——全零多半是抓取
 * 错误，留着会让「有价格」的模型看起来正常工作却恒为 0。
 *
 * @param {unknown} table
 * @returns {Record<string, {cacheHit: number, cacheMiss: number, output: number}>}
 */
export function sanitizeTable(table) {
  const out = {}
  for (const id of Object.keys(table || {})) {
    const p = table[id]
    if (!p || typeof p !== 'object') continue
    const hit = Number(p.cacheHit), miss = Number(p.cacheMiss), o = Number(p.output)
    if (!(Number.isFinite(hit) && hit >= 0)) continue
    if (!(Number.isFinite(miss) && miss >= 0)) continue
    if (!(Number.isFinite(o) && o >= 0)) continue
    if (hit === 0 && miss === 0 && o === 0) continue
    out[id] = { cacheHit: hit, cacheMiss: miss, output: o }
  }
  return out
}
