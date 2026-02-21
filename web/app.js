const API_BASE = (localStorage.getItem('API_BASE') || '').trim() || (location.origin.includes('github') ? 'http://localhost:3000' : location.origin.replace(/\/$/, ''));

function $(sel){return document.querySelector(sel)}
function el(tag, attrs={}, children=[]){
  const e=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(k==='class') e.className=v;
    else if(k==='html') e.innerHTML=v;
    else e.setAttribute(k,v);
  }
  for(const c of children) e.appendChild(typeof c==='string'?document.createTextNode(c):c);
  return e;
}

function getToken(){return localStorage.getItem('token')||''}
function setToken(t){localStorage.setItem('token',t)}
function clearToken(){localStorage.removeItem('token')}
function authHeaders(){
  const h={'Content-Type':'application/json'};
  const t=getToken();
  if(t) h['Authorization']='Bearer '+t;
  return h;
}

async function api(path, opts={}){
  const r=await fetch(API_BASE+path, {
    ...opts,
    headers: { ...(opts.headers||{}), ...authHeaders() }
  });
  const ct=r.headers.get('content-type')||'';
  const data=ct.includes('application/json')? await r.json(): await r.text();
  if(!r.ok) throw (data?.error? new Error(data.error): new Error('request_failed'));
  return data;
}

export function mountAuth(role){
  const box=$('#authBox');
  const userBox=$('#userBox');
  const status=$('#authStatus');

  async function who(){
    try{
      const health=await fetch(API_BASE+'/health');
      if(!health.ok) throw new Error('backend_down');
    }catch(e){
      status.textContent='Backend işləmir. API_BASE düz deyil.';
    }
  }
  who();

  $('#btnLogout')?.addEventListener('click',()=>{clearToken();location.reload();});

  $('#btnLogin')?.addEventListener('click', async ()=>{
    status.textContent='...';
    try{
      const phone=$('#loginPhone').value.trim();
      const password=$('#loginPass').value;
      const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({phone,password})});
      setToken(d.token);
      localStorage.setItem('role', d.user.role);
      location.reload();
    }catch(e){status.textContent='Login xətası: '+e.message;}
  });

  $('#btnRegister')?.addEventListener('click', async ()=>{
    status.textContent='...';
    try{
      const phone=$('#regPhone').value.trim();
      const password=$('#regPass').value;
      const full_name=$('#regName').value.trim();
      const car_model=$('#regCarModel')?$('#regCarModel').value.trim():undefined;
      const car_number=$('#regCarNumber')?$('#regCarNumber').value.trim():undefined;
      const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({role,phone,password,full_name,car_model,car_number})});
      setToken(d.token);
      localStorage.setItem('role', d.user.role);
      location.reload();
    }catch(e){status.textContent='Qeydiyyat xətası: '+e.message;}
  });

  // show/hide
  if(getToken()){
    box.style.display='none';
    userBox.style.display='block';
  }else{
    box.style.display='block';
    userBox.style.display='none';
  }
}

export function setupSuggest(inputEl, onPick){
  const wrap=inputEl.closest('.suggest');
  const list=el('div',{class:'suggest-list',style:'display:none'});
  wrap.appendChild(list);

  let t=null;
  inputEl.addEventListener('input',()=>{
    clearTimeout(t);
    const q=inputEl.value.trim();
    if(q.length<2){list.style.display='none';list.innerHTML='';return;}
    t=setTimeout(async ()=>{
      try{
        const data=await api('/api/geo/geocode?q='+encodeURIComponent(q),{method:'GET'});
        list.innerHTML='';
        (data.results||[]).forEach(item=>{
          const it=el('div',{class:'suggest-item'},[item.display_name]);
          it.addEventListener('click',()=>{
            list.style.display='none';
            onPick(item);
          });
          list.appendChild(it);
        });
        list.style.display = (data.results||[]).length ? 'block':'none';
      }catch(e){
        list.style.display='none';
      }
    }, 250);
  });

  document.addEventListener('click',(e)=>{
    if(!wrap.contains(e.target)) list.style.display='none';
  });
}

export async function gpsToInput(btnEl, setFn){
  btnEl.disabled=true;
  btnEl.textContent='GPS...';
  try{
    const pos = await new Promise((resolve, reject)=>{
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy:true, timeout:15000, maximumAge:0 });
    });
    const lat=pos.coords.latitude;
    const lon=pos.coords.longitude;
    const rev=await api(`/api/geo/reverse?lat=${lat}&lon=${lon}`);
    setFn({lat,lon,display_name:rev.display_name||`${lat.toFixed(5)}, ${lon.toFixed(5)}`});
  } catch(e){
    alert('GPS alınmadı. Telefon browser-də Location icazəsini ver. Xəta: '+e.message);
  } finally{
    btnEl.disabled=false;
    btnEl.textContent='GPS ilə seç';
  }
}

export async function calcRoute(from, to){
  const data=await api(`/api/geo/route?fromLat=${from.lat}&fromLon=${from.lon}&toLat=${to.lat}&toLon=${to.lon}`);
  return data;
}

export function kmFmt(km){return (Math.round(km*100)/100).toFixed(2)}

export function mapsLink(lat, lon){
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

