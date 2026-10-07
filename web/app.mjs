import website from './worker/index.js';
import climate from './climate/worker/index.js';

const feedbackPaths=new Set(['/api/feedback','/api/analytics/events']);
export async function handleRequest(request,{DB,feedbackOrigin}={}) {
 const url=new URL(request.url);
 if(url.pathname==='/mcp'||url.pathname==='/demo-guide.json')return climate.fetch(request);
 if(url.pathname==='/climate-demo')return climate.fetch(new Request(new URL('/',url),request));
 if(url.pathname==='/health')return new Response(JSON.stringify({status:'ok',server:'agropredict-full-web',version:'27.0.0',feedback_storage:DB?.kind||(feedbackOrigin?'existing-site':'unavailable')}),{headers:{'Content-Type':'application/json'}});
 if(feedbackPaths.has(url.pathname)&&request.method==='POST'&&!DB&&feedbackOrigin) {
  const supplied=request.headers.get('origin');
  if(supplied&&supplied!==url.origin)return new Response('Origin not allowed',{status:403});
  const body=await request.text();
  if(body.length>4096)return new Response('Request too large',{status:413});
  const remote=new URL(url.pathname,feedbackOrigin);
  const response=await fetch(remote,{method:'POST',body,headers:{'Content-Type':'application/json',Origin:remote.origin},signal:AbortSignal.timeout(15000),redirect:'error'});
  return new Response(await response.arrayBuffer(),{status:response.status,headers:{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store'}});
 }
 return website.fetch(request,{DB});
}
