const fs=require('fs'); const path=require('path'); const {q}=require('./db');
async function runMigrations(){
  const sql=fs.readFileSync(path.join(__dirname,'..','sql','schema.sql'),'utf-8');
  await q(sql);
}
module.exports={runMigrations};
