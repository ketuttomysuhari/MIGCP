const KML_URL = "https://raw.githubusercontent.com/ketuttomysuhari/MIGCP/master/lamatokan.kml";
const RADIUS_SELESAI = 25;

let map;
let targetLayer = L.featureGroup();
let boundaryLayer = L.featureGroup();
let surveyorLayer = L.featureGroup();

let pointData = {};
let pointMarkers = {};
let pointStatuses = {};

let surveyorMarkers = {};
let surveyorAccuracies = {};
let mySurveyorMarker = null;
let mySurveyorAccuracy = null;

let myPosition = null;
let myRef = null;
let watchId = null;

let myId = localStorage.getItem("migcp_surveyor_id");

if (!myId) {
  myId = "surveyor_" + Date.now() + "_" + Math.floor(Math.random() * 99999);
  localStorage.setItem("migcp_surveyor_id", myId);
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  bindUI();
  restoreName();
  initFirebaseStatus();
  loadKML();
  listenSurveyors();
  listenPointStatus();
  listenChat();
});

function bindUI() {
  document.getElementById("togglePanelBtn").addEventListener("click", togglePanel);
  document.getElementById("btnStartGps").addEventListener("click", startSurveyor);
  document.getElementById("btnNearest").addEventListener("click", toggleNearestStatus);
  document.getElementById("btnReset").addEventListener("click", resetPointStatus);
  document.getElementById("btnSendChat").addEventListener("click", sendChat);

  document.getElementById("chatInput").addEventListener("keydown", e => {
    if (e.key === "Enter") sendChat();
  });
}

function restoreName() {
  const saved = localStorage.getItem("migcp_surveyor_name") || "";
  document.getElementById("surveyorName").value = saved;
  if (saved) document.getElementById("myName").innerText = saved;
}

function togglePanel() {
  document.getElementById("controlPanel").classList.toggle("hidden");
}

function initMap() {
  map = L.map("map", { zoomControl: false }).setView([-8.3, 123.1], 15);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 22,
    attribution: "© OpenStreetMap"
  }).addTo(map);

  const sat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 22,
      attribution: "Tiles © Esri"
    }
  );

  targetLayer.addTo(map);
  boundaryLayer.addTo(map);
  surveyorLayer.addTo(map);

  L.control.layers(
    {
      "OpenStreetMap": osm,
      "Satelit Esri": sat
    },
    {
      "Target GCP/ICP/BM": targetLayer,
      "Batas Area": boundaryLayer,
      "Surveyor Online": surveyorLayer
    },
    {
      position: "topright",
      collapsed: true
    }
  ).addTo(map);
}

function initFirebaseStatus() {
  db.ref(".info/connected").on("value", snap => {
    const el = document.getElementById("firebaseStatus");

    if (snap.val() === true) {
      el.innerText = "terhubung";
      el.className = "status-ok";
    } else {
      el.innerText = "tidak terhubung";
      el.className = "status-warn";
    }
  });
}

async function loadKML() {
  try {
    const response = await fetch(KML_URL + "?t=" + Date.now());

    if (!response.ok) {
      throw new Error("KML tidak ditemukan: " + response.status);
    }

    const text = await response.text();
    const kml = new DOMParser().parseFromString(text, "text/xml");
    const geojson = toGeoJSON.kml(kml);

    targetLayer.clearLayers();
    boundaryLayer.clearLayers();

    pointData = {};
    pointMarkers = {};

    const targetGeoJson = L.geoJSON(geojson, {
      filter: feature => feature.geometry && feature.geometry.type === "Point",

      pointToLayer: (feature, latlng) => {
        const name = getName(feature);
        const type = detectType(feature, name);
        const id = makePointId(feature, latlng);
        const done = !!pointStatuses[id];
        const color = getPointColor(type, done);

        const marker = L.circleMarker(latlng, {
          radius: type === "GCP" || type === "ICP" || type === "BM" ? 10 : 7,
          color,
          fillColor: color,
          fillOpacity: 0.95,
          weight: done ? 4 : 2
        });

        pointData[id] = {
          id,
          name,
          type,
          lat: latlng.lat,
          lng: latlng.lng
        };

        pointMarkers[id] = marker;

        marker.bindTooltip(name, {
          sticky: true,
          direction: "top"
        });

        updatePointPopup(id);

        return marker;
      }
    });

    const boundaryGeoJson = L.geoJSON(geojson, {
      filter: feature => {
        if (!feature.geometry) return false;
        return feature.geometry.type.includes("Polygon") ||
               feature.geometry.type.includes("LineString");
      },

      style: {
        color: "#7c3aed",
        weight: 3,
        opacity: 0.95,
        fillColor: "#a78bfa",
        fillOpacity: 0.12,
        dashArray: "8,6"
      },

      onEachFeature: (feature, layer) => {
        const name = getName(feature);
        layer.bindTooltip(name || "Batas", { sticky: true });
        layer.bindPopup(`<b>${escapeHtml(name || "Batas")}</b>`);
      }
    });

    targetGeoJson.addTo(targetLayer);
    boundaryGeoJson.addTo(boundaryLayer);

    document.getElementById("kmlStatus").innerText = "terbaca";
    document.getElementById("kmlStatus").className = "status-ok";
    document.getElementById("targetCount").innerText = Object.keys(pointData).length;

    renderTargetList();

    const all = L.featureGroup([targetLayer, boundaryLayer]);

    if (all.getBounds().isValid()) {
      map.fitBounds(all.getBounds(), { padding: [30, 30] });
    }

  } catch (err) {
    console.error(err);
    document.getElementById("kmlStatus").innerText = "gagal";
    document.getElementById("kmlStatus").className = "status-warn";
    alert("KML gagal dibaca. Pastikan file data/lamatokan.kml ada.");
  }
}

