import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {Readable} from 'node:stream'
import {registerHooks} from 'node:module'
const root=process.argv[2]
assert.equal(path.dirname(root),os.tmpdir())
os.homedir=()=>path.join(root,'home')
const directory=path.join(process.env.DSH_USAGE_DATA_DIR,'dsh-usage')
await fs.mkdir(directory,{recursive:true})
await fs.writeFile(path.join(directory,'pricing.json'),JSON.stringify({base:{'fixture/a':{cacheHit:1,cacheMiss:1,output:1}},currency:'USD',meta:{source:'fixture',syncedAt:Date.now(),count:1}}))
const initial=Array.from({length:200},(_,index)=>({at:index,kind:'historical',label:'synthetic'+index,currency:'USD',table:{base:{'fixture/a':{cacheHit:1,cacheMiss:1,output:1}}}}))
const historyPath=path.join(directory,'pricing-history.json')
await fs.writeFile(historyPath,JSON.stringify(initial))
globalThis.usageReview={requestEntered:Promise.withResolvers(),release:Promise.withResolvers(),bodyConsumed:Promise.withResolvers(),events:[]}
const hook=registerHooks({resolve(name,context,next){return name==='undici'?{shortCircuit:true,url:new URL('./delayed-undici.mjs',import.meta.url).href}:next(name,context)}})
try {
 const {default:plugin}=await import('../lib/index.js')
 const {Context}=await import(process.env.DSH_USAGE_TEST_CORDIS ?? '@deepseek-ai/cordis')
 const context=new Context(),routes=new Map()
 context.provide('webServer',{register:route=>{routes.set(route.path,route.handler);return()=>routes.delete(route.path)}})
 const fiber=context.plugin(scope=>plugin.apply(scope));await fiber.await()
 const apiHandler=routes.get('/usage/api')
 async function request(body){let value;await apiHandler(Readable.from([JSON.stringify(body)]),{writeHead(){},end:text=>value=JSON.parse(text)});return value}
 assert.equal((await request({action:'list'})).ok,true)
 const pending=request({action:'syncPrices'})
 await usageReview.requestEntered.promise
 let finished=false
 const disposed=fiber.dispose().then(()=>{finished=true;usageReview.events.push('dispose-returned')})
 await Promise.resolve()
 assert.equal(finished,false,'Unload must wait for the admitted complete price-sync operation')
 usageReview.release.resolve()
 await disposed
 const bytes=await fs.readFile(historyPath),atDispose=JSON.parse(bytes),hash=createHash('sha256').update(bytes).digest('hex')
 const reply=await pending
 assert.equal(reply.ok,true)
 assert.equal(atDispose.length,200)
 assert.equal(atDispose.at(-1).kind,'sync','The final history write must finish before dispose returns')
 const denied=await request({action:'setPrices',prices:{'fixture/a':{cacheHit:9,cacheMiss:9,output:9}}})
 assert.equal(denied.ok,false);assert.match(denied.error,/unloading/)
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(createHash('sha256').update(await fs.readFile(historyPath)).digest('hex'),hash)
 assert(usageReview.events.indexOf('body-consumed')<usageReview.events.indexOf('dispatcher-close-returned'))
 assert(usageReview.events.indexOf('dispatcher-close-returned')<usageReview.events.indexOf('dispose-returned'))
 assert.equal(routes.size,0)
 await context.fiber.dispose()
 console.log(JSON.stringify({admittedSyncFinishedBeforeDispose:true,historyRows:200,afterDisposeWrites:false,newAdmissionsRejected:true}))
} finally { hook.deregister() }
