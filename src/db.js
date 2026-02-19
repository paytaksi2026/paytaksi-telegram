const { Pool } = require('pg');
let pool;
function getPool(){
  if(!pool){
    const cs=process.env.DATABASE_URL; if(!cs) throw new Error('DATABASE_URL missing');
    pool=new Pool({connectionString:cs, ssl:{rejectUnauthorized:false}});
  }
  return pool;
}
async function q(text, params){ return (await getPool().query(text, params)); }
module.exports={getPool,q};
