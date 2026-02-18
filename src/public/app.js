/* global Telegram, L, io */

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand();
  tg.ready();
}

const qs = new URLSearchParams(location.search);
const role = qs.get('role') || 'passenger';
document.getElementById('roleBadge').textContent = role.toUpperCase();

const initData = tg?.initData || '';

function showNotice(msg) {
  const n = document.getElementById('notice');
  n.textContent = msg;
  n.classList.remove('hidden');
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-telegram-init-data': initData
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || 'request_failed');
  return j;
}

function fmt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(2);
}

function wazeLink(lat, lng) {
  return `waze://?ll=${lat},${lng}&navigate=yes`;
}

// --- Passenger
async function initPassenger() {
  document.getElementById('screen-passenger').classList.remove('hidden');
  await api('GET', '/api/passenger/me');

  const map = L.map('map-passenger', { zoomControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  let pickup = null;
  let drop = null;
  let pickupMarker = null;
  let dropMarker = null;
  let routeLine = null;

  function updateText(price) {
    const rt = document.getElementById('routeText');
    rt.textContent = `Pickup: ${pickup ? 'OK' : 'GPS'} • Drop: ${drop ? 'OK' : 'seçilməyib'}`;
    document.getElementById('priceText').textContent = price ? `${fmt(price)} AZN` : '—';
  }

  function clearRoute() {
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  }

  function reset() {
    drop = null;
    if (dropMarker) { map.removeLayer(dropMarker); dropMarker = null; }
    clearRoute();
    updateText(null);
  }

  document.getElementById('btnReset').onclick = reset;

  const pos = await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ lat: 40.4093, lng: 49.8671 })
    );
  });
  pickup = pos;
  map.setView([pos.lat, pos.lng], 13);
  pickupMarker = L.marker([pos.lat, pos.lng]).addTo(map);

  map.on('click', async (e) => {
    drop = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (dropMarker) map.removeLayer(dropMarker);
    dropMarker = L.marker([drop.lat, drop.lng]).addTo(map);
    clearRoute();
    routeLine = L.polyline([[pickup.lat, pickup.lng], [drop.lat, drop.lng]]).addTo(map);

    // estimate via server OSRM
    try {
      const j = await api('POST', '/api/passenger/rides', {
        pickup,
        drop,
        pickupText: 'GPS',
        dropText: 'Xəritədən seçildi'
      });
      // We created a ride already; show price and keep it as active
      activeRideId = j.ride.id;
      updateText(j.ride.price_azn);
      showNotice('✅ Sifariş yaradıldı. Sürücü gözləyin...');

      // Subscribe ride updates
      socket.emit('join', { room: `ride:${activeRideId}` });

    } catch (err) {
      showNotice('Marşrut hesablanmadı. Sonra yenə yoxlayın.');
    }
  });

  let activeRideId = null;

  document.getElementById('btnOrder').onclick = async () => {
    if (!drop) return showNotice('Drop nöqtəsini xəritədə seçin.');
    // Order already created on click; if not, create
    if (!activeRideId) {
      try {
        const j = await api('POST', '/api/passenger/rides', { pickup, drop, pickupText: 'GPS', dropText: 'Xəritədən seçildi' });
        activeRideId = j.ride.id;
        updateText(j.ride.price_azn);
        showNotice('✅ Sifariş yaradıldı. Sürücü gözləyin...');
        socket.emit('join', { room: `ride:${activeRideId}` });
      } catch {
        showNotice('Sifariş alınmadı.');
      }
    }
  };

  const socket = io();
  socket.on('ride:update', (u) => {
    if (!activeRideId || u.id !== activeRideId) return;
    if (u.status === 'accepted') showNotice('🚖 Sürücü sifarişi qəbul etdi.');
    if (u.status === 'arrived') showNotice('📍 Sürücü çatdı.');
    if (u.status === 'started') showNotice('▶️ Gediş başladı.');
    if (u.status === 'finished') showNotice('✅ Gediş bitdi.');
  });

  updateText(null);
}

