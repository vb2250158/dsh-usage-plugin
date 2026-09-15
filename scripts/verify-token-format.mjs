// 从改后的 client.js 里抠出 fmtTok，与官方 token-format.ts 的算法逐值对拍。
import { readFileSync } from 'node:fs'

const src = readFileSync('C:/Data/CottonProject/DSHPlugins/packages/dsh-usage-plugin/lib/client.js', 'utf8')
const m = src.match(/var fmtTok = (function \(n\) \{[\s\S]*?\n    \})/)
if (!m) throw new Error('fmtTok not found')
const fmtTok = eval('(' + m[1].trim().replace(/;$/, '') + ')')

// 官方 token-format.ts#formatTokens 的等价实现（照抄其算法）
const official = (value) => {
  const scaled = c => (c >= 100 ? String(Math.round(c)) : String(Math.round(c * 10) / 10))
  if (value < 1000) return String(value)
  if (value < 1000000) return scaled(value / 1000) + 'K'
  return scaled(value / 1000000) + 'M'
}

const cases = [0, 1, 517, 999, 1000, 1200, 12200, 41357, 100000, 517000, 999499, 999999,
  1000000, 2355681, 46400000, 46500000, 999999999, 1234567890]

let bad = 0
console.log('value'.padStart(12), '| plugin'.padStart(10), '| official'.padStart(10))
for (const v of cases) {
  const a = fmtTok(v), b = official(v)
  const ok = a === b
  if (!ok) bad++
  console.log(String(v).padStart(12), '|', a.padStart(10), '|', b.padStart(10), ok ? '' : '  <-- MISMATCH')
}
console.log(bad === 0 ? '\n✅ 与官方算法完全一致' : '\n❌ ' + bad + ' 处不一致')

console.log('\n截图实测：2,355,681 ->', fmtTok(2355681) + ' tok')
console.log('官方图例：46,500,000 ->', fmtTok(46500000) + ' tok')
console.log('边界：41357 ->', fmtTok(41357) + ' tok  (官方图例 41,357)')
