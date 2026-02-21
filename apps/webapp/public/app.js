const API_BASE = '';

const store = {
  token: localStorage.getItem('token') || '',
  role: localStorage.getItem('role') || '',
  user: null,
  driver: null,
};

function setAuth(token, role) {
  store.token = token;
  store.role = role;
  localStorage.setItem('token', token);
  localStorage.setItem('role', role);
}

function clearAuth() {
  store.token = '';
  store.role = '';
  store.user = null;
  store.driver = null;
  localStorage.removeItem('token');
  localStorage.removeItem('role');
}

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (store.token) headers['Authorization'] = 'Bearer ' + store.token;
  if (!headers['Content-Type'] && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + path, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error('API_ERROR'), { status: res.status, data: json });
  return json;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function mount(node) {
  const root = document.getElementById('app');
  root.innerHTML = '';
  root.appendChild(node);
}

function nav(hash) {
  location.hash = hash;
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = el('<div class="toast"></div>');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._to);
  t._to = setTimeout(() => (t.style.display = 'none'), 2200);
}

async function bootMe() {
  if (!store.token) return;
  try {
    const me = await api('/api/me');
    store.user = me.user;
    store.driver = me.driver;
    store.role = me.user.role;
    localStorage.setItem('role', store.role);
  } catch (e) {
    clearAuth();
  }
}

function pageRole() {
  const node = el(`
    <div class="container">
      <div class="card">
        <div class="h1">PayTaksi</div>
        <div class="p">Rol seç və davam et.</div>
        <div class="row" style="gap:14px;align-items:stretch;">
          <div class="card" style="flex:1;padding:14px;background:rgba(255,255,255,0.03);">
            <div class="h1" style="font-size:18px;margin-bottom:6px;">Müştəri</div>
            <div class="p" style="margin-bottom:10px;">Sifariş et və sürücü çağır.</div>
            <button class="btn btnPrimary" id="p_login">Daxil ol</button>
            <div style="height:10px"></div>
            <button class="btn btnSecondary" id="p_reg">Qeydiyyatdan keç</button>
          </div>
          <div class="card" style="flex:1;padding:14px;background:rgba(255,255,255,0.03);">
            <div class="h1" style="font-size:18px;margin-bottom:6px;">Sürücü</div>
            <div class="p" style="margin-bottom:10px;">Sənədlər yüklə, təsdiqdən sonra online ol.</div>
            <button class="btn btnPrimary" id="d_login">Daxil ol</button>
            <div style="height:10px"></div>
            <button class="btn btnSecondary" id="d_reg">Qeydiyyatdan keç</button>
          </div>
        </div>
      </div>
    </div>
  `);
  const go = (role, mode) => {
    localStorage.setItem('pickRole', role);
    localStorage.setItem('pickMode', mode);
    nav('#/login');
  };
  node.querySelector('#p_login').onclick = () => go('passenger', 'login');
  node.querySelector('#p_reg').onclick   = () => go('passenger', 'register');
  node.querySelector('#d_login').onclick = () => go('driver', 'login');
  node.querySelector('#d_reg').onclick   = () => go('driver', 'register');
  return node;
}

