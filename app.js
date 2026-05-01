/* global L, toGeoJSON, firebaseConfig, firebase, JSZip */

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
let boundaryLayer = null;
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
  el('kmlInput').addEventListener('change', handleSpatialUpload);
  el('btnFinishNearest').addEventListener('click', finishNearestPoint);
  el('btnResetPoints').addEventListener('click', resetPointStatus);
  el('btnExportGeoJSON').addEventListener('click', exportGeoJSON);
}

function startMonitoring() {
  myName = el('surveyorName').value.trim() || `Surveyor ${myId.slice(0, 4)}`;
  el('surveyorName').value = myName;
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
  const html = `<div class="surveyor-dot"><span>${escapeHtml((s.name || 'S').charAt(0).toUpperCase())}</span></div>`;
  const icon = L.divIcon({ html, className: 'clean-div-icon', iconSize: [38, 38], iconAnchor: [19, 19] });

  if (!surveyorMarkers[id]) {
    surveyorMarkers[id] = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(map);
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
    .bindTooltip(s.name || 'Surveyor', { permanent: true, direction: 'top', offset: [0, -20] })
    .bindPopup(`
      <b>${escapeHtml(s.name || 'Surveyor')}</b><br>
      Posisi surveyor aktif<br>
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

async function handleSpatialUpload(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;

  try {
    const mergedFeatures = [];
    const fileNames = [];

    for (const file of files) {
      const kmlText = await readKmlOrKmz(file);
      const kmlDoc = new DOMParser().parseFromString(kmlText, 'text/xml');
      const parseError = kmlDoc.querySelector('parsererror');
      if (parseError) throw new Error(`${file.name} bukan KML/KMZ valid.`);

      const geojson = toGeoJSON.kml(kmlDoc);
      const normalized = normalizeGeoJSON(geojson, file.name);
      mergedFeatures.push(...normalized.features);
      fileNames.push(file.name);
    }

    loadedGeoJSON = {
      type: 'FeatureCollection',
      features: mergedFeatures
    };

    db.ref('sharedGeoJSON').set({
      name: fileNames.join(', '),
      uploadedAt: Date.now(),
      data: loadedGeoJSON
    });
  } catch (err) {
    alert(`Gagal membaca file: ${err.message}`);
  }
}

async function readKmlOrKmz(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.kml')) return await file.text();

  if (name.endsWith('.kmz')) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const kmlFileName = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith('.kml'));
    if (!kmlFileName) throw new Error('KMZ tidak berisi file .kml.');
    return await zip.files[kmlFileName].async('text');
  }

  throw new Error('Format belum didukung. Gunakan .kml atau .kmz.');
}

function listenSharedGeoJSON() {
  db.ref('sharedGeoJSON').on('value', (snap) => {
    const payload = snap.val();
    if (!payload?.data) return;
    loadedGeoJSON = payload.data;
    loadGeoJSONToMap(loadedGeoJSON);
  });
}

function normalizeGeoJSON(geojson, sourceName = '') {
  const features = [];
  (geojson.features || []).forEach((feature, idx) => {
    if (!feature.geometry) return;
    feature.properties = feature.properties || {};
    feature.properties._source = sourceName;
    feature.properties._id = feature.properties._id || makeFeatureId(feature, idx, sourceName);
    feature.properties._type = detectType(feature.properties.name || feature.properties.Name || `Objek ${idx + 1}`, feature.geometry.type);
    features.push(feature);
  });
  return { type: 'FeatureCollection', features };
}

function loadGeoJSONToMap(geojson) {
  Object.values(pointMarkers).forEach((m) => map.removeLayer(m));
  pointMarkers = {};
  points = [];

  if (boundaryLayer) map.removeLayer(boundaryLayer);

  const boundaryFeatures = [];

  (geojson.features || []).forEach((feature, index) => {
    if (!feature.geometry) return;

    if (feature.geometry.type === 'Point') {
      addPointFeature(feature, index);
    } else {
      boundaryFeatures.push(feature);
    }
  });

  if (boundaryFeatures.length > 0) {
    boundaryLayer = L.geoJSON({ type: 'FeatureCollection', features: boundaryFeatures }, {
      style: getBoundaryStyle,
      onEachFeature: (feature, layer) => {
        const name = feature.properties?.name || feature.properties?.Name || feature.properties?._type || 'Batas Area';
        layer.bindTooltip(`${escapeHtml(name)} | ${feature.geometry.type}`);
        layer.bindPopup(`
          <b>${escapeHtml(name)}</b><br>
          Tipe geometri: ${escapeHtml(feature.geometry.type)}<br>
          Kategori: ${escapeHtml(feature.properties?._type || 'BATAS')}
        `);
      }
    }).addTo(map);
  }

  const layers = [];
  if (boundaryLayer) layers.push(boundaryLayer);
  Object.values(pointMarkers).forEach((m) => layers.push(m));

  if (layers.length > 0) {
    const group = L.featureGroup(layers);
    map.fitBounds(group.getBounds(), { padding: [35, 35] });
  }

  renderPointList();
  updatePointCounter();
  updateNearestPoint();
}

function addPointFeature(feature, index) {
  const [lng, lat] = feature.geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const name = feature.properties?.name || feature.properties?.Name || `Titik ${index + 1}`;
  const id = feature.properties?._id || makeFeatureId(feature, index);
  const type = feature.properties?._type || detectType(name, feature.geometry.type);

  const p = { id, name, type, lat, lng, feature };
  points.push(p);

  const marker = L.marker([lat, lng], { icon: getPointIcon(id, type), zIndexOffset: 500 }).addTo(map);
  pointMarkers[id] = marker;

  marker.on('click', () => openPointPopup(p));
  marker.on('mouseover', () => marker.setIcon(getPointIcon(id, type, true)));
  marker.on('mouseout', () => marker.setIcon(getPointIcon(id, type, false)));
  marker.bindTooltip(`${name} | ${type} | ${isDone(id) ? 'Selesai' : 'Belum selesai'}`);
}

function getBoundaryStyle(feature) {
  const geom = feature.geometry?.type || '';
  if (geom.includes('Polygon')) {
    return {
      color: '#7c3aed',
      fillColor: '#8b5cf6',
      fillOpacity: 0.12,
      weight: 3,
      dashArray: '8 6'
    };
  }
  return {
    color: '#7c3aed',
    weight: 4,
    dashArray: '8 6'
  };
}

function openPointPopup(p) {
  const done = isDone(p.id);
  const status = pointStatus[p.id] || {};
  const btn = done
    ? `<button class="popup-btn danger" onclick="setPointDone('${p.id}', false)">Batalkan Selesai</button>`
    : `<button class="popup-btn success" onclick="setPointDone('${p.id}', true)">Tandai Selesai</button>`;

  const finishedInfo = done
    ? `<br>Selesai oleh: ${escapeHtml(status.finishedBy || '-')}<br>Waktu: ${new Date(status.finishedAt || Date.now()).toLocaleString('id-ID')}`
    : '';

  pointMarkers[p.id].bindPopup(`
    <b>${escapeHtml(p.name)}</b><br>
    Tipe: ${escapeHtml(p.type)}<br>
    Status: <b>${done ? 'Selesai' : 'Belum selesai'}</b>${finishedInfo}<br>
    Lat: ${p.lat.toFixed(7)}<br>
    Lng: ${p.lng.toFixed(7)}<br><br>
    ${btn}
  `).openPopup();
}

function listenPointStatus() {
  db.ref('pointStatus').on('value', (snap) => {
    pointStatus = snap.val() || {};
    points.forEach((p) => {
      if (pointMarkers[p.id]) {
        pointMarkers[p.id].setIcon(getPointIcon(p.id, p.type));
        pointMarkers[p.id].bindTooltip(`${p.name} | ${p.type} | ${isDone(p.id) ? 'Selesai' : 'Belum selesai'}`);
      }
    });
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
    alert('Belum ada titik GCP/ICP. Upload KML/KMZ terlebih dahulu.');
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

  points.forEach((p) => {
    if (pointMarkers[p.id]) pointMarkers[p.id].setIcon(getPointIcon(p.id, p.type));
  });
  if (nearestPointId && pointMarkers[nearestPointId] && !isDone(nearestPointId)) {
    const p = points.find((item) => item.id === nearestPointId);
    pointMarkers[nearestPointId].setIcon(getPointIcon(nearestPointId, p.type, true, true));
  }
}

function renderPointList() {
  const container = el('pointList');
  if (points.length === 0) {
    container.className = 'point-list empty';
    container.textContent = 'Belum ada KML/KMZ yang dimuat.';
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
        <span><i class="tiny-dot ${p.type.toLowerCase()}"></i>${escapeHtml(p.name)}</span>
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

function getPointIcon(id, type, hover = false, nearest = false) {
  const done = isDone(id);
  const t = String(type || 'POINT').toUpperCase();
  const label = t === 'GCP' ? 'G' : t === 'ICP' ? 'I' : 'P';
  const clsType = t === 'GCP' ? 'gcp' : t === 'ICP' ? 'icp' : 'point';
  const size = nearest ? 42 : hover ? 40 : 34;
  const html = `<div class="control-dot ${clsType} ${done ? 'done' : ''} ${nearest ? 'nearest' : ''}" style="width:${size}px;height:${size}px"><span>${label}</span></div>`;
  return L.divIcon({ html, className: 'clean-div-icon', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function isDone(id) {
  return pointStatus[id]?.status === 'done';
}

function exportGeoJSON() {
  if (!loadedGeoJSON) {
    alert('Belum ada GeoJSON. Upload KML/KMZ terlebih dahulu.');
    return;
  }
  const blob = new Blob([JSON.stringify(loadedGeoJSON, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'gcp_icp_boundary.geojson';
  a.click();
  URL.revokeObjectURL(url);
}

function makeFeatureId(feature, idx, sourceName = '') {
  const name = feature.properties?.name || feature.properties?.Name || `feature_${idx}`;
  const coords = JSON.stringify(feature.geometry?.coordinates || [0, 0]).slice(0, 90);
  return `${sourceName}_${name}_${feature.geometry?.type}_${coords}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
}

function detectType(name, geometryType) {
  const n = String(name || '').toUpperCase();
  if (geometryType !== 'Point') {
    if (n.includes('BATAS') || n.includes('BOUNDARY') || n.includes('AOI') || n.includes('AREA')) return 'BATAS';
    return 'BATAS';
  }
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
