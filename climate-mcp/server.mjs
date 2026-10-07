import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import worker from './worker/index.js';
const onRender=process.env.RENDER==='true';
const host=process.env.AGROPREDICT_HOST||(onRender?'0.0.0.0':'127.0.0.1');
const port=Number(process.env.PORT||process.env.AGROPREDICT_PORT||8787);
const originSetting=process.env.AGROPREDICT_PUBLIC_ORIGIN||process.env.RENDER_EXTERNAL_URL;
const token=process.env.AGROPREDICT_MCP_TOKEN;
const publicDemo=process.env.AGROPREDICT_PUBLIC_DEMO==='true';
const isLocal=['127.0.0.1','localhost','::1'].includes(host);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port.');
if(token&&token.length<32)throw new Error('MCP token must be at least 32 characters.');
if(!isLocal&&(!originSetting||(!publicDemo&&!token)))throw new Error('Remote deployment requires an HTTPS origin and either explicit public demo mode or an MCP token.');
const configured=originSetting?new URL(originSetting):null;
if(configured&&configured.protocol!=='https:')throw new Error('Public origin must use HTTPS.');
const allowedHosts=configured?[configured.host]:['127.0.0.1:'+port,'localhost:'+port,'[::1]:'+port];
const equalToken=value=>{const a=Buffer.from(value||''),b=Buffer.from('Bearer '+token);return a.length===b.length&&timingSafeEqual(a,b);};
const visitors=new Map();let active=0;
const server=http.createServer(async(req,res)=>{
 try{
  if(!allowedHosts.includes(req.headers.host)){res.writeHead(403);res.end('Host is not allowed.');return;}
  const origin=configured?.origin||'http://'+req.headers.host;
  const url=new URL(req.url,origin);
  if(url.pathname==='/mcp'&&req.method==='GET'&&req.headers.accept?.includes('text/html')){res.writeHead(302,{Location:'/'});res.end();return;}
  if(url.pathname==='/mcp'&&token&&!equalToken(req.headers.authorization)){res.writeHead(401,{'WWW-Authenticate':'Bearer realm="agropredict"'});res.end('MCP API key required.');return;}
  if(url.pathname==='/mcp'&&req.method==='POST'){
   const ip=req.socket.remoteAddress||'unknown',now=Date.now(),state=visitors.get(ip);
   if(!state||now-state.start>=60000)visitors.set(ip,{start:now,count:1});else state.count++;
   if(visitors.size>1000)visitors.delete(visitors.keys().next().value);
   if(visitors.get(ip)?.count>30||active>=6){res.writeHead(429,{'Retry-After':'10'});res.end('Server busy.');return;}
  }
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413);res.end('Request too large.');return;}chunks.push(chunk);}
  active++;try{
   const request=new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
   const response=await worker.fetch(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }finally{active--;}
 }catch{if(!res.headersSent)res.writeHead(500);res.end('Request failed.');}
});
server.requestTimeout=65000;server.headersTimeout=10000;
server.listen(port,host,()=>console.log('AgroPredict listening on '+(configured?.origin||'http://'+host+':'+port)));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref();});
