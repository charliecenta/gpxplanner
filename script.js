// Route Time Estimator — Clean V2 (Print=Table only; no map image in PDF)
// - Live Leaflet map for planning (not printed)
// - GPX processing: resample, smooth, deadband filter, per-step time model
// - Waypoints/roadbooks import + on-map add/remove
// - Roadbooks table: grouped headers, editable Name/Stops/Conditions
// - Save/Load JSON, Export CSV (DOM), Simple Print (window.print)

// ---------- DOM ----------
const outputEl = document.getElementById("output");
const roadbooksEl = document.getElementById("roadbooks");

const calcBtn  = document.getElementById("calculateBtn");
const clearBtn = document.getElementById("clearRoadbooksBtn");
const saveBtn   = document.getElementById("savePlanBtn");
const loadBtn   = document.getElementById("loadPlanBtn");
const loadInput = document.getElementById("loadPlanInput");
const exportCsv = document.getElementById("exportCsvBtn");
const printBtn  = document.getElementById("printBtn");

// === Activity & Advanced Configuration (single source of truth) ===
const activitySel = document.getElementById("activityType");
const showAdvChk  = document.getElementById("showAdvanced");

// Presets: spacing (m), smoothing window (m), flat speed (km/h), vertical speed (m/h), downhill factor
const ACTIVITY_PRESETS = {
  road:   { spacing: 5, smooth: 40, speedFlat: 24, speedVert: 900, dhf: 0.40 },   // Road cycling
  mtb:    { spacing: 4, smooth: 20, speedFlat: 14, speedVert: 700, dhf: 0.60 },   // Mountain biking
  hike:   { spacing: 3, smooth: 15, speedFlat:  4, speedVert: 300, dhf: 0.6667 }, // Hiking / trail
};

function applyActivityPreset(kind) {
  const p = ACTIVITY_PRESETS[kind];
  if (!p) return;

  // Advanced fields
  const spacingInput = document.getElementById("spacingM");
  const smoothInput  = document.getElementById("smoothWinM");
  if (spacingInput) spacingInput.value = p.spacing;
  if (smoothInput)  smoothInput.value  = p.smooth;

  // Pace model fields
  const flat = document.getElementById("speedFlat");
  const vert = document.getElementById("speedVert");
  const dhf  = document.getElementById("downhillFactor");
  if (flat) flat.value = p.speedFlat;
  if (vert) vert.value = p.speedVert;
  if (dhf)  dhf.value  = p.dhf;
}

// ---------- Global state ----------
let map, tileLayer, polyline, markers = [];
let trackLatLngs = [];        // [[lat, lon], ...] (resampled)
let trackBreakIdx = [];       // segment starts
let cumDistKm = [];           // prefix sums
let cumAscentM = [];
let cumDescentM = [];
let cumTimeH = [];

let roadbookIdx = [];         // indices into trackLatLngs
let roadbookLabels = new Map(); // pointIndex -> label
let legLabels = new Map();      // "a|b" -> custom leg name

// Per-leg overrides
let legStopsMin = new Map();   // "a|b" -> minutes
let legCondPct  = new Map();   // "a|b" -> percent
let legCritical = new Map();   // "a|b" -> true (Yes) / false (No)

// Holds the sum of leg times including Stops + Conditions
let lastTotalAdjustedH = 0;

// Helper to toggle visibility of main sections
function showMainSections(show) {
  const ids = ['mapCard', 'summaryCard', 'roadbooksCard'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('is-hidden', !show);
  });
}

showMainSections(false);

// ---------- Map init (live only) ----------
function ensureMap() {
  if (map) return;
  map = L.map('map');
  tileLayer = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }
  ).addTo(map);

  map.on('click', (e) => {
    if (!trackLatLngs.length) return;
    const i = nearestIndexOnTrack([e.latlng.lat, e.latlng.lng], trackLatLngs);
    addRoadbookIndex(i);
  });
}
ensureMap();

// Advanced toggle: show/hide advanced fields
if (showAdvChk) {
  showAdvChk.addEventListener('change', () => {
    const card = document.getElementById('settingsCard');
    card?.classList.toggle('show-adv', showAdvChk.checked);
  });
  // default hidden (unchecked)
  showAdvChk.checked = false;
  document.getElementById('settingsCard')?.classList.remove('show-adv');
}

// Apply activity preset on change
if (activitySel) {
  activitySel.addEventListener('change', () => applyActivityPreset(activitySel.value));
  // Initial preset on load
  applyActivityPreset(activitySel.value || 'hike');
}


