const VERSION = '0.2.0';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const PARAMS = ['T2M', 'PRECTOTCORR', 'RH2M'];
const DAY = 86400000;
const cache = new Map();
const inFlight = new Map();
const limitations = [
  'NASA POWER meteorological data describe a modelled grid cell, not an on-farm measurement.',
  'Historical comparison is descriptive; it is not a forecast, yield prediction, crop stress diagnosis or agronomic recommendation.',
  'Coordinates and any farm reference are supplied by the caller. FarmID identity and permissions are not verified by this demo.',
  'Do not submit confidential farm information to this test service.'
];
const common = {
  latitude: {type:'number',minimum:-90,maximum:90,description:'Caller-supplied latitude. Use public or authorised demo coordinates.'},
  longitude: {type:'number',minimum:-180,maximum:180},
  start_date: {type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'UTC date, YYYY-MM-DD. Earliest 1981-01-01.'},
  end_date: {type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'Inclusive UTC date; at most 92 days, within one calendar year, before today.'},
  farm_reference: {type:'string',maxLength:80,description:'Optional opaque caller reference, echoed only. This is not a verified FarmID.'}
};
const tools = [
  {name:'get_climate_summary',title:'NASA POWER climate summary',description:'Fetch actual historical daily temperature, precipitation and relative humidity for public or authorised coordinates. Returns summaries, daily values, per-parameter coverage and source provenance. Missing data remain missing.',inputSchema:{type:'object',properties:common,required:['latitude','longitude','start_date','end_date'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
  {name:'compare_climate_history',title:'Compare climate with past years',description:'Compare the supplied historical window against identical month/day windows in 3–5 distinct earlier years. Temperature delta in C, precipitation total delta in percent, humidity delta in percentage points. Requires complete coverage for each parameter in all periods; otherwise that comparison is unavailable. Feb 29 is excluded from every window. Not a standard 30-year climatological normal or crop-risk assessment.',inputSchema:{type:'object',properties:{...common,baseline_years:{type:'array',items:{type:'integer',minimum:1981},minItems:3,maxItems:5,uniqueItems:true,description:'Explicit comparison years, all earlier than target year. This short reference is not a climatological normal.'}},required:['latitude','longitude','start_date','end_date','baseline_years'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}}
];
function json(value,status=200,extra={}) { return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra}}); }
function date(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Dates must be YYYY-MM-DD.');
  const d = new Date(value+'T00:00:00Z');
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value) throw new Error('Invalid calendar date.');
  return d;
}
function validate(a,anomaly=false) {
  if(!a||typeof a!=='object'||Array.isArray(a)) throw new Error('Arguments must be an object.');
  const permitted=[...Object.keys(common),...(anomaly?['baseline_years']:[])];
  if(Object.keys(a).some(k=>!permitted.includes(k))) throw new Error('Unexpected argument.');
  if(typeof a.latitude!=='number'||!Number.isFinite(a.latitude)||Math.abs(a.latitude)>90||typeof a.longitude!=='number'||!Number.isFinite(a.longitude)||Math.abs(a.longitude)>180) throw new Error('Latitude/longitude are outside their valid ranges.');
  if(a.farm_reference!==undefined&&(typeof a.farm_reference!=='string'||a.farm_reference.length>80||/[\x00-\x1f]/.test(a.farm_reference))) throw new Error('farm_reference must be a short opaque reference.');
  const start=date(a.start_date),end=date(a.end_date);
  const days=(end-start)/DAY+1;
  if(start.getUTCFullYear()<1981||days<1||days>92||start.getUTCFullYear()!==end.getUTCFullYear()) throw new Error('Select 1–92 days in a single year, from 1981 onward.');
  if(end.getTime()>=Date.parse(new Date().toISOString().slice(0,10))) throw new Error('Only completed historical days are supported.');
  if(anomaly) {
    const ys=a.baseline_years;
    if(!Array.isArray(ys)||ys.length<3||ys.length>5||new Set(ys).size!==ys.length||ys.some(y=>!Number.isInteger(y)||y<1981||y>=start.getUTCFullYear())) throw new Error('Provide 3–5 distinct baseline years from 1981, all before the target year.');
    if(a.start_date.endsWith('02-29')||a.end_date.endsWith('02-29')) throw new Error('For comparisons, use a boundary other than February 29. February 29 is excluded from all windows.');
  }
  return {start,end,days};
}
function keys(start,end,excludeLeap=false) {
  const out=[];
  for(let t=start.getTime();t<=end.getTime();t+=DAY) {
    const iso=new Date(t).toISOString().slice(0,10);
    if(!excludeLeap||!iso.endsWith('02-29')) out.push(iso.replaceAll('-',''));
  }
  return out;
}
const round = n=>Number(n.toFixed(6));
function summarise(raw,a,excludeLeap=false) {
  const ds=keys(date(a.start_date),date(a.end_date),excludeLeap);
  if(!ds.length) throw new Error('No comparable days in window.');
  const result={};
  const daily={};
  for(const p of PARAMS) {
    const source=raw.properties?.parameter?.[p];
    if(!source||typeof source!=='object') throw new Error('NASA response is missing a required parameter.');
    const unit=raw.parameters?.[p]?.units;
    if(unit!==({T2M:'C',PRECTOTCORR:'mm/day',RH2M:'%'})[p]) throw new Error('NASA response has unexpected parameter units.');
    const values=ds.map(k=>source[k]).filter(v=>typeof v==='number'&&Number.isFinite(v)&&v!==raw.header.fill_value&&v!==-999);
    const sum=values.reduce((s,v)=>s+v,0);
    result[p]={units:unit,expected_days:ds.length,valid_days:values.length,coverage_percent:round(100*values.length/ds.length),mean:values.length?round(sum/values.length):null,...(p==='PRECTOTCORR'?{observed_total_mm:values.length?round(sum):null,total_complete:values.length===ds.length}: {})};
    daily[p]=Object.fromEntries(ds.map(k=>[k,(typeof source[k]==='number'&&Number.isFinite(source[k])&&source[k]!==raw.header.fill_value&&source[k]!==-999)?source[k]:null]));
  }
  return {parameters:result,daily};
}
async function nasa(a) {
  const url=new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
  const query={parameters:PARAMS.join(','),community:'AG',latitude:String(a.latitude),longitude:String(a.longitude),start:a.start_date.replaceAll('-',''),end:a.end_date.replaceAll('-',''),format:'JSON','time-standard':'UTC'};
  for(const [k,v] of Object.entries(query)) url.searchParams.set(k,v);
  const key=url.toString();
  const hit=cache.get(key);
  if(hit&&Date.now()-hit.at<3600000) return hit.data;
  if(inFlight.has(key)) return inFlight.get(key);
  const task=(async()=>{
    const response=await fetch(key,{signal:AbortSignal.timeout(20000),headers:{Accept:'application/json'}});
    if(!response.ok) throw new Error('NASA POWER upstream returned HTTP '+response.status+'. Retry later.');
    const text=await response.text();
    if(text.length>2000000) throw new Error('NASA response exceeded size limit.');
    let raw;
    try {raw=JSON.parse(text);} catch {throw new Error('NASA POWER returned an invalid JSON response.');}
    if(raw.header?.time_standard!=='UTC'||!raw.properties?.parameter) throw new Error('NASA POWER returned an unexpected data structure or time standard.');
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');
    const data={raw,provenance:{provider:'NASA POWER',request_url:key,retrieved_at:new Date().toISOString(),response_sha256:hash,time_standard:raw.header.time_standard,api_version:raw.header.api?.version,sources:raw.header.sources,fill_value:raw.header.fill_value,requested_coordinates:{latitude:a.latitude,longitude:a.longitude},returned_coordinates:raw.geometry?.coordinates,data_kind:'modelled grid-cell meteorology'}};
    cache.set(key,{at:Date.now(),data});
    while(cache.size>32) cache.delete(cache.keys().next().value);
    return data;
  })();
  inFlight.set(key,task);
  try{return await task;}finally{inFlight.delete(key);}
}
async function runTool(name,a) {
  validate(a,name==='compare_climate_history');
  const context={...(a.farm_reference?{caller_farm_reference:a.farm_reference}:{}),identity_verification:'not performed',farmid_integration:'not connected',latitude:a.latitude,longitude:a.longitude};
  if(name==='get_climate_summary') {
    const data=await nasa(a);
    return {status:'ok',context,period:{start_date:a.start_date,end_date:a.end_date,inclusive:true},...summarise(data.raw,a),provenance:data.provenance,limitations};
  }
  const periods=[a,...a.baseline_years.map(y=>({...a,start_date:y+a.start_date.slice(4),end_date:y+a.end_date.slice(4)}))];
  const fetched=[];
  // Bound upstream parallelism to three requests.
  for(let i=0;i<periods.length;i+=3) fetched.push(...await Promise.all(periods.slice(i,i+3).map(nasa)));
  const summaries=fetched.map((d,i)=>summarise(d.raw,periods[i],true));
  const comparisons={};
  for(const p of PARAMS) {
    const all=summaries.map(s=>s.parameters[p]);
    if(all.some(s=>s.valid_days!==s.expected_days)) {
      comparisons[p]={status:'unavailable',reason:'Complete daily coverage is required in target and all baseline periods.'};continue;
    }
    const vals=all.map(s=>p==='PRECTOTCORR'?s.observed_total_mm:s.mean);
    const baseline=vals.slice(1).reduce((s,v)=>s+v,0)/a.baseline_years.length;
    const delta=vals[0]-baseline;
    comparisons[p]={status:'ok',target:vals[0],baseline_mean:round(baseline),absolute_delta:round(delta),delta_units:p==='T2M'?'C':p==='RH2M'?'percentage points':'mm',...(p==='PRECTOTCORR'?{relative_delta_percent:baseline===0?null:round(100*delta/baseline),relative_delta_status:baseline===0?'undefined: zero baseline':'ok'}:{})};
  }
  return {status:Object.values(comparisons).every(c=>c.status==='ok')?'ok':'partial',context,method:{reference:'User-selected short historical reference, not a 30-year climatological normal',comparison:'Same UTC calendar month/day window in each earlier year',baseline_years:a.baseline_years,leap_day:'February 29 excluded from every window',aggregation:'Equal-weight mean of complete yearly windows',missing_data:'No interpolation; comparison unavailable for any parameter with incomplete coverage'},target:{period:{start_date:a.start_date,end_date:a.end_date},parameters:summaries[0].parameters},baseline:periods.slice(1).map((period,i)=>({year:a.baseline_years[i],start_date:period.start_date,end_date:period.end_date,parameters:summaries[i+1].parameters})),comparisons,provenance:fetched.map(d=>d.provenance),limitations};
}
const example={latitude:49,longitude:32,start_date:'2024-09-01',end_date:'2024-09-07',baseline_years:[2021,2022,2023],farm_reference:'AP-DEMO-UA-001'};
const resource={uri:'agropredict://demo-guide',name:'AgroPredict demo guide',mimeType:'application/json',description:'Public sample context, limits and example tool calls. No actual farm records.'};
function guide(){return {server:'AgroPredict Climate MCP',version:VERSION,transport:'Streamable HTTP (JSON responses)',protocol_versions:PROTOCOLS,authentication:'No ChatGPT account or OAuth required. The operator may enable a separate MCP API key. No NASA key needed.',tools:tools.map(t=>({name:t.name,description:t.description})),example:{tool:'compare_climate_history',arguments:example},sample_context:'Illustrative public coordinate in Ukraine; not an identified or verified farm.',limits:{max_days:92,baseline_years:'3–5',historical_only:true},limitations,sources:['https://power.larc.nasa.gov/docs/services/api/temporal/daily/','https://modelcontextprotocol.io/specification/2025-11-25/basic/transports']};}
function error(id,code,message,status=200){return json({jsonrpc:'2.0',id,error:{code,message}},status);}
async function mcp(request) {
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin) return error(null,-32600,'Origin is not allowed.',403);
  if(request.method!=='POST') return new Response(null,{status:405,headers:{Allow:'POST'}});
  const protocol=request.headers.get('mcp-protocol-version');
  if(protocol&&!PROTOCOLS.includes(protocol)) return error(null,-32600,'Unsupported protocol version. Supported: '+PROTOCOLS.join(', '),400);
  if(!request.headers.get('content-type')?.includes('application/json')) return error(null,-32600,'Content-Type must be application/json.',415);
  const accept=request.headers.get('accept')||'';
  if(!accept.includes('application/json')||!accept.includes('text/event-stream')) return error(null,-32600,'Accept must include application/json and text/event-stream.',406);
  if(Number(request.headers.get('content-length')||0)>16384) return error(null,-32600,'Request too large.',413);
  let rpc;
  try{const body=await request.text();if(body.length>16384)return error(null,-32600,'Request too large.',413);rpc=JSON.parse(body);}catch{return error(null,-32700,'Invalid JSON.',400);}
  if(!rpc||Array.isArray(rpc)||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string'||(rpc.id!==undefined&&typeof rpc.id!=='string'&&typeof rpc.id!=='number')||(rpc.params!==undefined&&(!rpc.params||typeof rpc.params!=='object'||Array.isArray(rpc.params)))) return error(null,-32600,'Invalid JSON-RPC request.',400);
  if(rpc.id===undefined) return new Response(null,{status:202});
  let result;
  const p=rpc.params||{};
  switch(rpc.method) {
    case 'initialize':
      if(typeof p.protocolVersion!=='string'||!p.clientInfo||!p.capabilities) return error(rpc.id,-32602,'Initialization needs protocolVersion, clientInfo and capabilities.');
      result={protocolVersion:PROTOCOLS.includes(p.protocolVersion)?p.protocolVersion:PROTOCOLS[0],serverInfo:{name:'agropredict-climate-mcp',version:VERSION},capabilities:{tools:{listChanged:false},resources:{subscribe:false,listChanged:false}},instructions:'Read-only climate demo. Public or authorised coordinates only. No verified FarmID integration. Do not infer crop risk or issue farming recommendations from these descriptive climate comparisons.'};break;
    case 'ping':result={};break;
    case 'tools/list':result={tools};break;
    case 'resources/list':result={resources:[resource]};break;
    case 'resources/templates/list':result={resourceTemplates:[]};break;
    case 'resources/read':
      if(p.uri!==resource.uri) return error(rpc.id,-32002,'Resource not found.');
      result={contents:[{uri:resource.uri,mimeType:resource.mimeType,text:JSON.stringify(guide(),null,2)}]};break;
    case 'tools/call':
      if(!tools.some(t=>t.name===p.name)) return error(rpc.id,-32602,'Unknown tool.');
      try {const output=await runTool(p.name,p.arguments);result={content:[{type:'text',text:JSON.stringify(output)}],structuredContent:output,isError:false};}
      catch(e){result={content:[{type:'text',text:JSON.stringify({status:'error',message:e.name==='TimeoutError'?'NASA POWER request timed out. Retry later.':e.message})}],isError:true};}
      break;
    default:return error(rpc.id,-32601,'Method not found.');
  }
  return json({jsonrpc:'2.0',id:rpc.id,result});
}
import page from '../page.js';
export default {async fetch(request,env,ctx) {
  const path=new URL(request.url).pathname;
  if(path==='/mcp') return mcp(request);
  if(request.method!=='GET'&&request.method!=='HEAD')return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
  if(path==='/health')return json({status:'ok',server:'agropredict-climate-mcp',version:VERSION,checks:'process health only; NASA availability not checked'});
  if(path==='/demo-guide.json')return json(guide());
  if(path==='/')return new Response(request.method==='HEAD'?null:page,{headers:{'content-type':'text/html; charset=utf-8','x-content-type-options':'nosniff','referrer-policy':'no-referrer','cache-control':'no-store'}});
  return new Response('Not found',{status:404});
}};
export {summarise,validate,runTool,tools,guide};