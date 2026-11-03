import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { registerHooks } from 'node:module'

// Exercise the shipped HTTP/credential owners with a synthetic transport; no real account or network.
globalThis.usageTransport = { requests: [], constructed: 0, closed: 0, fail: false }
const hooks=registerHooks({ resolve(name, context, next) {
  if(name==='undici') return { shortCircuit:true, url:new URL('./undici-transport.mjs',import.meta.url).href }
  return next(name,context)
} })
const { default: plugin }=await import('../lib/index.js')
const root=process.argv[2]
assert.equal(path.dirname(root),os.tmpdir())
os.homedir=()=>path.join(root,'home')
const directory=path.join(process.env.DSH_USAGE_DATA_DIR,'dsh-usage')
await fs.mkdir(directory,{recursive:true})
await fs.writeFile(path.join(directory,'pricing.json'),JSON.stringify({base:{a:{cacheHit:1,cacheMiss:2,output:3},b:{cacheHit:10,cacheMiss:20,output:30}},currency:'USD',meta:{source:'fixture',syncedAt:Date.now(),count:2}}))
const listeners=new Map(),routes=new Map()
plugin.apply({
 on(name,listener){listeners.set(name,listener);return()=>listeners.delete(name)},
 get(name){return name==='webServer'?{register:route=>routes.set(route.path,route.handler)}:name==='credentials'?{resolve:async()=>({value:'synthetic-key',source:'fixture'})}:undefined},
})
async function api(body){let value;await routes.get('/usage/api')(Readable.from([JSON.stringify(body)]),{writeHead(){},end:text=>{value=JSON.parse(text)}});assert.equal(value.ok,true,JSON.stringify(value));return value}
const row={time:1000,model:'route-model',provider:'fixture',inputTokens:2,outputTokens:3,cacheReadTokens:1,cacheWriteTokens:0,reasoningTokens:0,finishReason:'stop'}
const initial=await api({action:'list'})
await api({action:'setAliases',aliases:{'route-model':'a'}})
const imported=await api({action:'import',content:JSON.stringify([row])});assert.equal(imported.imported,1)
const one=await api({action:'list'}),stat=await api({action:'stat'})
assert.equal(one.revision,stat.revision);assert.ok(stat.revision>initial.revision)
assert.equal(one.records[0].autoCost,14/1e6)
const unchanged=await api({action:'stat'});assert.deepEqual(unchanged,stat)
await api({action:'clear'});await api({action:'import',content:JSON.stringify([{...row,inputTokens:20}])})
const replaced=await api({action:'list'})
assert.equal(replaced.count,one.count);assert.equal(replaced.records[0].time,one.records[0].time)
assert.ok(replaced.revision>one.revision);assert.equal(replaced.records[0].autoCost,50/1e6)
await api({action:'setAliases',aliases:{'route-model':'b'}})
const alias=await api({action:'list'});assert.equal(alias.records[0].autoCost,500/1e6)
assert.ok(alias.pricingVersion>replaced.pricingVersion)
await api({action:'setBudget',monthly:123})
const budget=await api({action:'list'});assert.equal(budget.budget.monthly,123);assert.ok(budget.revision>alias.revision)
await api({action:'setCurrency',currency:'CNY'})
const currency=await api({action:'list'});assert.equal(currency.currency,'CNY');assert.ok(currency.revision>budget.revision)
await api({action:'setCurrency',currency:'USD'})
await api({action:'clear'})
await api({action:'import',content:JSON.stringify([{...row,unit:{hit:1,miss:2,out:3,write:4,currency:'USD'}}])})
const captured=await api({action:'list'})
await api({action:'setPrices',prices:{b:{cacheHit:100,cacheMiss:200,output:300}}})
const after=await api({action:'list'});assert.equal(after.records[0].autoCost,captured.records[0].autoCost)
assert.equal(after.days[0].autoCost,after.records[0].autoCost)
assert.ok(after.pricingHistory.length>=2);assert.equal(after.pricingHistory.at(-1).kind,'edit')
assert.equal(after.pricingHistory.at(-1).currency,'USD')
await api({action:'repriceAll'})
const repriced=await api({action:'list'});assert.equal(repriced.records[0].autoCost,1400/1e6);assert.ok(repriced.revision>after.revision)
const balances=await Promise.all([api({action:'balance',provider:'deepseek'}),api({action:'balance',provider:'deepseek'})])
assert.equal(balances[0].infos.length,2);assert.equal(balances[0].multiCurrency,true);assert.equal(globalThis.usageTransport.constructed,1)
assert.equal(globalThis.usageTransport.requests.length,2)
globalThis.usageTransport.fail=true
let errorReply
await routes.get('/usage/api')(Readable.from([JSON.stringify({action:'balance',provider:'deepseek'})]),{writeHead(){},end:text=>errorReply=JSON.parse(text)})
assert.equal(errorReply.ok,false);assert.match(errorReply.error,/synthetic transport failure/)
assert.equal(globalThis.usageTransport.requests.length,3,'failed direct request must not replay in a subprocess')
for(let i=0;i<202;i++)await api({action:'setPrices',prices:{b:{cacheHit:100+i,cacheMiss:200+i,output:300+i}}})
const history=await api({action:'list'})
assert.equal(history.pricingHistory.length,200)
assert.equal(history.pricingHistory.at(-1).table.base.b.cacheMiss,401)
await listeners.get('dispose')();assert.equal(globalThis.usageTransport.closed,1)
const persisted=JSON.parse(await fs.readFile(path.join(directory,'pricing-history.json'),'utf8'))
assert.equal(persisted.length,200);assert.deepEqual(persisted,history.pricingHistory)
hooks.deregister()
console.log(JSON.stringify({revisionLifecycle:true,equalCountReplacement:true,aliasInvalidation:true,capturedPricesRetained:true,explicitReprice:true,multiCurrency:true,dispatcherSharedAndClosed:true,noFailureReplay:true}))
