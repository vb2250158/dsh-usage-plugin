import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

test('revision polling and pricing cache stay current across equal-count edits and HTTP lifecycle',{timeout:30000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-usage-incremental-'))
 const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../test-support/host-incremental.mjs',import.meta.url)),root],{cwd:root,timeout:25000,windowsHide:true,env:{...process.env,USERPROFILE:path.join(root,'home'),LOCALAPPDATA:path.join(root,'Local'),APPDATA:path.join(root,'Roaming'),DSH_USAGE_DATA_DIR:path.join(root,'data')}})
 assert.deepEqual(JSON.parse(stdout),{revisionLifecycle:true,equalCountReplacement:true,aliasInvalidation:true,capturedPricesRetained:true,explicitReprice:true,multiCurrency:true,dispatcherSharedAndClosed:true,noFailureReplay:true})
})

test('the mounted panel skips hidden/stable polls and reloads once for a new owner revision',async()=>{
 const actions=[],effects=[];let poll,revision=4,instanceId='synthetic-host-a',captured
 const actualNow=Date.now;let clock=Date.parse('2026-11-03T01:30:00Z');Date.now=()=>clock
 try {
 const React={createElement:(type,props,...children)=>({type,props,children}),useState:v=>[typeof v==='function'?v():v,()=>{}],useRef:v=>({current:v}),useMemo:fn=>fn(),useCallback:fn=>fn,useEffect:fn=>effects.push(fn),useId:()=>':fixture:'}
 globalThis.window={__ModuleLoader__:{load:d=>captured=d},localStorage:{getItem:()=>null,setItem(){}}}
 globalThis.document={visibilityState:'visible'}
 Object.defineProperty(globalThis,'navigator',{value:{language:'zh-CN'},configurable:true,writable:true})
 globalThis.fetch=async(url,options)=>{assert.equal(url,'/usage/api');const action=JSON.parse(options.body).action;actions.push(action);return {json:async()=>action==='stat'?{ok:true,revision,instanceId}:{ok:true,revision,instanceId,currency:'USD',records:[],count:0,days:[],priceModels:[]}}}
 await import(pathToFileURL(fileURLToPath(new URL('../lib/client.js',import.meta.url))).href+'?incremental')
 const exports=captured.factory(name=>name==='react'?React:{})
 exports.__views.UsagePanel({active:true,timer:{interval:fn=>{poll=fn;return()=>{}}}})
 for(const effect of effects)effect()
 await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(actions,['list'])
 await poll();assert.deepEqual(actions,['list','stat'])
 revision++;await poll();assert.deepEqual(actions,['list','stat','stat','list'])
 document.visibilityState='hidden';await poll();assert.equal(actions.length,4)
 document.visibilityState='visible';await poll();assert.deepEqual(actions,['list','stat','stat','list','stat'])
 clock+=86400000;await poll();assert.deepEqual(actions.slice(-2),['stat','list'])
 await poll();assert.equal(actions.at(-1),'stat')
 instanceId='synthetic-host-b';await poll();assert.deepEqual(actions.slice(-2),['stat','list'])
 } finally { Date.now=actualNow }
})
