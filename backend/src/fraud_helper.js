export function normalizePlate(s){
  return String(s||"").toUpperCase().replace(/\s+/g,"").replace(/[^A-Z0-9-]/g,"");
}
export function normalizePhone(s){
  return String(s||"").replace(/\s+/g,"").replace(/[^0-9+]/g,"");
}
export function addFlag(flags, name, value=true){
  const f = flags || {};
  f[name]=value;
  return f;
}
export function flagsToString(flags){
  try{ return JSON.stringify(flags||{}); }catch(e){ return "{}"; }
}
export function inAzerbaijan(lat, lon){
  return (lat>=38.2 && lat<=41.9 && lon>=44.7 && lon<=50.9) || (lat>=38.5 && lat<=39.9 && lon>=44.0 && lon<=46.0);
}