function pageLogin() {
  const pickRole = localStorage.getItem('pickRole') || '';
  const pickMode = localStorage.getItem('pickMode') || 'login';
  const node = el(`
    <div class="container">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <div>
            <div class="h1">Giriş / Qeydiyyat</div>
            <div class="badge">Rol: <b style="color:var(--text)">${pickRole || 'seçilmir'}</b></div>
          </div>
          <button class="smallBtn" id="back">←</button>
        </div>

        <div class="row" style="gap:10px;justify-content:flex-start;margin-top:10px;">
          <button class="btn ${pickMode==='login'?'btnPrimary':'btnSecondary'}" id="tabLogin" style="padding:10px 14px;min-width:120px;">Daxil ol</button>
          <button class="btn ${pickMode==='register'?'btnPrimary':'btnSecondary'}" id="tabReg" style="padding:10px 14px;min-width:160px;">Qeydiyyatdan keç</button>
        </div>

        <div class="label">Telefon</div>
        <input class="input" id="phone" placeholder="+994..." />
        <div class="label">Şifrə</div>
        <input class="input" id="pass" type="password" placeholder="••••••" />

        <div id="regOnly">
          <div class="label">Ad Soyad</div>
          <input class="input" id="name" placeholder="Ad Soyad" />

          <div id="driverExtra" style="display:none;">
            <div class="label">Maşın modeli (sürücü)</div>
            <input class="input" id="car_model" placeholder="Toyota Prius" />
            <div class="label">Nömrə nişanı (sürücü)</div>
            <input class="input" id="car_plate" placeholder="10-AA-123" />
          </div>
        </div>

        <div style="height:10px"></div>
        <button class="btn btnPrimary" id="loginBtn">Daxil ol</button>
        <div style="height:10px"></div>
        <button class="btn btnSecondary" id="regBtn">Qeydiyyatdan keç</button>
      </div>
    </div>
  `);

  node.querySelector('#back').onclick = () => nav('#/role');

  const regOnly = node.querySelector('#regOnly');
  const driverExtra = node.querySelector('#driverExtra');

  function setMode(mode) {
    localStorage.setItem('pickMode', mode);
    // re-render (hash may not change)
    if (typeof render === 'function') render();
  }
  node.querySelector('#tabLogin').onclick = () => setMode('login');
  node.querySelector('#tabReg').onclick = () => setMode('register');

  // register-only fields visible only in register mode
  if (pickMode !== 'register') {
    regOnly.style.display = 'none';
  } else {
    regOnly.style.display = 'block';
    if (pickRole === 'driver') driverExtra.style.display = 'block';
  }

  // Main buttons visibility (separate Login vs Register)
  const loginBtn = node.querySelector('#loginBtn');
  const regBtn = node.querySelector('#regBtn');
  if (pickMode === 'register') {
    loginBtn.style.display = 'none';
  } else {
    regBtn.style.display = 'none';
  }

  function humanError(code) {
    if (!code) return null;
    if (code === 'PHONE_EXISTS') return 'Bu telefon artıq qeydiyyatdan keçib. Zəhmət olmasa "Daxil ol" edin.';
    if (code === 'INVALID_CREDENTIALS') return 'Telefon və ya şifrə yanlışdır.';
    if (code === 'ROLE_REQUIRED') return 'Rol seçilməyib.';
    return code;
  }

  loginBtn.onclick = async () => {
    try {
      const phone = node.querySelector('#phone').value.trim();
      const password = node.querySelector('#pass').value;
      const out = await api('/api/auth/login', { method:'POST', body: JSON.stringify({ phone, password }) });
      setAuth(out.token, out.user.role);
      await bootMe();
      routeAfterLogin();
    } catch (e) {
      toast(humanError(e.data?.error) || 'Login xətası');
    }
  };

  regBtn.onclick = async () => {
    try {
      const role = localStorage.getItem('pickRole');
      if (!role) return toast('Rol seç');
      const name = node.querySelector('#name').value.trim();
      const phone = node.querySelector('#phone').value.trim();
      const password = node.querySelector('#pass').value;
      const car_model = node.querySelector('#car_model')?.value?.trim();
      const car_plate = node.querySelector('#car_plate')?.value?.trim();
      const out = await api('/api/auth/register', { method:'POST', body: JSON.stringify({ role, name, phone, password, car_model, car_plate }) });

      // Registration success message (user requested)
      const who = (name || out.user?.name || '').trim();
      const title = who ? `Hörmətli ${who},` : 'Təbriklər!';
      toast(`${title} siz qeydiyyatdan keçdiniz. Login: ${phone}  Şifrə: ${password}`);

      // After register -> go to Login (separate flow)
      localStorage.setItem('pickMode', 'login');
      // keep phone filled, clear password for safety
      setTimeout(() => {
        if (typeof render === 'function') render();
      }, 600);
    } catch (e) {
      toast(humanError(e.data?.error) || 'Register xətası');
    }
  };

  return node;
}

