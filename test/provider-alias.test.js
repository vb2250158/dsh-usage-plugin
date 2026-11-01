import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPriceIndex, isDeepseekProvider, resolveRecordModelKey } from '../lib/pricing.js'

// 复现 upstream issue #19：桌面端官方账号的 provider id 是 `deepseek-account`。
// 价格表里同一型号还有转售条目时，只按型号末段匹配会把官方调用记成转售价。

test('isDeepseekProvider recognizes every deepseek-* provider id', () => {
  for (const id of ['deepseek', 'deepseek-official', 'deepseek-account', ' DeepSeek-Account ']) {
    assert.equal(isDeepseekProvider(id), true, id)
  }
  for (const id of ['', null, 'siliconflow', 'digitalocean', 'mydeepseek', 'deepseekx']) {
    assert.equal(isDeepseekProvider(id), false, String(id))
  }
})

test('deepseek-account records price against the official deepseek/ entry', () => {
  // 转售条目先登记，末段 deepseek-v4-flash 被它占住。
  const index = buildPriceIndex(['chutes/deepseek-v4-flash', 'deepseek/deepseek-v4-flash'])
  assert.equal(resolveRecordModelKey('deepseek-v4-flash', 'deepseek-account', index), 'deepseek/deepseek-v4-flash')
  assert.equal(resolveRecordModelKey('deepseek-v4-flash', 'deepseek-official', index), 'deepseek/deepseek-v4-flash')
  // 非 DeepSeek 通道保持原通用匹配，显式带前缀的模型名也不被改写。
  assert.equal(resolveRecordModelKey('deepseek-v4-flash', 'siliconflow', index), 'chutes/deepseek-v4-flash')
  assert.equal(resolveRecordModelKey('chutes/deepseek-v4-flash', 'deepseek-account', index), 'chutes/deepseek-v4-flash')
  // 官方条目不存在时回落到通用匹配，不返回空。
  assert.equal(resolveRecordModelKey('deepseek-v4-flash', 'deepseek-account', buildPriceIndex(['chutes/deepseek-v4-flash'])), 'chutes/deepseek-v4-flash')
})
