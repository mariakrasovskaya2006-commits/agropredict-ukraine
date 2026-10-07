import {DatabaseSync} from 'node:sqlite';

const schema = `
CREATE TABLE IF NOT EXISTS analytics_events (
 id TEXT PRIMARY KEY, event_name TEXT NOT NULL, event_label TEXT,
 page_path TEXT NOT NULL, country_code TEXT, crop_key TEXT, score_band TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS analysis_feedback (
 id TEXT PRIMARY KEY, usefulness TEXT NOT NULL, visitor_type TEXT NOT NULL,
 comment TEXT NOT NULL DEFAULT '', page_path TEXT NOT NULL, country_code TEXT,
 crop_key TEXT, score_band TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analysis_feedback_created_at ON analysis_feedback(created_at);`;

export async function openDatabase({connectionString,sqlitePath}={}) {
 if(connectionString) {
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString,max:3,connectionTimeoutMillis:10000,idleTimeoutMillis:30000});
  pool.on('error',()=>console.error('database-connection-error'));
  // PostgreSQL keeps created_at as text to preserve the original D1 timestamps.
  await pool.query(schema.replaceAll('DEFAULT CURRENT_TIMESTAMP','DEFAULT (CURRENT_TIMESTAMP::text)'));
  const sqlForPg=sql=>{let i=0;return sql.replace(/\?/g,()=>'$'+(++i));};
  class Statement {
   constructor(sql,values=[]){this.sql=sql;this.values=values;}
   bind(...values){return new Statement(this.sql,values);}
   async run(){await pool.query(sqlForPg(this.sql),this.values);return {success:true};}
  }
  return {
   prepare:sql=>new Statement(sql),
   async batch(statements){const client=await pool.connect();try{await client.query('BEGIN');for(const s of statements)await client.query(sqlForPg(s.sql),s.values);await client.query('COMMIT');return statements.map(()=>({success:true}));}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}},
   close:()=>pool.end(),
   kind:'postgres'
  };
 }
 if(!sqlitePath)return null;
 const sqlite=new DatabaseSync(sqlitePath);sqlite.exec(schema);
 class Statement {
  constructor(sql,values=[]){this.sql=sql;this.values=values;}
  bind(...values){return new Statement(this.sql,values);}
  async run(){sqlite.prepare(this.sql).run(...this.values);return {success:true};}
 }
 return {
  prepare:sql=>new Statement(sql),
  async batch(statements){sqlite.exec('BEGIN');try{for(const s of statements)await s.run();sqlite.exec('COMMIT');return statements.map(()=>({success:true}));}catch(e){sqlite.exec('ROLLBACK');throw e;}},
  close:()=>sqlite.close(),kind:'sqlite'
 };
}