// ---------- Main flow ----------
calcBtn.addEventListener("click", async () => {
  const fileInput = document.getElementById("gpxFile");
  if (!fileInput?.files?.length) {
    alert("Please upload a GPX file.");
    return;
  }

  const importRoadbooks = document.getElementById("importRoadbooks")?.checked ?? true;

  const speedFlatKmh   = toPosNum(document.getElementById("speedFlat")?.value, 4);
  const speedVertMh    = toPosNum(document.getElementById("speedVert")?.value, 300);
  const downhillFactor = toPosNum(document.getElementById("downhillFactor")?.value, 0.6667);
  const spacingM       = clamp(toPosNum(document.getElementById("spacingM")?.value, 5), 1, 100);
  const smoothWinM     = clamp(toPosNum(document.getElementById("smoothWinM")?.value, 35), 5, 500);
  const elevDeadbandM  = clamp(toNonNegNum(document.getElementById("elevDeadbandM")?.value, 2), 0, 20);

  if (!(speedFlatKmh > 0) || !(speedVertMh > 0) || !(downhillFactor > 0)) {
    alert("Please provide valid positive numbers for speeds and downhill factor.");
    return;
  }

  const gpxText = await readFileAsText(fileInput.files[0]);
  const segments = parseGPXToSegments(gpxText);
  if (!segments.length) {
    outputEl.innerHTML = "<p>No track segments found.</p>";
    return;
  }

  // reset globals
  trackLatLngs = [];
  trackBreakIdx = [];
  cumDistKm = [0];
  cumAscentM = [0];
  cumDescentM = [0];
  cumTimeH = [0];
  roadbookIdx = [];
  roadbookLabels.clear();
  legLabels.clear();
  legStopsMin.clear();
  legCondPct.clear();
  legCritical.clear();
  clearMarkers();

  let totalDistKm = 0, totalAscentM = 0, totalDescentM = 0, totalTimeHrs = 0;
  const debugRows = [];
  let globalIdxOffset = 0;

  for (const pts of segments) {
    if (pts.length < 2) continue;

    const filled = fillElevationOnPoints(pts);
    const resampled = resampleByDistance(filled, spacingM);
    if (resampled.length < 2) continue;

    const winSamples = clampToOdd(Math.max(3, Math.round(smoothWinM / spacingM)), 3, 999);
    const elev = resampled.map(p => p.ele);
    const elevSmooth = medianFilter(elev, winSamples);
    const elevFiltered = cumulativeDeadbandFilter(elevSmooth, elevDeadbandM);

    // Mark where this segment starts in the global point list
    trackBreakIdx.push(trackLatLngs.length);

    // ✅ Keep cumulative arrays aligned with points at segment boundaries.
    // If we already have points, push a carry-forward so cum* arrays gain +1 here.
    if (trackLatLngs.length > 0) {
      cumDistKm.push(cumDistKm[cumDistKm.length - 1]);
      cumAscentM.push(cumAscentM[cumAscentM.length - 1]);
      cumDescentM.push(cumDescentM[cumDescentM.length - 1]);
      cumTimeH.push(cumTimeH[cumTimeH.length - 1]);
    }

    // Append this segment’s coordinates (points count +n)
    const latlngs = resampled.map(p => [p.lat, p.lon]);
    trackLatLngs = trackLatLngs.concat(latlngs);

    // Accumulate per-step values (steps count +(n-1))
    for (let i = 1; i < resampled.length; i++) {
      const curIdx  = globalIdxOffset + i;

      const p1 = resampled[i - 1];
      const p2 = resampled[i];
      const distKm = haversineKm(p1.lat, p1.lon, p2.lat, p2.lon);

      const dEleF = (elevFiltered[i] ?? elevFiltered[i - 1]) - (elevFiltered[i - 1] ?? elevFiltered[i]);
      const ascentM  = dEleF > 0 ? dEleF : 0;
      const descentM = dEleF < 0 ? -dEleF : 0;

      const h = distKm / speedFlatKmh; // hours
      const vMag = ascentM > 0 ? ascentM : descentM;
      const v = vMag > 0 ? (vMag / speedVertMh) : 0;

      let segTimeH = Math.max(h, v) + 0.5 * Math.min(h, v);
      if (descentM > 0 && descentM >= ascentM) segTimeH *= downhillFactor;

      totalDistKm   += distKm;
      totalAscentM  += ascentM;
      totalDescentM += descentM;
      totalTimeHrs  += segTimeH;

      // cum* arrays gain +1 per step here
      cumDistKm.push(cumDistKm[cumDistKm.length - 1] + distKm);
      cumAscentM.push(cumAscentM[cumAscentM.length - 1] + ascentM);
      cumDescentM.push(cumDescentM[cumDescentM.length - 1] + descentM);
      cumTimeH.push(cumTimeH[cumTimeH.length - 1] + segTimeH);

      debugRows.push({
        i: curIdx,
        distKm,
        dEleSmooth: Math.round((elevSmooth[i] ?? 0) - (elevSmooth[i - 1] ?? 0)),
        dEleFiltered: Math.round(dEleF),
        ascentM,
        descentM,
        segTimeH
      });
    }

    // Advance global index by number of points in this segment
    globalIdxOffset += resampled.length;
  }


  // draw polyline on live map
  if (polyline) polyline.remove();
  polyline = L.polyline(trackLatLngs, { weight: 4, color: '#2a7de1' }).addTo(map);
  map.fitBounds(polyline.getBounds());
  clearBtn.disabled = false;

  // add start/end roadbooks
  if (trackLatLngs.length >= 2) {
    addRoadbookIndex(0, { noRender: true, label: "Start", locked: true });
    addRoadbookIndex(trackLatLngs.length - 1, { noRender: true, label: "Finish", locked: true });
  }

  // import roadbooks from GPX file
  if (importRoadbooks) {
    const waypoints = parseGPXRoadbooks(gpxText);
    for (const wp of waypoints) {
      const idx = nearestIndexOnTrack([wp.lat, wp.lon], trackLatLngs);
      if (!roadbookIdx.includes(idx)) addRoadbookIndex(idx, { noRender: true, label: wp.name || "WP" });
      else if (!roadbookLabels.get(idx) && wp.name) setRoadbookLabel(idx, wp.name);
    }
  }

  renderRoadbooksTable();

  // Refresh Summary using the latest cumulative arrays
  updateSummaryCard();


  showMainSections(true);

  // Now that the map is visible, force Leaflet to recalc size and refit
  requestAnimationFrame(() => {
    try {
      map.invalidateSize(true);
      if (polyline) map.fitBounds(polyline.getBounds(), { padding: [20, 20] });
    } catch (e) {
      console.warn('invalidateSize/fitBounds failed:', e);
    }
  });



  // enable actions
  saveBtn.disabled   = false;
  exportCsv.disabled = false;
  printBtn.disabled  = true;   // will enable after table render to ensure presence
  setTimeout(() => { printBtn.disabled = false; }, 0);
});



