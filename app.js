/* global L, toGeoJSON, firebaseConfig, firebase */

const FINISH_RADIUS_METER = 25;

let db;
let map;
let myId = localStorage.getItem('gcp_monitor_user_id') || crypto.randomUUID();
localStorage.setItem('gcp_monitor_user_id', myId);

let myName = localStorage.getItem('gcp_monitor_name') || '';
let myRef = null;
let watchId = null;
let myPosition = null;

let loadedGeoJSON = null;
let points = [];
let pointMarkers = {};
let surveyorMarkers = {};
let surveyorAccuracyCircles = {};
let pointStatus = {};
let nearestPointId = null;

const el = (id) => document.getElementById(id);

initFirebase();
initMap();
initUI();
listenSurveyors();
listenPointStatus();
listenSharedGeoJSON();

function initFirebase() {
  firebase.initializeApp(firebaseConfig);
  db = firebase.database();
}

function initMap() {
  map = L.map('map').setView([-7.9666, 112.6326], 16);

  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 22,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 22,
    attribution: 'Tiles &copy; Esri'
  });

  L.control.layers({ 'OpenStreetMap': osm, 'Satelit Esri': satellite }).addTo(map);
}

function initUI() {
  el('surveyorName').value = myName;
  el('btnStart').addEventListener('click', startMonitoring);
  el('kmlInput').addEventListener('change', handleKMLUpload);
  el('btnFinishNearest').addEventListener('click', finishNearestPoint);
  el('btnResetPoints').addEventListener('click', resetPointStatus);
  el('btnExportGeoJSON').addEventListener('click', exportGeoJSON);
}

