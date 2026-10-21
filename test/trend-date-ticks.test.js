import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let captured
const window = { __ModuleLoader__: { load(value) { captured = value } } }
new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(window)
const ticks = captured.factory(name => {
  if (name === 'react') return { createElement() {} }
  throw new Error('Unexpected module ' + name)
}).__trendDateTicks

function series(length) {
  return Array.from({ length }, (_, i) => ({ key: new Date(Date.UTC(2026, 9, 7) - (length - 1 - i) * 86400000).toISOString().slice(0, 10) }))
}
function layout(length, width, measure = text => text.length * 7) {
  const gap = width / length
  return ticks(series(length), 54, gap, gap * .7, 54, 54 + width, measure)
}
function separated(labels, width) {
  for (let i = 0; i < labels.length; i++) {
    assert.ok(labels[i].left >= 54)
    assert.ok(labels[i].right <= 54 + width)
    if (i > 0) assert.ok(labels[i].left - labels[i - 1].right >= 8)
  }
}

test('reserves October 7 instead of overlapping October 6 at the thirty-day right edge', () => {
  const labels = layout(30, 360)
  assert.equal(labels[0].text, '9/8')
  assert.equal(labels.at(-1).text, '10/7')
  assert.ok(!labels.some(label => label.text === '10/6'))
  separated(labels, 360)
})

test('keeps dates separated for seven, thirty and ninety days across chart widths and font scales', () => {
  for (const length of [7, 30, 90]) for (const width of [120, 216, 360, 560, 880]) for (const scale of [5, 7, 10]) {
    const labels = layout(length, width, text => text.length * scale)
    separated(labels, width)
    assert.equal(labels.at(-1).index, length - 1)
    assert.equal(labels[0].index, 0)
  }
})

test('uses measured variable widths and reduces dates when both endpoints cannot fit', () => {
  const labels = layout(90, 216, text => text.startsWith('10') ? 51 : 21)
  separated(labels, 216)
  assert.equal(labels.at(-1).text, '10/7')
  const tight = layout(7, 60, () => 35)
  assert.deepEqual(tight.map(label => label.index), [6])
  separated(tight, 60)
})

test('handles a single date and an empty series', () => {
  assert.equal(layout(1, 120).length, 1)
  assert.deepEqual(ticks([], 0, 1, 1, 0, 120, () => 20), [])
})