clearBtn.addEventListener('click', () => {
  if (!trackLatLngs.length) return;
  roadbookIdx = [];
  roadbookLabels.clear();
  legLabels.clear();
  legStopsMin.clear();
  legCondPct.clear();
  legCritical.clear();
  clearMarkers();
  addRoadbookIndex(0, { noRender: true, label: "Start", locked: true });
  addRoadbookIndex(trackLatLngs.length - 1, { noRender: true, label: "Finish", locked: true });
  renderRoadbooksTable();
});

// ---------- Print (table-only) ----------
if (printBtn) {
  printBtn.addEventListener('click', () => {
    // No popup windows, no snapshots. Just print the current page.
    // CSS hides map & controls in @media print.
    window.print();
  });
}

// ---------- Roadbooks (add/remove/labels) ----------
function addRoadbookIndex(i, opts = {}) {
  const { noRender = false, label = "", locked = false } = opts;
  i = Math.max(0, Math.min(trackLatLngs.length - 1, Math.round(i)));

  // If this index already exists, optionally update its label and return.
  if (roadbookIdx.includes(i)) {
    const newLabel = (label || "").trim();
    if (newLabel && (!roadbookLabels.get(i) || roadbookLabels.get(i) === `#${i}`)) {
      setRoadbookLabel(i, newLabel);
    }
    if (!noRender) renderRoadbooksTable();
    return;
  }

  roadbookIdx.push(i);
  roadbookIdx.sort((a, b) => a - b);

  const initial = (label && String(label).trim()) ||
                  roadbookLabels.get(i) ||
                  (i === 0 ? "Start" :
                   i === trackLatLngs.length - 1 ? "Finish" :
                   `WP ${roadbookIdx.indexOf(i)}`);

  roadbookLabels.set(i, initial);

  const m = L.marker(trackLatLngs[i]).addTo(map);
  m.__idx = i;
  m.__locked = locked;
  m.bindTooltip(initial, { permanent: true, direction: 'top', offset: [0, -12], opacity: 0.85 });

  m.on('click', () => {
    if (m.__locked) return;
    const pos = roadbookIdx.indexOf(m.__idx);
    if (pos >= 0) roadbookIdx.splice(pos, 1);
    const mi = markers.findIndex(mm => mm.__idx === m.__idx);
    if (mi >= 0) { markers[mi].remove(); markers.splice(mi, 1); }
    roadbookLabels.delete(m.__idx);
    // remove any custom leg labels & overrides involving this index
    [...legLabels.keys()].forEach(k => { const [a,b]=k.split('|').map(Number); if (a===m.__idx || b===m.__idx) legLabels.delete(k); });
    legStopsMin.delete(`${m.__idx}|${m.__idx+1}`);
    legCondPct.delete(`${m.__idx}|${m.__idx+1}`);
    renderRoadbooksTable();
  });

  markers.push(m);
  if (!noRender) renderRoadbooksTable();
}


