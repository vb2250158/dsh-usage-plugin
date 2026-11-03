import assert from 'node:assert/strict'
export class EnvHttpProxyAgent {
 constructor(){globalThis.usageTransport.constructed++}
 async close(){globalThis.usageTransport.closed++}
}
export async function request(url,options){
 assert.equal(options.maxRedirections,undefined)
 assert.equal(options.headers.Authorization,'Bearer synthetic-key')
 assert.ok(options.dispatcher instanceof EnvHttpProxyAgent)
 assert.equal(url,'https://api.deepseek.com/user/balance')
 globalThis.usageTransport.requests.push({method:options.method,url})
 if(globalThis.usageTransport.fail)throw new Error('synthetic transport failure')
 return {statusCode:200,headers:{'content-type':'application/json'},body:{text:async()=>JSON.stringify({is_available:true,balance_infos:[{currency:'CNY',total_balance:'12',granted_balance:'2',topped_up_balance:'10'},{currency:'USD',total_balance:'3',granted_balance:'1',topped_up_balance:'2'}]})}}
}
