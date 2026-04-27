import './workbench.css';

/**
 * Stunning Algorithm Workbench — main entry point.
 *
 * Architecture:
 *   state                     — profile + selected algo
 *   chart (Chart.js scatter)  — editable sample waveform
 *   sampleEditorPlugin        — click/drag/delete interaction
 *   evaluationOverlayPlugin   — zone bands, ramp, threshold lines, badge
 *   reEvaluate()              — called after every edit; runs engine → updates overlay + results panel
 */

import Chart from 'chart.js/auto';
import { evaluate }               from '@algo/StunningEvaluationEngine.js';
import evaluationOverlayPlugin    from '@algo/EvaluationOverlayPlugin.js';
import { createSampleEditorPlugin } from './sampleEditorPlugin.js';
import { createAlgoEditor }         from './algoEditor.js';

import spec1 from '@algo/algorithms/stunning_embedded_v10.json';
import spec2 from '@algo/algorithms/stunning_current_v1.json';
import spec3 from '@algo/algorithms/stunning_current_integral_v1.json';

import logoRakow       from '@algo/assets/RakowEnineering Logo.png';
import logoFederleicht from '@algo/assets/federleicht-logo-4c_mittel.png';

// ---- Curve registry ----------------------------------------------------

const curveModules = import.meta.glob('../../curves/*.json', { eager: true });

const CURVES = {
  __default__: { name: 'Default', data: null }   // null → buildDefaultSamples() at load time
};

for (const [path, mod] of Object.entries(curveModules)) {
  const filename = path.split('/').pop();
  if (filename.startsWith('_')) continue;
  const id  = filename.replace(/\.json$/, '');
  const name = id.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const raw  = mod.default ?? mod;
  const data = Array.isArray(raw) ? raw : (raw?.samples ?? []);
  const meta = Array.isArray(raw) ? null : (raw?.profile ?? null);
  CURVES[id] = { name, data, meta };
}

// ---- Algorithm registry ------------------------------------------------

const SPECS = {
  [spec1.algorithm_id]: spec1,
  [spec2.algorithm_id]: spec2,
  [spec3.algorithm_id]: spec3,
};

// ---- Default state -----------------------------------------------------

const DEFAULT_PROFILE = {
  setpoint_mA: 500,
  nominal_mA:  400,
  duration_s:  3.0
};

// Waveform template as fractions of setpoint_mA: ramp up, sustain above setpoint, then stop.
// Y values are multiplied by the current setpoint when building the actual sample points.
const SAMPLE_TEMPLATE = [
  { x: 0.0, f: 0.000 },
  { x: 0.2, f: 0.100 },
  { x: 0.5, f: 0.500 },
  { x: 0.8, f: 0.920 },
  { x: 1.0, f: 1.010 },
  { x: 1.5, f: 1.024 },
  { x: 2.0, f: 0.996 },
  { x: 2.5, f: 1.016 },
  { x: 3.2, f: 1.004 },
  { x: 3.8, f: 0.040 },
];

function buildDefaultSamples(setpoint_mA) {
  return SAMPLE_TEMPLATE.map(p => ({ x: p.x, y: Math.round(p.f * setpoint_mA) }));
}

const state = {
  profile: { ...DEFAULT_PROFILE },
  algoId:  String(spec1.algorithm_id),  // always string; matches elAlgo.value and SPECS key coercion
  curveId: '__default__'
};

// ---- DOM refs ----------------------------------------------------------

const elSetpoint   = document.getElementById('setpoint');
const elNominal    = document.getElementById('nominal');
const elDuration   = document.getElementById('duration');
const elAlgo       = document.getElementById('algo-select');
const elBadge      = document.getElementById('result-badge');
const elZoneTimes  = document.getElementById('zone-times');
const elViolations = document.getElementById('violations');
const elShowProgress    = document.getElementById('show-progress');
const elShowStateColors = document.getElementById('show-state-colors');
const elCurveSelect  = document.getElementById('curve-select');
const elBtnReset     = document.getElementById('btn-reset');
const elBtnSaveCurve = document.getElementById('btn-save-curve');
const elBtnCopy      = document.getElementById('btn-copy');
const elBtnClear     = document.getElementById('btn-clear');
const elBtnEditAlgo  = document.getElementById('btn-edit-algo');
const elChartHint    = document.getElementById('chart-hint');
const canvas         = document.getElementById('dev-chart');

// ---- Header logos -------------------------------------------------------

const header = document.querySelector('header');
const h1     = header.querySelector('h1');