function routeAfterLogin() {
  if (!store.user) return nav('#/role');
  if (store.user.role === 'passenger') return nav('#/p/map');
  if (store.user.role === 'driver') {
    if ((store.driver?.approval_status || 'PENDING') !== 'APPROVED') return nav('#/d/pending');
    // if approved, go map
    return nav('#/d/map');
  }
  nav('#/role');
}

function pageProfile() {
  const node = el(`
    <div class="container">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <div>
            <div class="h1">Profil</div>
            <div class="p">Hesab məlumatları</div>
          </div>
          <button class="smallBtn" id="home">⌂</button>
        </div>
        <div class="badge">Ad: <b style="color:var(--text)">${store.user?.name || ''}</b></div>
        <div style="height:8px"></div>
        <div class="badge">Telefon: <b style="color:var(--text)">${store.user?.phone || ''}</b></div>
        <div style="height:8px"></div>
        <div class="badge">Rol: <b style="color:var(--text)">${store.user?.role || ''}</b></div>
        ${store.user?.role==='driver' ? `<div style="height:8px"></div><div class="badge">Təsdiq: <b style="color:var(--text)">${store.driver?.approval_status || ''}</b></div>`:''}
        <div style="height:14px"></div>
        <button class="btn btnWarn" id="logout">Çıxış</button>
      </div>
    </div>
  `);
  node.querySelector('#logout').onclick = () => { clearAuth(); nav('#/role'); };
  node.querySelector('#home').onclick = () => routeAfterLogin();
  return node;
}

// ---- Map helpers ----
let map;
let pickup = null;
let dropoff = null;