function startMonitoring() {
  myName = el('surveyorName').value.trim();
  if (!myName) {
    alert('Isi nama surveyor terlebih dahulu.');
    return;
  }

  localStorage.setItem('gcp_monitor_name', myName);
  myRef = db.ref(`surveyors/${myId}`);
  myRef.onDisconnect().remove();

  if (!navigator.geolocation) {
    alert('Browser tidak mendukung GPS/geolocation.');
    return;
  }

  if (watchId !== null) navigator.geolocation.clearWatch(watchId);

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      myPosition = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy || 0,
        heading: pos.coords.heading || null,
        speed: pos.coords.speed || null
      };

      el('myLat').textContent = myPosition.lat.toFixed(7);
      el('myLng').textContent = myPosition.lng.toFixed(7);
      el('myAccuracy').textContent = `${myPosition.accuracy.toFixed(1)} m`;

      myRef.set({
        id: myId,
        name: myName,
        lat: myPosition.lat,
        lng: myPosition.lng,
        accuracy: myPosition.accuracy,
        heading: myPosition.heading,
        speed: myPosition.speed,
        lastUpdate: Date.now()
      });

      updateNearestPoint();
    },
    (err) => alert(`GPS gagal dibaca: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 }
  );

  el('btnStart').textContent = 'Monitoring Aktif';
  el('btnStart').disabled = true;
}

function listenSurveyors() {
  db.ref('surveyors').on('value', (snap) => {
    const data = snap.val() || {};
    const activeIds = Object.keys(data);
    el('activeSurveyorCount').textContent = activeIds.length;

    Object.keys(surveyorMarkers).forEach((id) => {
      if (!data[id]) removeSurveyorMarker(id);
    });

    activeIds.forEach((id) => upsertSurveyorMarker(id, data[id]));
  });
}

function upsertSurveyorMarker(id, s) {
  if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return;
  const latlng = [s.lat, s.lng];
  const html = `<div class="surveyor-icon">${escapeHtml((s.name || 'S').charAt(0).toUpperCase())}</div>`;
  const icon = L.divIcon({ html, className: '', iconSize: [34, 34], iconAnchor: [17, 17] });

  if (!surveyorMarkers[id]) {
    surveyorMarkers[id] = L.marker(latlng, { icon }).addTo(map);
    surveyorAccuracyCircles[id] = L.circle(latlng, {
      radius: s.accuracy || 5,
      color: '#2563eb',
      fillColor: '#3b82f6',
      fillOpacity: 0.12,
      weight: 2
    }).addTo(map);
  } else {
    surveyorMarkers[id].setLatLng(latlng);
    surveyorMarkers[id].setIcon(icon);
    surveyorAccuracyCircles[id].setLatLng(latlng);
    surveyorAccuracyCircles[id].setRadius(s.accuracy || 5);
  }

  surveyorMarkers[id]
    .bindTooltip(s.name || 'Surveyor', { permanent: true, direction: 'top', offset: [0, -18] })
    .bindPopup(`
      <b>${escapeHtml(s.name || 'Surveyor')}</b><br>
      Lat: ${s.lat.toFixed(7)}<br>
      Lng: ${s.lng.toFixed(7)}<br>
      Akurasi: ${(s.accuracy || 0).toFixed(1)} m<br>
      Update: ${new Date(s.lastUpdate || Date.now()).toLocaleTimeString('id-ID')}
    `);
}

function removeSurveyorMarker(id) {
  if (surveyorMarkers[id]) map.removeLayer(surveyorMarkers[id]);
  if (surveyorAccuracyCircles[id]) map.removeLayer(surveyorAccuracyCircles[id]);
  delete surveyorMarkers[id];
  delete surveyorAccuracyCircles[id];
}

function handleKMLUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const kmlText = reader.result;
    const kmlDoc = new DOMParser().parseFromString(kmlText, 'text/xml');
    const geojson = toGeoJSON.kml(kmlDoc);
    loadedGeoJSON = normalizePointGeoJSON(geojson);

    db.ref('sharedGeoJSON').set({
      name: file.name,
      uploadedAt: Date.now(),
      data: loadedGeoJSON
    });
  };
  reader.readAsText(file);
}

function listenSharedGeoJSON() {
  db.ref('sharedGeoJSON').on('value', (snap) => {
    const payload = snap.val();
    if (!payload?.data) return;
    loadedGeoJSON = payload.data;
    loadGeoJSONToMap(loadedGeoJSON);
  });
}

function normalizePointGeoJSON(geojson) {
  const features = [];
  (geojson.features || []).forEach((feature, idx) => {
    if (feature.geometry?.type === 'Point') {
      feature.properties = feature.properties || {};
      feature.properties._id = feature.properties._id || makePointId(feature, idx);
      feature.properties._type = detectType(feature.properties.name || feature.properties.Name || `Titik ${idx + 1}`);
      features.push(feature);
    }
  });
  return { type: 'FeatureCollection', features };
}

function loadGeoJSONToMap(geojson) {
  Object.values(pointMarkers).forEach((m) => map.removeLayer(m));
  pointMarkers = {};
  points = [];

  (geojson.features || []).forEach((feature, index) => {
    if (feature.geometry?.type !== 'Point') return;
    const [lng, lat] = feature.geometry.coordinates;
    const name = feature.properties?.name || feature.properties?.Name || `Titik ${index + 1}`;
    const id = feature.properties?._id || makePointId(feature, index);
    const type = feature.properties?._type || detectType(name);

    const p = { id, name, type, lat, lng, feature };
    points.push(p);

    const marker = L.circleMarker([lat, lng], getPointStyle(id)).addTo(map);
    pointMarkers[id] = marker;

    marker.on('mouseover', () => marker.setStyle({ radius: 13, weight: 4 }));
    marker.on('mouseout', () => marker.setStyle(getPointStyle(id)));
    marker.on('click', () => openPointPopup(p));
    marker.bindTooltip(`${name} | ${isDone(id) ? 'Selesai' : 'Belum selesai'}`);
  });

  if (points.length > 0) {
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [30, 30] });
  }

  renderPointList();
  updatePointCounter();
  updateNearestPoint();
}

function openPointPopup(p) {
  const done = isDone(p.id);
  const btn = done
    ? `<button class="popup-btn danger" onclick="setPointDone('${p.id}', false)">Batalkan Selesai</button>`
    : `<button class="popup-btn success" onclick="setPointDone('${p.id}', true)">Tandai Selesai</button>`;

  pointMarkers[p.id].bindPopup(`
    <b>${escapeHtml(p.name)}</b><br>
    Tipe: ${escapeHtml(p.type)}<br>
    Status: <b>${done ? 'Selesai' : 'Belum selesai'}</b><br>
    Lat: ${p.lat.toFixed(7)}<br>
    Lng: ${p.lng.toFixed(7)}<br><br>
    ${btn}
  `).openPopup();
}

function listenPointStatus() {
  db.ref('pointStatus').on('value', (snap) => {
    pointStatus = snap.val() || {};
    Object.entries(pointMarkers).forEach(([id, marker]) => marker.setStyle(getPointStyle(id)));
    renderPointList();
    updatePointCounter();
  });
}

window.setPointDone = function setPointDone(id, done) {
  if (done) {
    db.ref(`pointStatus/${id}`).set({ status: 'done', finishedBy: myName || 'Unknown', finishedAt: Date.now() });
  } else {
    db.ref(`pointStatus/${id}`).remove();
  }
};

function finishNearestPoint() {
  if (!myPosition) {
    alert('Aktifkan monitoring GPS terlebih dahulu.');
    return;
  }
  if (!nearestPointId) {
    alert('Belum ada titik GCP/ICP. Upload KML terlebih dahulu.');
    return;
  }

  const p = points.find((item) => item.id === nearestPointId);
  const d = map.distance([myPosition.lat, myPosition.lng], [p.lat, p.lng]);
  if (d > FINISH_RADIUS_METER) {
    alert(`Anda masih ${d.toFixed(2)} m dari ${p.name}. Radius selesai: ${FINISH_RADIUS_METER} m.`);
    return;
  }
  window.setPointDone(nearestPointId, true);
}

function resetPointStatus() {
  if (!confirm('Reset semua status titik selesai?')) return;
  db.ref('pointStatus').remove();
}

function updateNearestPoint() {
  if (!myPosition || points.length === 0) {
    el('nearestPoint').textContent = '-';
    el('nearestDistance').textContent = '-';
    return;
  }

  let best = null;
  let bestDist = Infinity;
  points.forEach((p) => {
    const d = map.distance([myPosition.lat, myPosition.lng], [p.lat, p.lng]);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  });

  nearestPointId = best?.id || null;
  el('nearestPoint').textContent = best ? best.name : '-';
  el('nearestDistance').textContent = best ? `${bestDist.toFixed(2)} m` : '-';

  Object.entries(pointMarkers).forEach(([id, marker]) => marker.setStyle(getPointStyle(id)));
  if (nearestPointId && pointMarkers[nearestPointId] && !isDone(nearestPointId)) {
    pointMarkers[nearestPointId].setStyle({ color: '#f59e0b', fillColor: '#f59e0b', radius: 12, weight: 4 });
  }
}

function renderPointList() {
  const container = el('pointList');
  if (points.length === 0) {
    container.className = 'point-list empty';
    container.textContent = 'Belum ada KML yang dimuat.';
    return;
  }

  container.className = 'point-list';
  container.innerHTML = '';
  points.forEach((p) => {
    const done = isDone(p.id);
    const card = document.createElement('div');
    card.className = 'point-card';
    card.innerHTML = `
      <div class="point-title">
        <span>${escapeHtml(p.name)}</span>
        <span class="badge ${done ? 'done' : 'pending'}">${done ? 'Selesai' : 'Belum'}</span>
      </div>
      <div class="point-meta">${escapeHtml(p.type)} | ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</div>
    `;
    card.addEventListener('click', () => {
      map.setView([p.lat, p.lng], 20);
      openPointPopup(p);
    });
    container.appendChild(card);
  });
}

function updatePointCounter() {
  const total = points.length;
  const done = points.filter((p) => isDone(p.id)).length;
  el('donePointCount').textContent = `${done}/${total}`;
}

function getPointStyle(id) {
  const done = isDone(id);
  return {
    radius: 9,
    color: done ? '#16a34a' : '#dc2626',
    fillColor: done ? '#22c55e' : '#ef4444',
    fillOpacity: 0.9,
    weight: 2
  };
}

function isDone(id) {
  return pointStatus[id]?.status === 'done';
}

function exportGeoJSON() {
  if (!loadedGeoJSON) {
    alert('Belum ada GeoJSON. Upload KML terlebih dahulu.');
    return;
  }
  const blob = new Blob([JSON.stringify(loadedGeoJSON, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'gcp_icp_points.geojson';
  a.click();
  URL.revokeObjectURL(url);
}

function makePointId(feature, idx) {
  const name = feature.properties?.name || feature.properties?.Name || `point_${idx}`;
  const coords = feature.geometry?.coordinates || [0, 0];
  return `${name}_${coords[0]}_${coords[1]}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
}

function detectType(name) {
  const n = String(name || '').toUpperCase();
  if (n.includes('GCP')) return 'GCP';
  if (n.includes('ICP')) return 'ICP';
  return 'POINT';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

window.addEventListener('beforeunload', () => {
  if (myRef) myRef.remove();
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
});

const style = document.createElement('style');
style.textContent = `
  .surveyor-icon {
    width: 34px; height: 34px; border-radius: 50%;
    display: grid; place-items: center;
    background: #2563eb; color: #fff;
    border: 3px solid #fff;
    box-shadow: 0 5px 16px rgba(37,99,235,.45);
    font-weight: 900;
  }
  .popup-btn {
    border: 0; border-radius: 8px; padding: 8px 10px;
    color: white; font-weight: 800; cursor: pointer;
  }
  .popup-btn.success { background: #16a34a; }
  .popup-btn.danger { background: #dc2626; }
`;
document.head.appendChild(style);