function makeHeaderLogo(src, alt, extraStyle = '') {
  const img = document.createElement('img');
  img.src   = src;
  img.alt   = alt;
  img.style.cssText = `height:28px; width:auto; display:block; flex-shrink:0; ${extraStyle}`;
  return img;
}

header.insertBefore(makeHeaderLogo(logoRakow, 'Rakow Engineering'), h1);
header.insertBefore(makeHeaderLogo(logoFederleicht, 'FederLeicht',
  'background:#fff; border-radius:4px; padding:2px 6px;'), h1);

// ---- Populate algo dropdown --------------------------------------------

for (const spec of Object.values(SPECS)) {
  const opt = document.createElement('option');
  opt.value       = spec.algorithm_id;
  opt.textContent = spec.display_name ?? `Algorithm ${spec.algorithm_id}`;
  elAlgo.appendChild(opt);
}
elAlgo.value = String(state.algoId);

// ---- Populate curve dropdown -------------------------------------------

for (const [id, { name }] of Object.entries(CURVES)) {
  const opt = document.createElement('option');
  opt.value       = id;
  opt.textContent = name;
  elCurveSelect.appendChild(opt);
}
elCurveSelect.value = state.curveId;

// ---- Apply curve metadata to profile inputs ----------------------------

function applyMeta(profile) {
  if (!profile) return;
  if (profile.duration_ms != null) { state.profile.duration_s  = profile.duration_ms / 1000; elDuration.value = state.profile.duration_s;  }
  if (profile.setpoint_mA != null) { state.profile.setpoint_mA = profile.setpoint_mA;         elSetpoint.value = profile.setpoint_mA;         }
  if (profile.nominal_mA  != null) { state.profile.nominal_mA  = profile.nominal_mA;           elNominal.value  = profile.nominal_mA;          }
}

// ---- Build logEntry from profile + samples -----------------------------

function buildLogEntry(samples) {
  return {
    default_current_mA: state.profile.nominal_mA,
    current_mA:         state.profile.setpoint_mA,
    time_s:             state.profile.duration_s,
    measurements: samples.map(pt => ({ ms: Math.round(pt.x * 1000), mA: pt.y }))
  };
}

// ---- Axis bounds -------------------------------------------------------
// X max = at least 2× profile duration; expands further if a point lies beyond.
// This also acts as the hard right boundary for drag clamping (chartArea.right).

function updateAxisBounds() {
  const data   = chart.data.datasets[0].data;
  const maxPtX = data.length > 0 ? Math.max(...data.map(p => p.x)) : 0;
  chart.options.scales.x.max = Math.max(2 * state.profile.duration_s, maxPtX);
  chart.options.scales.y.max = Math.round(state.profile.setpoint_mA * 1.3);
}

// ---- State colors: per-point background based on phase/threshold --------

function computePointColors(samples, result) {
  const hints = result.overlayHints || {};
  const rampEnd = hints.rampReachedAt_s ?? hints.rampDeadline_s ?? null;

  // Color by violation intervals so glitch-forgiven samples aren't marked as bad.
  const nonSummary = (result.violations || []).filter(v => !v.isSummary);
  const errorVios  = nonSummary.filter(v => v.severity === 'error');
  const warnVios   = nonSummary.filter(v => v.severity === 'warn');
  const forgiven   = hints.glitchForgivenIntervals || [];

  return samples.map((pt) => {
    const t = pt.x;

    // Blue: sample that triggered ramp detection
    if (hints.rampStart_s != null && Math.abs(t - hints.rampStart_s) < 0.001)
      return 'rgba(33, 150, 243, 0.9)';

    // Blue: first sample to cross target current (ramp success)
    if (hints.rampReachedAt_s != null && Math.abs(t - hints.rampReachedAt_s) < 0.001)
      return 'rgba(33, 150, 243, 0.9)';

    // Gray: after stunning goal reached
    if (hints.completedAt_s != null && t >= hints.completedAt_s)
      return 'rgba(160, 160, 160, 0.75)';

    // Gray: before/during ramp — no sustain step watching these
    if (rampEnd != null && t <= rampEnd)
      return 'rgba(160, 160, 160, 0.75)';

    // Cyan: glitch-forgiven dip samples (checked before violation coloring)
    if (forgiven.some(iv => t >= iv.tStart_s && t <= iv.tEnd_s))
      return 'rgba(0, 188, 212, 0.85)';

    // Color matches what the evaluation engine actually flagged (respects glitch filter).
    if (errorVios.some(v => t >= v.tStart_s && t <= v.tEnd_s)) return 'rgba(220, 53, 69, 0.9)';
    if (warnVios.some(v  => t >= v.tStart_s && t <= v.tEnd_s)) return 'rgba(255, 193, 7, 0.9)';
    return 'rgba(76, 175, 80, 0.9)';
  });
}

