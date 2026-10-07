import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {handleRequest} from './app.mjs';
import {openDatabase} from './database.mjs';

const onRender=process.env.RENDER==='true';
const host=process.env.AGROPREDICT_HOST||(onRender?'0.0.0.0':'127.0.0.1');
const port=Number(process.env.PORT||process.env.AGROPREDICT_PORT||8787);
const originSetting=process.env.AGROPREDICT_PUBLIC_ORIGIN||process.env.RENDER_EXTERNAL_URL;
const token=process.env.AGROPREDICT_MCP_TOKEN;
const publicDemo=process.env.AGROPREDICT_PUBLIC_DEMO==='true';
const local=['127.0.0.1','localhost','::1'].includes(host);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port');
if(token&&token.length<32)throw new Error('MCP token must be at least 32 characters');
if(!local&&(!originSetting||(!publicDemo&&!token)))throw new Error('Remote deployment requires an HTTPS origin and an explicit MCP access mode');
const configured=originSetting?new URL(originSetting):null;
if(configured&&configured.protocol!=='https:')throw new Error('Public origin must use HTTPS');
const allowedHosts=configured?[configured.host]:['127.0.0.1:'+port,'localhost:'+port,'[::1]:'+port];
for(const candidate of (process.env.AGROPREDICT_ADDITIONAL_ORIGINS||'').split(',').filter(Boolean)){
 const u=new URL(candidate);if(u.protocol!=='https:'||u.pathname!=='/'||u.search||u.hash)throw new Error('Invalid additional origin');allowedHosts.push(u.host);
}
const feedbackOrigin=process.env.AGROPREDICT_FEEDBACK_ORIGIN;
if(feedbackOrigin&&(!/^https:\/\//.test(feedbackOrigin)||new URL(feedbackOrigin).origin!==feedbackOrigin))throw new Error('Feedback origin must be an exact HTTPS origin');
if(onRender&&process.env.AGROPREDICT_SQLITE_PATH)throw new Error('Use PostgreSQL on Render; local files are ephemeral');
const DB=await openDatabase({connectionString:process.env.DATABASE_URL,sqlitePath:local?(process.env.AGROPREDICT_SQLITE_PATH||'agropredict.local.sqlite'):undefined});
if(!local&&!DB&&!feedbackOrigin)throw new Error('Feedback requires a durable database or existing storage origin');
const visitors=new Map();let active=0;
const authorized=value=>{const a=Buffer.from(value||''),b=Buffer.from('Bearer '+token);return a.length===b.length&&timingSafeEqual(a,b);};
const server=http.createServer(async(req,res)=>{
 try{
  if(!allowedHosts.includes(req.headers.host)){res.writeHead(403);res.end('Host is not allowed');return;}
  const scheme=configured?'https:':'http:';
  const url=new URL(req.url,scheme+'//'+req.headers.host);
  if(url.pathname==='/mcp'&&req.method==='GET'&&req.headers.accept?.includes('text/html')){res.writeHead(302,{Location:'/'});res.end();return;}
  if(url.pathname==='/mcp'&&token&&!authorized(req.headers.authorization)){res.writeHead(401,{'WWW-Authenticate':'Bearer realm="agropredict"'});res.end('MCP API key required');return;}
  if(req.method==='POST'){
   const ip=req.socket.remoteAddress||'unknown',now=Date.now(),prior=visitors.get(ip);
   const state=!prior||now-prior.start>=60000?{start:now,count:1}:prior;if(state===prior)state.count++;visitors.set(ip,state);
   if(visitors.size>1000)visitors.delete(visitors.keys().next().value);
   if(state.count>60||active>=12){res.writeHead(429,{'Retry-After':'10'});res.end('Server busy');return;}
  }
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413);res.end('Request too large');return;}chunks.push(chunk);}
  active++;try{
   const headers=new Headers(req.headers);headers.delete('cf-connecting-ip');headers.set('cf-connecting-ip',req.socket.remoteAddress||'unknown');
   const request=new Request(url,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
   const response=await handleRequest(request,{DB,feedbackOrigin});
   res.writeHead(response.status,{...Object.fromEntries(response.headers),'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});
   res.end(req.method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));
  }finally{active--;}
 }catch{console.error('request-failed');if(!res.headersSent)res.writeHead(502);res.end('Request failed');}
});
server.requestTimeout=65000;server.headersTimeout=10000;
server.listen(port,host,()=>console.log('AgroPredict full site listening on '+(configured?.origin||'http://'+host+':'+port)));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(async()=>{await DB?.close();process.exit(0);});setTimeout(()=>process.exit(0),5000).unref();});
