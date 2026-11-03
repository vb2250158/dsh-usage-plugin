/** Synthetic response keeps the real HTTP/price owner suspended until the test releases its body. */
export class EnvHttpProxyAgent {
 async close(){await globalThis.usageReview.bodyConsumed.promise;globalThis.usageReview.events.push('dispatcher-close-returned')}
}
export async function request(){
 globalThis.usageReview.requestEntered.resolve()
 await globalThis.usageReview.release.promise
 return {statusCode:200,headers:{'content-type':'application/json'},body:{text:async()=>{
  globalThis.usageReview.events.push('body-consumed');globalThis.usageReview.bodyConsumed.resolve()
  return JSON.stringify({data:[{id:'fixture/a',pricing:{prompt:'0.000002',completion:'0.000003',input_cache_read:'0.000001'}}]})
 }}}
}