function startSurveyor() {
  const name = requireName();
  if (!name) return;

  if (!navigator.geolocation) {
    alert("Browser tidak mendukung GPS.");
    return;
  }

  myRef = db.ref("surveyors/" + myId);
  myRef.onDisconnect().remove();

  document.getElementById("gpsStatus").innerText = "meminta izin...";

  watchId = navigator.geolocation.watchPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = pos.coords.accuracy;

      myPosition = { lat, lng, acc };

      document.getElementById("gpsStatus").innerText = "aktif";
      document.getElementById("gpsStatus").className = "status-ok";
      document.getElementById("lat").innerText = lat.toFixed(7);
      document.getElementById("lng").innerText = lng.toFixed(7);
      document.getElementById("acc").innerText = acc.toFixed(1);

      drawMySurveyorMarker(lat, lng, acc, name);

      myRef.set({
        id: myId,
        name,
        lat,
        lng,
        accuracy: acc,
        lastUpdate: Date.now()
      });

      updateNearestPoint();

      if (!window.hasCenteredGPS) {
        map.setView([lat, lng], 19);
        window.hasCenteredGPS = true;
      }
    },
    err => {
      document.getElementById("gpsStatus").innerText = "gagal";
      document.getElementById("gpsStatus").className = "status-warn";
      alert("GPS gagal: " + err.message);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000
    }
  );
}

function drawMySurveyorMarker(lat, lng, acc, name) {
  const pos = [lat, lng];

  if (!mySurveyorMarker) {
    mySurveyorMarker = L.circleMarker(pos, {
      radius: 13,
      color: "#1d4ed8",
      fillColor: "#2563eb",
      fillOpacity: 1,
      weight: 4
    }).addTo(surveyorLayer);

    mySurveyorAccuracy = L.circle(pos, {
      radius: acc,
      color: "#2563eb",
      fillColor: "#60a5fa",
      fillOpacity: 0.15,
      weight: 1
    }).addTo(surveyorLayer);

    mySurveyorMarker.bindTooltip("Saya: " + name, {
      permanent: true,
      direction: "top"
    });
  } else {
    mySurveyorMarker.setLatLng(pos);
    mySurveyorAccuracy.setLatLng(pos);
    mySurveyorAccuracy.setRadius(acc);
  }

  mySurveyorMarker.bindPopup(`
    <b>Posisi Saya</b><br>
    Nama: ${escapeHtml(name)}<br>
    Lat: ${lat.toFixed(7)}<br>
    Lng: ${lng.toFixed(7)}<br>
    Akurasi: ${acc.toFixed(1)} m
  `);
}

