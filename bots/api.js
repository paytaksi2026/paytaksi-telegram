const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
function backend(){ const url = process.env.BACKEND_URL || "http://localhost:3000"; return url.replace(/\/$/,""); }
async function post(path, body){
  const r = await fetch(backend()+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});
  return await r.json();
}
async function get(path){ const r = await fetch(backend()+path); return await r.json(); }
module.exports = { backend, post, get };