async function reverse(lat, lon) {
  const r = await api(`/api/places/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
  return r.text;
}

async function searchPlaces(q) {
  const r = await api(`/api/places/search?q=${encodeURIComponent(q)}`);
  return r.items || [];
}

function createSuggestionsOverlay(onPick) {
  const overlay = el(`
    <div class="suggestions" id="sug">
      <div class="panel">
        <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;">
          <input class="input" id="q" placeholder="Ünvan yaz..." style="flex:1" />
          <button class="smallBtn" id="x">✕</button>
        </div>
        <div id="list"></div>
      </div>
    </div>
  `);
  const q = overlay.querySelector('#q');
  const list = overlay.querySelector('#list');
  overlay.querySelector('#x').onclick = () => (overlay.style.display='none');

  let timer = null;
  q.oninput = () => {
    clearTimeout(timer);
    const val = q.value.trim();
    timer = setTimeout(async () => {
      if (val.length < 3) { list.innerHTML = ''; return; }
      try {
        const items = await searchPlaces(val);
        list.innerHTML = '';
        for (const it of items) {
          const row = el(`<div class="item"><div class="t">${escapeHtml(it.text.split(',')[0] || it.text)}</div><div class="s">${escapeHtml(it.text)}</div></div>`);
          row.onclick = () => { overlay.style.display='none'; onPick(it); };
          list.appendChild(row);
        }
      } catch {
        list.innerHTML = '<div class="item"><div class="t">Xəta</div><div class="s">Axtarış işləmədi</div></div>';
      }
    }, 700);
  };

  document.body.appendChild(overlay);
  return overlay;
}

function escapeHtml(s){
  return String(s).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\'':'&#39;'}[c]));
}

function passengerMapPage() {
  const node = el(`
    <div class="mapWrap">
      <div id="map"></div>
      <div class="topBar">
        <div class="pill"><b>PayTaksi</b><span style="color:var(--muted)">Müştəri</span></div>
        <div style="display:flex;gap:10px;">
          <button class="smallBtn" id="me">Profil</button>
          <button class="smallBtn" id="loc">📍</button>
        </div>
      </div>

      <div class="sheet">
        <div class="grab"></div>
        <div class="field" id="fromField"><span class="pin green"></span><input id="from" placeholder="Haradan" readonly /></div>
        <div class="field" id="toField"><span class="pin"></span><input id="to" placeholder="Haraya" readonly /></div>
        <button class="btn btnPrimary" id="order">Sifariş et</button>
      </div>
    </div>
  `);

  node.querySelector('#me').onclick = () => nav('#/profile');

  // init map
  initMap();

  const sug = createSuggestionsOverlay((it) => {
    if (sug._mode === 'pickup') {
      pickup = { lat: it.lat, lon: it.lon, text: it.text };
      node.querySelector('#from').value = it.text;
      map.flyTo({ center: [it.lon, it.lat], zoom: 14 });
    } else {
      dropoff = { lat: it.lat, lon: it.lon, text: it.text };
      node.querySelector('#to').value = it.text;
      map.flyTo({ center: [it.lon, it.lat], zoom: 14 });
    }
  });

  node.querySelector('#fromField').onclick = () => { sug._mode='pickup'; sug.style.display='block'; sug.querySelector('#q').value=''; sug.querySelector('#list').innerHTML=''; sug.querySelector('#q').focus(); };
  node.querySelector('#toField').onclick = () => { sug._mode='dropoff'; sug.style.display='block'; sug.querySelector('#q').value=''; sug.querySelector('#list').innerHTML=''; sug.querySelector('#q').focus(); };

  node.querySelector('#loc').onclick = () => locateAndFill(node);

  node.querySelector('#order').onclick = async () => {
    if (!pickup || !dropoff) return toast('Haradan və Haraya seç');
    try {
      const out = await api('/api/orders', { method:'POST', body: JSON.stringify({ pickup, dropoff }) });
      toast('Sifariş göndərildi');
      nav('#/p/order');
    } catch (e) {
      toast(e.data?.error || 'Sifariş xətası');
    }
  };

  // auto locate
  setTimeout(() => locateAndFill(node), 400);

  return node;
}

function initMap() {
  if (map) { try { map.remove(); } catch {} }
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center: [49.8671, 40.4093],
    zoom: 11
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass:false }), 'bottom-right');
}

function locateAndFill(node) {
  if (!navigator.geolocation) return toast('Geolokasiya dəstəklənmir');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const text = await reverse(lat, lon);
      pickup = { lat, lon, text };
      node.querySelector('#from').value = text;
      map.flyTo({ center: [lon, lat], zoom: 15 });
    } catch {
      toast('Cari yer alınmadı');
    }
  }, () => toast('Yer icazəsi verilmədi'), { enableHighAccuracy:true, timeout:8000 });
}

function passengerOrderPage() {
  const node = el(`
    <div class="container">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <div>
            <div class="h1">Aktiv sifariş</div>
            <div class="p" id="st">Yüklənir…</div>
          </div>
          <button class="smallBtn" id="home">⌂</button>
        </div>
        <div id="body"></div>
        <div style="height:10px"></div>
        <button class="btn btnWarn" id="cancel" style="display:none">Ləğv et</button>
      </div>
    </div>
  `);
  node.querySelector('#home').onclick = () => nav('#/p/map');

  async function load() {
    const out = await api('/api/orders/active');
    if (!out.order) {
      node.querySelector('#st').textContent = 'Aktiv sifariş yoxdur';
      node.querySelector('#body').innerHTML = '';
      return;
    }
    const o = out.order;
    node.querySelector('#st').textContent = 'Status: ' + o.status;
    node.querySelector('#body').innerHTML = `
      <div class="badge">Haradan: <b style="color:var(--text)">${escapeHtml(o.pickup.text)}</b></div>
      <div style="height:8px"></div>
      <div class="badge">Haraya: <b style="color:var(--text)">${escapeHtml(o.dropoff.text)}</b></div>
      ${o.driver ? `<div style="height:12px"></div>
        <div class="card" style="background:#0f1512;border-radius:16px;">
          <div style="font-weight:900">Sürücü: ${escapeHtml(o.driver.name)}</div>
          <div style="color:var(--muted);margin-top:6px">${escapeHtml(o.driver.car_model)} • ${escapeHtml(o.driver.car_plate)}</div>
        </div>` : ''}
    `;
    const cancelBtn = node.querySelector('#cancel');
    cancelBtn.style.display = ['COMPLETED','CANCELLED_BY_PASSENGER','CANCELLED_BY_DRIVER','EXPIRED'].includes(o.status) ? 'none' : 'block';
    cancelBtn.onclick = async () => {
      await api(`/api/orders/${o.id}/cancel`, { method:'POST' });
      toast('Ləğv edildi');
      load();
    };
  }

  load().catch(() => toast('Yüklənmədi'));
  connectWSForPassenger(node);
  return node;
}

let ws;
function connectWS() {
  if (!store.token) return null;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return ws;
  ws = new WebSocket(`${location.origin.replace('http','ws')}/ws?token=${encodeURIComponent(store.token)}`);
  return ws;
}

function connectWSForPassenger(node) {
  const w = connectWS();
  if (!w) return;
  w.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'order:accepted' || msg.type === 'order:status') {
        // reload quickly
        setTimeout(() => {
          if (location.hash === '#/p/order') api('/api/orders/active').then(() => location.reload());
        }, 200);
      }
    } catch {}
  };
}

function driverPendingPage() {
  const node = el(`
    <div class="container">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <div>
            <div class="h1">Sürücü təsdiqi</div>
            <div class="p">Admin təsdiqi gözlənilir. Sənədləri yüklə.</div>
          </div>
          <button class="smallBtn" id="me">Profil</button>
        </div>
        <div id="status" class="badge">Status: …</div>
        <div style="height:12px"></div>
        <button class="btn btnPrimary" id="docs">Sənədləri yüklə</button>
      </div>
    </div>
  `);
  node.querySelector('#me').onclick = () => nav('#/profile');
  node.querySelector('#docs').onclick = () => nav('#/d/docs');

  api('/api/driver/docs/status').then((r) => {
    node.querySelector('#status').innerHTML = `Status: <b style="color:var(--text)">${r.approval_status}</b> • Docs: <b style="color:var(--text)">${r.docs_uploaded ? 'yüklənib' : 'yoxdur'}</b>`;
  }).catch(() => {});

  // listen for approval
  const w = connectWS();
  if (w) {
    w.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'driver:approval') {
          toast('Status yeniləndi: ' + msg.approval_status);
          await bootMe();
          routeAfterLogin();
        }
      } catch {}
    };
  }

  return node;
}

function driverDocsPage() {
  const node = el(`
    <div class="container">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <div>
            <div class="h1">Sənədlər</div>
            <div class="p">Vəsiqə (ön/arxa) və texpasport şəkli yüklə.</div>
          </div>
          <button class="smallBtn" id="back">←</button>
        </div>

        <div class="label">Vəsiqə ön</div>
        <input class="input" id="lf" type="file" accept="image/*" />
        <div class="label">Vəsiqə arxa</div>
        <input class="input" id="lb" type="file" accept="image/*" />
        <div class="label">Texpasport</div>
        <input class="input" id="cd" type="file" accept="image/*" />

        <div style="height:12px"></div>
        <button class="btn btnPrimary" id="up">Yüklə</button>
      </div>
    </div>
  `);
  node.querySelector('#back').onclick = () => nav('#/d/pending');

  node.querySelector('#up').onclick = async () => {
    const lf = node.querySelector('#lf').files[0];
    const lb = node.querySelector('#lb').files[0];
    const cd = node.querySelector('#cd').files[0];
    if (!lf || !lb || !cd) return toast('Hamısını seç');
    const fd = new FormData();
    fd.append('license_front', lf);
    fd.append('license_back', lb);
    fd.append('car_doc', cd);
    try {
      await api('/api/driver/docs', { method:'POST', body: fd, headers: {} });
      toast('Yükləndi');
      nav('#/d/pending');
    } catch (e) {
      toast(e.data?.error || 'Upload xətası');
    }
  };

  return node;
}

function driverMapPage() {
  const node = el(`
    <div class="mapWrap">
      <div id="map"></div>
      <div class="topBar">
        <div class="pill"><b>PayTaksi</b><span style="color:var(--muted)">Sürücü</span></div>
        <div style="display:flex;gap:10px;">
          <button class="smallBtn" id="me">Profil</button>
        </div>
      </div>

      <div class="popup" id="offer">
        <div class="card">
          <div style="font-weight:900;margin-bottom:8px">Yeni sifariş</div>
          <div class="badge" id="of1"></div>
          <div style="height:8px"></div>
          <div class="badge" id="of2"></div>
          <div style="height:12px"></div>
          <div class="row">
            <button class="btn btnPrimary" id="accept">Qəbul et</button>
            <button class="btn btnSecondary" id="reject">Rədd et</button>
          </div>
        </div>
      </div>

      <div class="sheet">
        <div class="grab"></div>
        <div class="row" style="align-items:center;justify-content:space-between;">
          <div>
            <div style="font-weight:900">Online rejimi</div>
            <div style="color:var(--muted);font-size:12px">Sifariş almaq üçün online ol.</div>
          </div>
          <button class="smallBtn" id="toggle">OFF</button>
        </div>
      </div>
    </div>
  `);

  node.querySelector('#me').onclick = () => nav('#/profile');

  initMap();

  let isOnline = !!store.driver?.is_online;
  const toggleBtn = node.querySelector('#toggle');
  function renderToggle() {
    toggleBtn.textContent = isOnline ? 'ON' : 'OFF';
    toggleBtn.style.borderColor = isOnline ? 'rgba(43,214,111,0.7)' : 'var(--border)';
  }
  renderToggle();

  toggleBtn.onclick = async () => {
    try {
      if (!isOnline) {
        await api('/api/driver/online', { method:'POST' });
        isOnline = true;
      } else {
        await api('/api/driver/offline', { method:'POST' });
        isOnline = false;
      }
      await bootMe();
      renderToggle();
    } catch (e) {
      toast(e.data?.error || 'Xəta');
    }
  };

  // WS offer
  const offer = node.querySelector('#offer');
  const w = connectWS();
  let currentOrderId = null;
  if (w) {
    w.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'order:new') {
          currentOrderId = msg.order.id;
          node.querySelector('#of1').innerHTML = `Haradan: <b style="color:var(--text)">${escapeHtml(msg.order.pickup_text)}</b>`;
          node.querySelector('#of2').innerHTML = `Haraya: <b style="color:var(--text)">${escapeHtml(msg.order.dropoff_text)}</b>`;
          offer.style.display = 'block';
        }
      } catch {}
    };
  }

  node.querySelector('#reject').onclick = async () => {
    offer.style.display = 'none';
    if (currentOrderId) await api(`/api/orders/${currentOrderId}/reject`, { method:'POST' }).catch(()=>{});
    currentOrderId = null;
  };
  node.querySelector('#accept').onclick = async () => {
    if (!currentOrderId) return;
    try {
      await api(`/api/orders/${currentOrderId}/accept`, { method:'POST' });
      offer.style.display = 'none';
      toast('Qəbul edildi');
      currentOrderId = null;
    } catch (e) {
      toast(e.data?.error || 'Qəbul xətası');
    }
  };

  return node;
}

// Router
const routes = {
  '#/role': pageRole,
  '#/login': pageLogin,
  '#/profile': pageProfile,
  '#/p/map': passengerMapPage,
  '#/p/order': passengerOrderPage,
  '#/d/pending': driverPendingPage,
  '#/d/docs': driverDocsPage,
  '#/d/map': driverMapPage,
};

async function render() {
  const h = location.hash || '';
  if (!store.token && h !== '#/role' && h !== '#/login') {
    return nav('#/role');
  }
  if (store.token && !store.user) await bootMe();

  const page = routes[h] || null;
  if (!page) {
    if (!store.token) return nav('#/role');
    return routeAfterLogin();
  }
  mount(page());
}

window.addEventListener('hashchange', render);

(async () => {
  await bootMe();
  if (!location.hash) {
    if (!store.token) nav('#/role');
    else routeAfterLogin();
  }
  render();
})();
