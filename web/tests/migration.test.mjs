import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {handleRequest} from '../app.mjs';
import {openDatabase} from '../database.mjs';
import {DatabaseSync} from 'node:sqlite';

const routes=['/','/index.html','/analysis','/tools','/tools/climate','/tools/soil','/tools/growing-season','/tools/rainfall','/tools/economics','/tools/compare-crops','/tools/crop-reference','/about','/research'];
const origin='https://agropredict.test';
for(const path of routes){const r=await handleRequest(new Request(origin+path));assert.equal(r.status,200,path);assert.match(await r.text(),/AgroPredict — Crop/);}
const source=await readFile(new URL('../source/index.html',import.meta.url),'utf8');
for(const m of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);
assert.equal((await handleRequest(new Request(origin+'/agropredict-core-v26-beta.js'))).status,200);
assert.equal((await handleRequest(new Request(origin+'/climate-demo'))).status,200);
assert.equal((await handleRequest(new Request(origin+'/missing'))).status,404);
assert.equal((await handleRequest(new Request(origin+'/api/soil-ph?lat=999&lon=32'))).status,400);
let r=await handleRequest(new Request(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}));
assert.equal(r.status,200);assert.equal((await r.json()).result.tools.length,2);

const temp=await mkdtemp(join(tmpdir(),'agropredict-migration-'));const path=join(temp,'data.sqlite');
const DB=await openDatabase({sqlitePath:path});
const post=(path,data,suppliedOrigin=origin)=>handleRequest(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:suppliedOrigin},body:JSON.stringify(data)}),{DB});
r=await post('/api/feedback',{usefulness:'yes',visitorType:'farmer',comment:'Migration verification',page:'/analysis'});assert.equal(r.status,201);
const saved=(await r.json());assert.equal(saved.status,'ok');
r=await post('/api/analytics/events',{event:'analysis_completed',page:'/analysis',country:'UA',crop:'maize',scoreBand:'75-89'});assert.equal(r.status,204);
r=await post('/api/feedback',{usefulness:'yes',visitorType:'farmer'},'https://other.example');assert.equal(r.status,403);
await DB.close();
const persisted=new DatabaseSync(path);assert.equal(persisted.prepare('SELECT COUNT(*) AS n FROM analysis_feedback').get().n,1);assert.equal(persisted.prepare('SELECT COUNT(*) AS n FROM analytics_events').get().n,2);persisted.close();
const reopened=await openDatabase({sqlitePath:path});
await assert.rejects(reopened.batch([reopened.prepare('INSERT INTO analytics_events (id,event_name,page_path) VALUES (?,?,?)').bind('rollback','page_view','/'),reopened.prepare('INSERT INTO non_existent (id) VALUES (?)').bind('bad')]));
await reopened.close();const check=new DatabaseSync(path);assert.equal(check.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE id='rollback'").get().n,0);check.close();

const realFetch=globalThis.fetch;let forwarded=false;
globalThis.fetch=async (url,options)=>{assert.equal(String(url),'https://agropredict.app/api/feedback');assert.equal(options.headers.Origin,'https://agropredict.app');assert.equal(options.redirect,'error');forwarded=true;return new Response('{"status":"ok"}',{status:201});};
try{
 r=await handleRequest(new Request(origin+'/api/feedback',{method:'POST',headers:{Origin:origin},body:'{}'}),{feedbackOrigin:'https://agropredict.app'});assert.equal(r.status,201);assert.ok(forwarded);
 forwarded=false;r=await handleRequest(new Request(origin+'/api/feedback',{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'}),{feedbackOrigin:'https://agropredict.app'});assert.equal(r.status,403);assert.equal(forwarded,false);
}finally{globalThis.fetch=realFetch;await rm(temp,{recursive:true,force:true});}
console.log('PASS: all website routes, scripts, MCP discovery, stored feedback, transactional rollback and staged storage forwarding.');