// ---- Re-evaluate and update UI -----------------------------------------

function reEvaluate() {
  const spec    = getCurrentSpec();
  const samples = chart.data.datasets[0].data;
  const ds      = chart.data.datasets[0];

  updateAxisBounds();

  if (!spec || samples.length < 2) {
    evaluationOverlayPlugin.setEvaluationData('dev-chart', null);
    ds.pointBackgroundColor = undefined;
    ds.pointBorderColor     = undefined;
    chart.update();
    renderResults(null);
    return;
  }

  const result = evaluate(buildLogEntry(samples), spec);
  if (!elShowProgress.checked && result.overlayHints) {
    result.overlayHints.durationSeries = null;
    result.overlayHints.integralSeries = null;
  }

  if (elShowStateColors.checked) {
    const colors = computePointColors(samples, result);
    ds.pointBackgroundColor = colors;
    ds.pointBorderColor     = colors;
  } else {
    ds.pointBackgroundColor = undefined;
    ds.pointBorderColor     = undefined;
  }

  evaluationOverlayPlugin.setEvaluationData('dev-chart', result);
  chart.update();
  renderResults(result);
}

// ---- Results panel -----------------------------------------------------

function renderResults(result) {
  if (!result) {
    elBadge.textContent  = '—';
    elBadge.className    = '';
    elZoneTimes.innerHTML  = '';
    elViolations.innerHTML = '';
    return;
  }

  // Badge
  const label = result.ok ? (result.hasWarn ? 'WARN' : 'OK') : 'FAIL';
  elBadge.textContent = label;
  elBadge.className   = result.ok ? (result.hasWarn ? 'warn' : 'ok') : 'fail';

  // Zone times
  const m = result.meta;
  const fmt = (s) => s != null ? `${s.toFixed(2)} s` : '—';
  elZoneTimes.innerHTML = `
    <div class="zone-row"><span>OK time</span>    <span>${fmt(m.ok_s)}</span></div>
    <div class="zone-row"><span>Warn time</span>  <span>${fmt(m.warn_s)}</span></div>
    <div class="zone-row"><span>Invalid time</span><span>${fmt(m.invalid_s)}</span></div>
    ${m.completedAt_s != null
      ? `<div class="zone-row"><span>Completed at</span><span>${fmt(m.completedAt_s)}</span></div>`
      : ''}
    ${m.charge_integral_mAs != null
      ? `<div class="zone-row"><span>Integral</span><span>${m.charge_integral_mAs.toFixed(1)} mA·s</span></div>`
      : ''}
  `.trim();

  // Violations
  const shown = result.violations.filter(v => !v.isSummary);
  elViolations.innerHTML = shown.length === 0
    ? ''
    : shown.map(v => `
        <div class="violation ${v.severity === 'error' ? 'error' : ''}">
          ${v.stepType ? `<span class="violation-category">${v.stepType}</span><br>` : ''}${evaluationOverlayPlugin.formatViolation(v)}
        </div>
      `).join('');
}

// ---- Chart setup -------------------------------------------------------

function updateChartHintText() {
  if (!elChartHint) return;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  elChartHint.textContent = coarse
    ? 'Tap empty chart: add · Tap point: select · Drag to move · Tap red × (top-right of chart) to delete'
    : 'Click empty: add · Drag point: move · Select a point, then tap the red × or right-click to delete';
}

if (elChartHint) {
  updateChartHintText();
  window.matchMedia('(pointer: coarse)').addEventListener('change', updateChartHintText);
}

Chart.register(evaluationOverlayPlugin);

const sampleEditor = createSampleEditorPlugin(() => {
  reEvaluate();
});