// --- Driver
async function initDriver() {
  document.getElementById('screen-driver').classList.remove('hidden');
  const me = await api('GET', '/api/driver/me');
  const driver = me.driver;
  if (!driver) {
    showNotice('Qeydiyyat tamamlanmayıb. Driver botda /start edin və qeydiyyatı bitirin.');
    return;
  }

  document.getElementById('driverBalance').textContent = `${fmt(driver.balance_azn)} AZN`;
  document.getElementById('driverStatus').textContent = `Status: ${driver.status}`;

  const blockAt = Number(window.__BLOCK_AT__ || -15);
  if (Number(driver.balance_azn) <= blockAt) {
    showNotice(`Balansınız ${blockAt} AZN və ya aşağıdır. Sifariş qəbul edilmir.`);
  }

  const map = L.map('map-driver', { zoomControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  const pos = await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ lat: 40.4093, lng: 49.8671 })
    );
  });
  map.setView([pos.lat, pos.lng], 12);
  L.marker([pos.lat, pos.lng]).addTo(map);

  const socket = io();
  let online = false;
  let currentOffer = null;
  let currentRideId = null;

  const offerBox = document.getElementById('offerBox');
  const offerDetails = document.getElementById('offerDetails');
  const btnOnline = document.getElementById('btnOnline');
  const btnAccept = document.getElementById('btnAccept');
  const btnWaze = document.getElementById('btnWaze');
  const finishPrice = document.getElementById('finishPrice');

  function showOffer(o) {
    currentOffer = o;
    currentRideId = o.id;
    offerBox.classList.remove('hidden');
    finishPrice.classList.add('hidden');
    offerDetails.textContent = `Məsafə: ${fmt(o.distanceKm)} km\nQiymət: ${fmt(o.priceAzn)} AZN`;
    btnWaze.href = wazeLink(o.pickup.lat, o.pickup.lng);

    socket.emit('join', { room: `ride:${currentRideId}` });
  }

  btnOnline.onclick = async () => {
    online = !online;
    btnOnline.textContent = online ? 'Oflayn ol' : 'Onlayn ol';
    if (online) {
      socket.emit('joinDrivers');
      const j = await api('GET', '/api/driver/rides/pending');
      // If there is already a pending ride, show the newest one as an offer.
      if (Array.isArray(j.rides) && j.rides.length) {
        const r = j.rides[0];
        showOffer({
          id: r.id,
          pickup: { lat: r.pickup_lat, lng: r.pickup_lng, text: r.pickup_text },
          drop: { lat: r.drop_lat, lng: r.drop_lng, text: r.drop_text },
          distanceKm: r.distance_km,
          priceAzn: r.price_azn
        });
      }
    }
  };

  socket.on('ride:new', (o) => {
    if (!online) return;
    showOffer(o);
  });

  btnAccept.onclick = async () => {
    if (!currentRideId) return;
    try {
      await api('POST', `/api/driver/rides/${currentRideId}/accept`, {});
      showNotice('✅ Qəbul edildi.');
    } catch (e) {
      showNotice(e.message);
    }
  };

  document.querySelectorAll('.stbtn').forEach((b) => {
    b.onclick = async () => {
      if (!currentRideId) return;
      const st = b.getAttribute('data-st');
      try {
        await api('POST', `/api/driver/rides/${currentRideId}/status`, { status: st });
        if (st === 'finished' && currentOffer) {
          finishPrice.textContent = `Müştəridən alınacaq: ${fmt(currentOffer.priceAzn)} AZN`;
          finishPrice.classList.remove('hidden');
        }
      } catch {
        showNotice('Status dəyişmədi.');
      }
    };
  });

  socket.on('ride:update', (u) => {
    if (!currentRideId || u.id !== currentRideId) return;
    if (u.status === 'accepted') showNotice('Sifariş qəbul olundu.');
  });
}

// --- Admin
async function initAdmin() {
  document.getElementById('screen-admin').classList.remove('hidden');
  await api('GET', '/api/admin/me');

  const box = document.getElementById('topups');
  const btn = document.getElementById('btnRefreshTopups');

  async function load() {
    box.innerHTML = '';
    try {
      const j = await api('GET', '/api/admin/topups');
      if (!j.topups.length) {
        box.innerHTML = '<div class="card"><div class="cardTitle">Pending yoxdur</div></div>';
        return;
      }
      for (const t of j.topups) {
        const el = document.createElement('div');
        el.className = 'card';
        el.innerHTML = `
          <div class="cardTitle">TopUp #${t.id} • ${t.amount_azn} AZN</div>
          <div class="cardMeta">Sürücü: ${t.first_name || ''} ${t.last_name || ''} (tg:${t.tg_id})\nMetod: ${t.method}</div>
          <div class="cardActions">
            <button class="btn" data-act="approve">Approve</button>
            <button class="btn danger" data-act="reject">Reject</button>
          </div>
        `;
        el.querySelectorAll('button').forEach((b) => {
          b.onclick = async () => {
            const action = b.getAttribute('data-act');
            try {
              await api('POST', `/api/admin/topups/${t.id}/decide`, { action });
              await load();
            } catch {
              showNotice('Alınmadı');
            }
          };
        });
        box.appendChild(el);
      }
    } catch (e) {
      showNotice('Admin icazə yoxdur və ya initData problemidir.');
    }
  }

  btn.onclick = load;
  await load();
}

(async () => {
  try {
    if (!initData) {
      showNotice('Bu səhifə Telegram içində (WebApp) açılmalıdır.');
      return;
    }
    if (role === 'passenger') return await initPassenger();
    if (role === 'driver') return await initDriver();
    if (role === 'admin') return await initAdmin();
    showNotice('Role tapılmadı.');
  } catch (e) {
    showNotice('Xəta: ' + (e.message || e));
  }
})();
