import {readFile} from 'node:fs/promises';
import {openDatabase} from '../database.mjs';
if(!process.env.DATABASE_URL&&!process.env.AGROPREDICT_SQLITE_PATH)throw new Error('Choose a durable target database before importing');
const DB=await openDatabase({connectionString:process.env.DATABASE_URL,sqlitePath:process.env.AGROPREDICT_SQLITE_PATH});
const data=JSON.parse(await readFile(process.argv[2],'utf8'));
try{
 for(const [table,columns] of Object.entries({
  analysis_feedback:['id','usefulness','visitor_type','comment','page_path','country_code','crop_key','score_band','created_at'],
  analytics_events:['id','event_name','event_label','page_path','country_code','crop_key','score_band','created_at']
 })){
  const rows=data[table];if(!Array.isArray(rows))throw new Error('Missing table '+table);
  const sql=`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')}) ON CONFLICT (id) DO NOTHING`;
  for(let offset=0;offset<rows.length;offset+=50)await DB.batch(rows.slice(offset,offset+50).map(row=>DB.prepare(sql).bind(...columns.map(key=>row[key]??null))));
  console.log(table+': imported '+rows.length+' source rows; existing IDs preserved');
 }
}finally{await DB.close();}