function listenSurveyors() {
  db.ref("surveyors").on("value", snap => {
    const data = snap.val() || {};
    const ids = Object.keys(data);

    Object.keys(surveyorMarkers).forEach(id => {
      if (!data[id] || id === myId) {
        if (surveyorMarkers[id]) surveyorLayer.removeLayer(surveyorMarkers[id]);
        if (surveyorAccuracies[id]) surveyorLayer.removeLayer(surveyorAccuracies[id]);
        delete surveyorMarkers[id];
        delete surveyorAccuracies[id];
      }
    });

    let html = "";

    ids.forEach(id => {
      const s = data[id];

      if (!s || typeof s.lat !== "number" || typeof s.lng !== "number") return;

      html += `
        <div class="surveyor-item" onclick="focusSurveyor('${id}')">
          ${id === myId ? "🟦 Saya" : "🔵"} <b>${escapeHtml(s.name)}</b><br>
          <span class="small">${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}</span>
        </div>
      `;

      if (id === myId) return;

      const pos = [s.lat, s.lng];

      if (!surveyorMarkers[id]) {
        surveyorMarkers[id] = L.circleMarker(pos, {
          radius: 11,
          color: "#0f766e",
          fillColor: "#14b8a6",
          fillOpacity: 1,
          weight: 3
        }).addTo(surveyorLayer);

        surveyorAccuracies[id] = L.circle(pos, {
          radius: s.accuracy || 5,
          color: "#0f766e",
          fillColor: "#5eead4",
          fillOpacity: 0.12,
          weight: 1
        }).addTo(surveyorLayer);
      } else {
        surveyorMarkers[id].setLatLng(pos);
        surveyorAccuracies[id].setLatLng(pos);
        surveyorAccuracies[id].setRadius(s.accuracy || 5);
      }

      surveyorMarkers[id].bindTooltip(s.name, {
        permanent: true,
        direction: "top"
      });

      surveyorMarkers[id].bindPopup(`
        <b>${escapeHtml(s.name)}</b><br>
        Status: Online<br>
        Lat: ${s.lat.toFixed(7)}<br>
        Lng: ${s.lng.toFixed(7)}<br>
        Akurasi: ${(s.accuracy || 0).toFixed(1)} m<br>
        Update: ${s.lastUpdate ? new Date(s.lastUpdate).toLocaleTimeString() : "-"}
      `);
    });

    document.getElementById("activeSurveyors").innerHTML = html || "-";
  });
}

function listenPointStatus() {
  db.ref("pointStatus").on("value", snap => {
    pointStatuses = snap.val() || {};

    Object.keys(pointMarkers).forEach(id => {
      refreshPointStyle(id);
    });

    renderTargetList();
  });
}

function togglePointStatus(pointId) {
  const name = requireName();
  if (!name) return;

  if (pointStatuses[pointId]) {
    db.ref("pointStatus/" + pointId).remove();
  } else {
    db.ref("pointStatus/" + pointId).set({
      status: "selesai",
      by: name,
      time: Date.now()
    });
  }
}

function toggleNearestStatus() {
  if (!myPosition) {
    alert("Aktifkan GPS dulu.");
    return;
  }

  const nearest = getNearestPoint();
  if (!nearest) return;

  if (nearest.distance > RADIUS_SELESAI) {
    alert(`Titik terdekat ${nearest.point.name}, jarak ${nearest.distance.toFixed(2)} m. Maksimal ${RADIUS_SELESAI} m.`);
    return;
  }

  togglePointStatus(nearest.point.id);
}

function resetPointStatus() {
  if (!confirm("Reset semua status selesai?")) return;
  db.ref("pointStatus").remove();
}

function refreshPointStyle(id) {
  const p = pointData[id];
  const marker = pointMarkers[id];

  if (!p || !marker) return;

  const done = !!pointStatuses[id];
  const color = getPointColor(p.type, done);

  marker.setStyle({
    color,
    fillColor: color,
    weight: done ? 4 : 2
  });

  updatePointPopup(id);
}

function updatePointPopup(id) {
  const p = pointData[id];
  const marker = pointMarkers[id];

  if (!p || !marker) return;

  const done = !!pointStatuses[id];
  const status = pointStatuses[id];

  marker.bindPopup(`
    <b>${escapeHtml(p.name)}</b><br>
    Tipe: ${p.type}<br>
    Status: <b>${done ? "Selesai" : "Belum selesai"}</b><br>
    ${done ? "Oleh: " + escapeHtml(status.by || "-") + "<br>" : ""}
    Lat: ${p.lat.toFixed(7)}<br>
    Lng: ${p.lng.toFixed(7)}<br><br>
    <button onclick="togglePointStatus('${id}')" style="padding:8px 10px;border:0;border-radius:8px;background:${done ? "#dc2626" : "#16a34a"};color:white;cursor:pointer;">
      ${done ? "Batalkan Selesai" : "Tandai Selesai"}
    </button>
  `);
}