const chart = new Chart(canvas, {
  type: 'scatter',
  plugins: [sampleEditor.plugin],
  data: {
    datasets: [{
      label: 'Current (mA)',
      data: buildDefaultSamples(DEFAULT_PROFILE.setpoint_mA),
      showLine:         true,
      borderColor:      'rgba(220, 53, 69, 0.9)',
      backgroundColor:  'rgba(220, 53, 69, 0.7)',
      borderWidth:      2,
      pointRadius:      5,
      pointHoverRadius: 7,
      tension:          0,
    }]
  },
  options: {
    responsive:          true,
    maintainAspectRatio: false,
    animation:           false,
    layout: { padding: { right: 46 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) =>
            `t = ${ctx.parsed.x.toFixed(3)} s,  I = ${ctx.parsed.y.toFixed(0)} mA`
        }
      }
    },
    scales: {
      x: {
        type:  'linear',
        title: { display: true, text: 'Time (s)', color: '#8a8a9a' },
        min:   0,
        max:   DEFAULT_PROFILE.duration_s * 2,   // updated dynamically by updateAxisBounds()
        grid:  { color: 'rgba(255,255,255,0.06)' },
        ticks: { color: '#8a8a9a' }
      },
      y: {
        type:  'linear',
        title: { display: true, text: 'Current (mA)', color: '#8a8a9a' },
        min:   0,
        max:   Math.round(DEFAULT_PROFILE.setpoint_mA * 1.3),
        grid:  { color: 'rgba(255,255,255,0.06)' },
        ticks: { color: '#8a8a9a' }
      }
    }
  }
});

// Chart.js handles canvas sizing via responsive:true / maintainAspectRatio:false.
// The chart-wrap container drives the size through CSS flex layout.
window.addEventListener('resize', () => chart.resize());

// Drop sample selection when the pointer goes down outside the chart canvas (sidebar, hint, etc.).
document.addEventListener(
  'pointerdown',
  (e) => {
    const t = e.target;
    if (t === canvas || (t instanceof Node && canvas.contains(t))) return;
    sampleEditor.clearSelection();
  },
  true
);

// ---- Algorithm editor --------------------------------------------------
// specOverrides holds user-edited copies of algorithm specs, keyed by algoId.
// reEvaluate() prefers the override when present.

const specOverrides = {};

function getCurrentSpec() {
  return specOverrides[state.algoId] ?? SPECS[state.algoId];
}

const algoEditor = createAlgoEditor((updatedSpec) => {
  specOverrides[state.algoId] = updatedSpec;
  reEvaluate();
});

elBtnEditAlgo.addEventListener('click', () => algoEditor.open(getCurrentSpec()));

// ---- Profile input handlers --------------------------------------------

function syncProfile() {
  state.profile.setpoint_mA = parseFloat(elSetpoint.value) || 0;
  state.profile.nominal_mA  = parseFloat(elNominal.value)  || 0;
  state.profile.duration_s  = parseFloat(elDuration.value) || 1;
  reEvaluate();
}

elSetpoint.addEventListener('input', syncProfile);
elNominal.addEventListener('input',  syncProfile);
elDuration.addEventListener('input', syncProfile);

elAlgo.addEventListener('change', () => {
  state.algoId = elAlgo.value;
  reEvaluate();
});

elShowProgress.addEventListener('change', reEvaluate);
elShowStateColors.addEventListener('change', reEvaluate);

// ---- Curve helpers -----------------------------------------------------

function curvePoints(id) {
  const curve = CURVES[id];
  const data  = curve?.data ?? buildDefaultSamples(state.profile.setpoint_mA);
  return data.map(p =>
    p.ms   != null ? { x: p.ms   / 1000, y: p.mA   } :
    p.t_ms != null ? { x: p.t_ms / 1000, y: p.I_mA } :
                     { x: p.x,           y: p.y     }
  );
}

function loadCurve(id) {
  sampleEditor.clearSelection();
  applyMeta(CURVES[id]?.meta);
  chart.data.datasets[0].data = curvePoints(id);
  chart.update('none');
  reEvaluate();
}

elCurveSelect.addEventListener('change', () => {
  state.curveId = elCurveSelect.value;
  loadCurve(state.curveId);
});