function clearMarkers() { markers.forEach(m => m.remove()); markers = []; }

function setRoadbookLabel(idx, newLabel) {
  const label = (newLabel || "").trim();
  if (!roadbookIdx.includes(idx)) return;
  roadbookLabels.set(idx, label || `#${idx}`);
  const m = markers.find(mm => mm.__idx === idx);
  if (m) {
    const tt = m.getTooltip();
    if (tt) tt.setContent(roadbookLabels.get(idx));
    else m.bindTooltip(roadbookLabels.get(idx), { permanent: true, direction: 'top', offset: [0, -12], opacity: 0.85 });
  }
}

// ---------- Leg names ----------
function getLegKey(a, b) { return `${a}|${b}`; }
function getWaypointLabel(idx) { return (roadbookLabels.get(idx) || `#${idx}`); }
function getDefaultLegLabel(a, b) { return `${getWaypointLabel(a)} \u2192 ${getWaypointLabel(b)}`; } // →

function setLegLabelByKey(key, label) {
  const txt = (label || "").trim();
  if (!txt) legLabels.delete(key);
  else legLabels.set(key, txt);
}

// ---------- Table render (grouped headers + editable fields) ----------
function renderRoadbooksTable() {
  if (!trackLatLngs.length || roadbookIdx.length < 2) {
    roadbooksEl.innerHTML = "";
    // keep summary consistent
    updateSummaryCard();
    return;
  }

  const lastIdx = trackLatLngs.length - 1;

  const legEntries = [];
  for (let k = 1; k < roadbookIdx.length; k++) {
    // Clamp leg endpoints into valid range (belt & braces)
    const aRaw = roadbookIdx[k - 1];
    const bRaw = roadbookIdx[k];
    const a = Math.max(0, Math.min(aRaw, lastIdx));
    const b = Math.max(0, Math.min(bRaw, lastIdx));
    const key = getLegKey(a, b);

    // Safely read cumulative arrays
    const dA = cumDistKm[a]   ?? 0, dB = cumDistKm[b]   ?? dA;
    const uA = cumAscentM[a]  ?? 0, uB = cumAscentM[b]  ?? uA;
    const vA = cumDescentM[a] ?? 0, vB = cumDescentM[b] ?? vA;
    const tA = cumTimeH[a]    ?? 0, tB = cumTimeH[b]    ?? tA;

    const distKm = dB - dA;
    const ascM   = uB - uA;
    const desM   = vB - vA;
    const timeH  = tB - tA;

    const stopsMin = legStopsMin.get(key) ?? 0;
    const condPct  = legCondPct.get(key) ?? 0;
    const totalH   = timeH * (1 + condPct / 100) + (stopsMin / 60);

    legEntries.push({ idx: k, a, b, key, distKm, ascM, desM, baseH: timeH, stopsMin, condPct, totalH });
  }

  // Save adjusted total for the Summary card
  const totalAdjustedH = legEntries.reduce((s, L) => s + L.totalH, 0);
  lastTotalAdjustedH = totalAdjustedH;

  let html = `
    <p>Click the map to add waypoints; click a waypoint to remove it (locked ones won’t remove).
      Double-click <em>Name</em>, edit <em>Stops</em>/<em>Cond</em>, and set <em>Critical</em> per leg.</p>
    <table>
      <thead>
        <tr>
          <th rowspan="2">#</th>
          <th rowspan="2">Name</th>
          <th rowspan="2">Critical</th>
          <th colspan="3">Leg</th>
          <th colspan="3">Accumulated</th>
          <th colspan="6">Time</th>
        </tr>
        <tr>
          <th>d</th><th>↑</th><th>↓</th>
          <th>Σd</th><th>Σ↑</th><th>Σ↓</th>
          <th>t</th><th>Stops</th><th>Cond</th><th>Total</th><th>Σt</th><th>Rem</th>
        </tr>
      </thead>
      <tbody>
  `;

  let cumDistKmShown = 0, cumAscMShown = 0, cumDesMShown = 0, cumTimeAdjH = 0;

  for (const L of legEntries) {
    cumDistKmShown += L.distKm;
    cumAscMShown   += L.ascM;
    cumDesMShown   += L.desM;
    cumTimeAdjH    += L.totalH;

    const autoLabel    = getDefaultLegLabel(L.a, L.b);
    const displayLabel = legLabels.get(L.key) || autoLabel;
    const remainingH   = totalAdjustedH - cumTimeAdjH;
    const isCritical   = legCritical.get(L.key) ?? false;

    html += `
      <tr>
        <td>${L.idx}</td>
        <td class="leg-cell">
          <span class="leg-name" contenteditable="true" data-legkey="${L.key}" spellcheck="false"
                title="Double-click to edit">${escapeHtml(displayLabel)}</span>
        </td>

        <td>
          <select class="wb-critical" data-legkey="${L.key}">
            <option value="No"${isCritical ? "" : " selected"}>No</option>
            <option value="Yes"${isCritical ? " selected" : ""}>Yes</option>
          </select>
        </td>

        <td>${fmtKm(L.distKm)}</td>
        <td>${Math.round(L.ascM)} m</td>
        <td>${Math.round(L.desM)} m</td>

        <td>${fmtKm(cumDistKmShown)}</td>
        <td>${Math.round(cumAscMShown)} m</td>
        <td>${Math.round(cumDesMShown)} m</td>

        <td>${fmtHrs(L.baseH)}</td>
        <td>
          <span class="editable wb-stops" contenteditable="true" data-legkey="${L.key}" spellcheck="false"
                title="Integer minutes">${escapeHtml(minutesToText(L.stopsMin))}</span>
        </td>
        <td>
          <span class="editable wb-cond" contenteditable="true" data-legkey="${L.key}" spellcheck="false"
                title="Integer percent">${escapeHtml(percentToText(L.condPct))}</span>
        </td>
        <td>${fmtHrs(L.totalH)}</td>
        <td>${fmtHrs(cumTimeAdjH)}</td>
        <td>${fmtHrs(remainingH)}</td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  roadbooksEl.innerHTML = html;

  bindLegEditors();
  bindTimeEditors();
  bindCriticalEditors();

  // ✅ Refresh Summary after any table rebuild (so totals stay in sync)
  updateSummaryCard();
}



// ---------- Editors ----------
function bindLegEditors() {
  const els = roadbooksEl.querySelectorAll('.leg-name');
  els.forEach(el => {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    el.addEventListener('blur', () => {
      const key = el.dataset.legkey;
      const txt = el.textContent || "";
      setLegLabelByKey(key, txt);
      renderRoadbooksTable();
    });
    el.addEventListener('focus', () => {
      const r = document.createRange(); r.selectNodeContents(el);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    });
  });
}

function bindTimeEditors() {
  // Stops (minutes)
  roadbooksEl.querySelectorAll('.wb-stops').forEach(el => {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    el.addEventListener('blur', () => {
      const key = el.dataset.legkey;
      const val = sanitizeInt(el.textContent, 0);
      legStopsMin.set(key, val);
      el.textContent = minutesToText(val);
      renderRoadbooksTable();
    });
    el.addEventListener('input', () => {
      el.textContent = el.textContent.replace(/[^\d]/g, '');
      const s = window.getSelection(); const r = document.createRange();
      r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r);
    });
  });

  // Conditions (percent)
  roadbooksEl.querySelectorAll('.wb-cond').forEach(el => {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    el.addEventListener('blur', () => {
      const key = el.dataset.legkey;
      const val = sanitizeInt(el.textContent, 0);
      legCondPct.set(key, val);
      el.textContent = percentToText(val);
      renderRoadbooksTable();
    });
    el.addEventListener('input', () => {
      el.textContent = el.textContent.replace(/[^\d]/g, '');
      const s = window.getSelection(); const r = document.createRange();
      r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r);
    });
  });
}

function bindCriticalEditors() {
  roadbooksEl.querySelectorAll('.wb-critical').forEach(sel => {
    sel.addEventListener('change', () => {
      const key = sel.dataset.legkey;
      const yes = (sel.value === 'Yes');
      if (yes) legCritical.set(key, true);
      else legCritical.set(key, false);
    });
  });
}


// ---------- Save / Load / Export CSV ----------
function serializePlan() {
  const legs = [];
  let cumDistKmShown = 0, cumAscMShown = 0, cumDesMShown = 0, cumTimeAdjH = 0;

  const lastIdx = trackLatLngs.length - 1;

  for (let k = 1; k < roadbookIdx.length; k++) {
    const aRaw = roadbookIdx[k - 1];
    const bRaw = roadbookIdx[k];
    const a = Math.max(0, Math.min(aRaw, lastIdx));
    const b = Math.max(0, Math.min(bRaw, lastIdx));
    const key = getLegKey(a, b);

    const dA = cumDistKm[a]   ?? 0, dB = cumDistKm[b]   ?? dA;
    const uA = cumAscentM[a]  ?? 0, uB = cumAscentM[b]  ?? uA;
    const vA = cumDescentM[a] ?? 0, vB = cumDescentM[b] ?? vA;
    const tA = cumTimeH[a]    ?? 0, tB = cumTimeH[b]    ?? tA;

    const distKm = dB - dA;
    const ascM   = uB - uA;
    const desM   = vB - vA;
    const baseH  = tB - tA;

    const stopsMin = legStopsMin.get(key) ?? 0;
    const condPct  = legCondPct.get(key) ?? 0;
    const name     = legLabels.get(key) || getDefaultLegLabel(a, b);

    const totalH   = baseH * (1 + condPct / 100) + (stopsMin / 60);

    cumDistKmShown += distKm;
    cumAscMShown   += ascM;
    cumDesMShown   += desM;
    cumTimeAdjH    += totalH;

    legs.push({
      idx: k, a, b, key, name,
      distKm, ascM, desM, baseH, stopsMin, condPct, totalH,
      cumDistKm: cumDistKmShown, cumAscM: cumAscMShown, cumDesM: cumDesMShown, cumTimeAdjH,
      critical: !!(legCritical.get(key))
    });
  }

  const settings = {
    speedFlatKmh: parseFloat(document.getElementById("speedFlat")?.value) || 4,
    speedVertMh:  parseFloat(document.getElementById("speedVert")?.value)  || 300,
    downhillFactor: parseFloat(document.getElementById("downhillFactor")?.value) || 0.6667,
    spacingM: parseFloat(document.getElementById("spacingM")?.value) || 5,
    smoothWinM: parseFloat(document.getElementById("smoothWinM")?.value) || 35,
    elevDeadbandM: parseFloat(document.getElementById("elevDeadbandM")?.value) || 2
  };

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    signature: trackSignature(),
    settings,
    roadbookIdx,
    roadbookLabels: Object.fromEntries(roadbookLabels),
    legLabels: Object.fromEntries(legLabels),
    legStopsMin: Object.fromEntries(legStopsMin),
    legCondPct: Object.fromEntries(legCondPct),
    legCritical: Object.fromEntries(legCritical),
    legs
  };
}



function restorePlanFromJSON(plan) {
  const sig = trackSignature();
  if (!sig || !plan.signature || sig.n !== plan.signature.n) {
    alert("Heads-up: this saved plan may belong to a different GPX or settings.");
  }

  roadbookIdx = Array.isArray(plan.roadbookIdx) ? plan.roadbookIdx.slice() : roadbookIdx;
  roadbookLabels = new Map(Object.entries(plan.roadbookLabels || {}).map(([k,v]) => [Number(k), v]));
  legLabels      = new Map(Object.entries(plan.legLabels || {}));
  legStopsMin    = new Map(Object.entries(plan.legStopsMin || {}));
  legCondPct     = new Map(Object.entries(plan.legCondPct || {}));

  legCritical = new Map(Object.entries(plan.legCritical || {}).map(([k,v]) => [k, !!v]));

  clearMarkers();
  for (const i of roadbookIdx) {
    const locked = (i === 0 || i === trackLatLngs.length - 1);
    addRoadbookIndex(i, { noRender: true, label: roadbookLabels.get(i), locked });
  }
  renderRoadbooksTable();
}

if (saveBtn) saveBtn.addEventListener('click', () => {
  if (!trackLatLngs.length) return;
  const data = serializePlan();
  const name = (roadbookLabels.get(0) || "route").replace(/[^\w\-]+/g, '_');
  downloadFile(`${name}_plan.json`, 'application/json', JSON.stringify(data, null, 2));
});

if (loadBtn && loadInput) {
  loadBtn.addEventListener('click', () => loadInput.click());
  loadInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const plan = JSON.parse(await file.text());
      restorePlanFromJSON(plan);
    } catch (err) {
      console.error(err);
      alert("Could not parse the plan JSON.");
    } finally {
      loadInput.value = "";
    }
  });
}

if (exportCsv) exportCsv.addEventListener('click', () => {
  const table = roadbooksEl.querySelector('table');
  if (!table) { alert('No table to export.'); return; }

  const rows = [];
  // header rows as-is
  table.querySelectorAll('thead tr').forEach(tr =>
    rows.push([...tr.children].map(th => th.textContent.trim()))
  );

  // body rows: use selected option text for selects
  table.querySelectorAll('tbody tr').forEach(tr => {
    const cells = [...tr.children].map(td => {
      const sel = td.querySelector('select');
      if (sel) {
        const opt = sel.options[sel.selectedIndex];
        return (opt ? opt.text : sel.value || '');
      }
      // for editable spans, use their text
      const span = td.querySelector('span');
      if (span) return span.textContent.trim();
      return td.textContent.replace(/\s+/g,' ').trim();
    });
    rows.push(cells);
  });

  const csv = rows
    .map(r => r.map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v).join(','))
    .join('\n');
  downloadFile('roadbooks_table.csv', 'text/csv;charset=utf-8', csv);
});


// ---------- GPX parsing ----------
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result);
    reader.readAsText(file);
  });
}

function parseGPXToSegments(gpxText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(gpxText, "application/xml");
  if (xml.querySelector("parsererror")) return [];

  const segNodes = [...xml.getElementsByTagName("trkseg")];
  let segments = [];

  if (segNodes.length) {
    segments = segNodes.map(seg => {
      const pts = [...seg.getElementsByTagName("trkpt")].map(pt => {
        const lat = parseFloat(pt.getAttribute("lat"));
        const lon = parseFloat(pt.getAttribute("lon"));
        const eleNode = pt.getElementsByTagName("ele")[0];
        const ele = eleNode ? parseFloat(eleNode.textContent) : null;
        return { lat, lon, ele: Number.isFinite(ele) ? ele : null };
      }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      return pts;
    }).filter(arr => arr.length >= 2);
  } else {
    const rtepts = [...xml.getElementsByTagName("rtept")].map(pt => {
      const lat = parseFloat(pt.getAttribute("lat"));
      const lon = parseFloat(pt.getAttribute("lon"));
      const eleNode = pt.getElementsByTagName("ele")[0];
      const ele = eleNode ? parseFloat(eleNode.textContent) : null;
      return { lat, lon, ele: Number.isFinite(ele) ? ele : null };
    }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (rtepts.length >= 2) segments = [rtepts];
  }

  return segments;
}

function parseGPXRoadbooks(gpxText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(gpxText, "application/xml");
  const out = [];

  const wpts = [...xml.getElementsByTagName("wpt")];
  for (const w of wpts) {
    const lat = parseFloat(w.getAttribute("lat"));
    const lon = parseFloat(w.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = (
      w.getElementsByTagName("name")[0]?.textContent ||
      w.getElementsByTagName("cmt")[0]?.textContent ||
      w.getElementsByTagName("sym")[0]?.textContent || ""
    ).trim();
    out.push({ lat, lon, name });
  }

  const rtepts = [...xml.getElementsByTagName("rtept")];
  for (const r of rtepts) {
    const lat = parseFloat(r.getAttribute("lat"));
    const lon = parseFloat(r.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = (
      r.getElementsByTagName("name")[0]?.textContent ||
      r.getElementsByTagName("cmt")[0]?.textContent ||
      r.getElementsByTagName("sym")[0]?.textContent || ""
    ).trim();
    out.push({ lat, lon, name });
  }

  const trkpts = [...xml.getElementsByTagName("trkpt")];
  for (const t of trkpts) {
    const nameNode = (t.getElementsByTagName("name")[0] || t.getElementsByTagName("cmt")[0] || t.getElementsByTagName("sym")[0]);
    if (!nameNode) continue;
    const lat = parseFloat(t.getAttribute("lat"));
    const lon = parseFloat(t.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = nameNode.textContent.trim();
    if (name) out.push({ lat, lon, name });
  }

  return out;
}

// ---------- Geometry & filters ----------
function fillElevationOnPoints(points) {
  const out = points.map(p => ({ ...p }));
  let last = null;
  for (let i = 0; i < out.length; i++) {
    if (out[i].ele == null) out[i].ele = last;
    else last = out[i].ele;
  }
  let next = null;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].ele == null) out[i].ele = next;
    else next = out[i].ele;
  }
  return out;
}

function resampleByDistance(points, spacingM) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const d = haversineKm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon) * 1000;
    cum.push(cum[i - 1] + d);
  }
  const total = cum[cum.length - 1];
  if (!isFinite(total) || total === 0) return points.slice(0, Math.min(points.length, 2));

  const targets = [];
  for (let s = 0; s <= total; s += spacingM) targets.push(s);
  if (targets[targets.length - 1] < total) targets.push(total);

  const out = [];
  let j = 1;
  for (const t of targets) {
    while (j < cum.length && cum[j] < t) j++;
    if (j >= cum.length) { out.push({ ...points[points.length - 1] }); continue; }
    const t0 = cum[j - 1], t1 = cum[j];
    const p0 = points[j - 1], p1 = points[j];
    const denom = (t1 - t0) || 1;
    const a = clamp((t - t0) / denom, 0, 1);

    const lat = p0.lat + a * (p1.lat - p0.lat);
    const lon = p0.lon + a * (p1.lon - p0.lon);
    const ele = (p0.ele != null && p1.ele != null) ? (p0.ele + a * (p1.ele - p0.ele)) : (p0.ele != null ? p0.ele : p1.ele);

    out.push({ lat, lon, ele });
  }
  return out;
}

function medianFilter(arr, win) {
  if (!Array.isArray(arr) || arr.length === 0) return arr.slice();
  const n = arr.length, half = Math.floor(win / 2), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - half);
    const end   = Math.min(n - 1, i + half);
    const vals = [];
    for (let k = start; k <= end; k++) if (arr[k] != null) vals.push(arr[k]);
    if (!vals.length) { out[i] = null; continue; }
    vals.sort((a,b)=>a-b);
    const mid = Math.floor(vals.length / 2);
    out[i] = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }
  return out;
}

function cumulativeDeadbandFilter(elev, deadband) {
  const n = elev.length;
  if (n === 0) return [];
  const out = new Array(n).fill(null);

  let first = elev[0], i0 = 0;
  while (first == null && i0 < n - 1) first = elev[++i0];
  if (first == null) return elev.slice();

  out[i0] = first;
  let cumErr = 0;

  for (let i = i0 + 1; i < n; i++) {
    const prev = elev[i - 1] ?? elev[i] ?? out[i - 1];
    const cur  = elev[i] ?? prev;
    const delta = cur - prev;
    cumErr += delta;

    if (Math.abs(cumErr) > deadband) {
      const move = cumErr - Math.sign(cumErr) * deadband;
      out[i] = out[i - 1] + move;
      cumErr = Math.sign(cumErr) * deadband;
    } else {
      out[i] = out[i - 1];
    }
  }
  for (let k = 0; k < i0; k++) out[k] = out[i0];
  return out;
}

// ---------- Utils ----------
function toPosNum(v, d) { const n = parseFloat(v); return n > 0 ? n : d; }
function toNonNegNum(v, d) { const n = parseFloat(v); return n >= 0 ? n : d; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function clampToOdd(val, minOdd, maxOdd) { val = clamp(val, minOdd, maxOdd); if (val % 2 === 0) val += (val >= maxOdd ? -1 : 1); return val; }

function sanitizeInt(str, def = 0) { const m = String(str ?? "").match(/\d+/); const n = m ? parseInt(m[0], 10) : def; return Number.isFinite(n) && n >= 0 ? n : def; }
function minutesToText(min) { return `${min} min`; }
function percentToText(pct) { return `${pct} %`; }

function downloadFile(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function trackSignature() {
  if (!trackLatLngs.length) return null;
  const n = trackLatLngs.length;
  const first = trackLatLngs[0], last = trackLatLngs[n - 1];
  const spacingM = parseFloat(document.getElementById("spacingM")?.value) || 5;
  const smoothWinM = parseFloat(document.getElementById("smoothWinM")?.value) || 35;
  const elevDeadbandM = parseFloat(document.getElementById("elevDeadbandM")?.value) || 2;
  return { n, first, last, spacingM, smoothWinM, elevDeadbandM };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtKm(km) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`; }
function fmtHrs(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")} h`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function updateSummaryCard() {
  if (!trackLatLngs.length || cumDistKm.length === 0) {
    outputEl.innerHTML = "";
    return;
  }

  // Derive totals from the cumulative arrays
  const totalDistKm    = cumDistKm[cumDistKm.length - 1]    ?? 0;
  const totalAscentM   = cumAscentM[cumAscentM.length - 1]  ?? 0;
  const totalDescentM  = cumDescentM[cumDescentM.length - 1]?? 0;
  const activityTimeH  = cumTimeH[cumTimeH.length - 1]      ?? 0; // base time from the model
  const totalTimeH     = lastTotalAdjustedH || activityTimeH;     // base + Stops/Cond

  // For the little config line
  const spacingM      = parseFloat(document.getElementById("spacingM")?.value)      || 5;
  const smoothWinM    = parseFloat(document.getElementById("smoothWinM")?.value)    || 35;
  const elevDeadbandM = parseFloat(document.getElementById("elevDeadbandM")?.value) || 2;

  outputEl.innerHTML = `
    <ul>
      <li><strong>Distance:</strong> ${fmtKm(totalDistKm)}</li>
      <li><strong>Ascent:</strong> ${Math.round(totalAscentM)} m</li>
      <li><strong>Descent:</strong> ${Math.round(totalDescentM)} m</li>
      <li><strong>Estimated Activity Time:</strong> ${fmtHrs(activityTimeH)}</li>
      <li><strong>Estimated Total Time:</strong> ${fmtHrs(totalTimeH)}</li>
    </ul>
    <p class="subtle">Resample: ${spacingM} m • Smooth window: ${smoothWinM} m • Deadband: ${elevDeadbandM} m</p>
  `;
}


// ---------- Nearest point ----------
function nearestIndexOnTrack([la, lo], latlngs) {
  let bestIdx = 0, bestD = Infinity;
  for (let i = 0; i < latlngs.length; i++) {
    const [lb, lob] = latlngs[i];
    const d = haversineKm(la, lo, lb, lob);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return bestIdx;
}