function sendChat() {
  const name = requireName();
  if (!name) return;

  const input = document.getElementById("chatInput");
  const text = input.value.trim();

  if (!text) return;

  db.ref("chat").push({
    name,
    text,
    time: Date.now()
  });

  input.value = "";
}

function listenChat() {
  db.ref("chat").limitToLast(50).on("value", snap => {
    const data = snap.val() || {};
    const box = document.getElementById("chatBox");

    box.innerHTML = Object.values(data).map(c => `
      <div class="chat-item">
        <b>${escapeHtml(c.name)}</b> - ${escapeHtml(c.text)}<br>
        <span class="small">${new Date(c.time).toLocaleTimeString()}</span>
      </div>
    `).join("");

    box.scrollTop = box.scrollHeight;
  });
}

function renderTargetList() {
  const points = Object.values(pointData);
  const box = document.getElementById("targetList");

  if (!points.length) {
    box.innerHTML = "Belum ada titik";
    return;
  }

  box.innerHTML = points.map(p => {
    const done = !!pointStatuses[p.id];

    return `
      <div class="target-item" onclick="focusTarget('${p.id}')">
        ${done ? "🟢" : iconByType(p.type)} <b>${escapeHtml(p.name)}</b><br>
        <span class="small">${p.type} | ${done ? "Selesai" : "Belum selesai"}</span>
      </div>
    `;
  }).join("");
}

function focusTarget(id) {
  const marker = pointMarkers[id];
  if (!marker) return;

  map.setView(marker.getLatLng(), 20);
  marker.openPopup();
}

function focusSurveyor(id) {
  if (id === myId && mySurveyorMarker) {
    map.setView(mySurveyorMarker.getLatLng(), 20);
    mySurveyorMarker.openPopup();
    return;
  }

  const marker = surveyorMarkers[id];
  if (!marker) return;

  map.setView(marker.getLatLng(), 20);
  marker.openPopup();
}

function getNearestPoint() {
  const points = Object.values(pointData);

  if (!points.length) return null;

  let nearest = null;
  let min = Infinity;

  points.forEach(p => {
    const d = map.distance([myPosition.lat, myPosition.lng], [p.lat, p.lng]);

    if (d < min) {
      min = d;
      nearest = p;
    }
  });

  return {
    point: nearest,
    distance: min
  };
}

function updateNearestPoint() {
  const nearest = getNearestPoint();

  if (!nearest) return;

  document.getElementById("nearest").innerText = nearest.point.name;
  document.getElementById("dist").innerText = nearest.distance.toFixed(2);
}

function requireName() {
  const name = document.getElementById("surveyorName").value.trim();

  if (!name) {
    alert("Isi nama surveyor terlebih dahulu.");
    return null;
  }

  localStorage.setItem("migcp_surveyor_name", name);
  document.getElementById("myName").innerText = name;

  return name;
}

function getName(feature) {
  const p = feature.properties || {};

  return p.name || p.Name || p.NAMA || p.Nama || p.description || "Tanpa Nama";
}

function detectType(feature, name) {
  const text = (JSON.stringify(feature.properties || {}) + " " + name).toUpperCase();
  const geom = feature.geometry ? feature.geometry.type : "";

  if (text.includes("GCP")) return "GCP";
  if (text.includes("ICP")) return "ICP";
  if (text.includes("BM")) return "BM";
  if (geom.includes("Polygon")) return "BATAS";
  if (geom.includes("LineString")) return "BATAS";

  return "POINT";
}

function getPointColor(type, done) {
  if (done) return "#16a34a";
  if (type === "GCP") return "#dc2626";
  if (type === "ICP") return "#f59e0b";
  if (type === "BM") return "#0f172a";
  return "#6366f1";
}

function makePointId(feature, latlng) {
  return `${getName(feature)}_${latlng.lat.toFixed(7)}_${latlng.lng.toFixed(7)}`
    .replace(/[.#$[\]/\s]/g, "_");
}

function iconByType(type) {
  if (type === "GCP") return "🔴";
  if (type === "ICP") return "🟠";
  if (type === "BM") return "⚫";
  return "🔵";
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.addEventListener("beforeunload", () => {
  if (myRef) myRef.remove();
  if (watchId) navigator.geolocation.clearWatch(watchId);
});