elBtnSaveCurve.addEventListener('click', () => {
  const raw = prompt('Curve name (will be used as filename):', 'my_curve');
  if (!raw?.trim()) return;
  const name     = raw.trim();
  const id       = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
  const filename = `${id || 'curve'}.json`;
  const points  = chart.data.datasets[0].data.map(p => ({ ms: Math.round(p.x * 1000), mA: p.y }));
  const profile = { duration_ms: Math.round(state.profile.duration_s * 1000), setpoint_mA: state.profile.setpoint_mA, nominal_mA: state.profile.nominal_mA };
  const curveObj = { version: '1.0', description: name, profile, samples: points };

  // Download so the user can drop it into curves/
  const blob = new Blob([JSON.stringify(curveObj, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  // Add to in-memory registry + dropdown for this session
  const effectiveId = id || 'curve';
  CURVES[effectiveId] = { name, data: points, meta: profile };
  if (!elCurveSelect.querySelector(`option[value="${effectiveId}"]`)) {
    const opt       = document.createElement('option');
    opt.value       = effectiveId;
    opt.textContent = name;
    elCurveSelect.appendChild(opt);
  }
  elCurveSelect.value = effectiveId;
  state.curveId       = effectiveId;
});

// ---- Action buttons ----------------------------------------------------

elBtnReset.addEventListener('click', () => {
  sampleEditor.clearSelection();
  chart.data.datasets[0].data = curvePoints(state.curveId);
  chart.update('none');
  reEvaluate();
});

// ---- Clipboard helpers -------------------------------------------------

function samplesFromClipboardText(text) {
  try {
    const parsed = JSON.parse(text);
    // {description, samples} wrapper (curve file format) or bare array
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.samples) ? parsed.samples : null);
    if (!arr || arr.length < 2) return null;
    let samples;
    if (arr.every(p => typeof p.ms === 'number' && typeof p.mA === 'number')) {
      samples = arr.map(p => ({ x: p.ms / 1000, y: p.mA }));
    } else if (arr.every(p => typeof p.t_ms === 'number' && typeof p.I_mA === 'number')) {
      samples = arr.map(p => ({ x: p.t_ms / 1000, y: p.I_mA }));
    } else if (arr.every(p => typeof p.x === 'number' && typeof p.y === 'number')) {
      samples = arr;
    } else {
      return null;
    }
    const meta = Array.isArray(parsed) ? null : (parsed?.profile ?? null);
    return { samples, meta };
  } catch {
    return null;
  }
}

elBtnCopy.addEventListener('click', () => {
  const samples = chart.data.datasets[0].data;
  const curveObj = {
    version:     '1.0',
    description: CURVES[state.curveId]?.name ?? 'curve',
    profile: { duration_ms: Math.round(state.profile.duration_s * 1000), setpoint_mA: state.profile.setpoint_mA, nominal_mA: state.profile.nominal_mA },
    samples: samples.map(p => ({ ms: Math.round(p.x * 1000), mA: p.y }))
  };
  const text = JSON.stringify(curveObj, null, 2);
  navigator.clipboard.writeText(text).then(() => {
    const prev = elBtnCopy.textContent;
    elBtnCopy.textContent = 'Copied!';
    setTimeout(() => { elBtnCopy.textContent = prev; }, 1200);
  });
});

document.addEventListener('keydown', async (e) => {
  if (!e.ctrlKey || e.key !== 'v') return;
  // Don't intercept paste into text inputs
  if (document.activeElement?.matches('input, select, textarea')) return;
  e.preventDefault();
  const text = await navigator.clipboard.readText().catch(() => null);
  if (!text) return;
  const parsed = samplesFromClipboardText(text);
  if (!parsed) return;
  applyMeta(parsed.meta);
  sampleEditor.clearSelection();
  chart.data.datasets[0].data = parsed.samples;
  chart.update('none');
  reEvaluate();
});

elBtnClear.addEventListener('click', () => {
  sampleEditor.clearSelection();
  chart.data.datasets[0].data = [];
  chart.update('none');
  reEvaluate();
});

// ---- Badge click → log violations to console --------------------------

evaluationOverlayPlugin.onBadgeClick('dev-chart', (evalData) => {
  console.group('[Workbench] Evaluation result');
  console.log('Result:', evalData.ok ? (evalData.hasWarn ? 'WARN' : 'OK') : 'FAIL');
  console.log('Thresholds A/B:', evalData.thresholds);
  console.log('Meta:', evalData.meta);
  console.log('Violations:', evalData.violations);
  console.groupEnd();
});

// ---- Sidebar collapse toggle -------------------------------------------

const elSplitter   = document.getElementById('sidebar-splitter');
const elAside      = document.querySelector('aside');
let   sidebarOpen  = true;
let   savedWidth   = elAside.offsetWidth || parseInt(getComputedStyle(elAside).width) || 240;

elSplitter.addEventListener('click', () => {
  sidebarOpen = !sidebarOpen;
  if (sidebarOpen) {
    elAside.style.width = savedWidth + 'px';
  } else {
    savedWidth = elAside.offsetWidth;
    elAside.style.width = '0';
  }
  elSplitter.classList.toggle('collapsed', !sidebarOpen);
  setTimeout(() => chart.resize(), 240);
});

// ---- Initial evaluation ------------------------------------------------
reEvaluate();
