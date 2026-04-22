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
  algoId:  String(spec1.algorithm_id)   // always string; matches elAlgo.value and SPECS key coercion
};

// ---- DOM refs ----------------------------------------------------------

const elSetpoint   = document.getElementById('setpoint');
const elNominal    = document.getElementById('nominal');
const elDuration   = document.getElementById('duration');
const elAlgo       = document.getElementById('algo-select');
const elBadge      = document.getElementById('result-badge');
const elZoneTimes  = document.getElementById('zone-times');
const elViolations = document.getElementById('violations');
const elShowProgress = document.getElementById('show-progress');
const elBtnReset     = document.getElementById('btn-reset');
const elBtnCopy      = document.getElementById('btn-copy');
const elBtnClear     = document.getElementById('btn-clear');
const elBtnEditAlgo  = document.getElementById('btn-edit-algo');
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

// ---- Build logEntry from profile + samples -----------------------------

function buildLogEntry(samples) {
  return {
    default_current_mA: state.profile.nominal_mA,
    current_mA:         state.profile.setpoint_mA,
    time_s:             state.profile.duration_s,
    measurements: samples.map(pt => ({ time_s: pt.x, current_mA: pt.y }))
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

// ---- Re-evaluate and update UI -----------------------------------------

function reEvaluate() {
  const spec    = getCurrentSpec();
  const samples = chart.data.datasets[0].data;

  updateAxisBounds();

  if (!spec || samples.length < 2) {
    evaluationOverlayPlugin.setEvaluationData('dev-chart', null);
    chart.update();
    renderResults(null);
    return;
  }

  const result = evaluate(buildLogEntry(samples), spec);
  if (!elShowProgress.checked && result.overlayHints) {
    result.overlayHints.durationSeries = null;
    result.overlayHints.integralSeries = null;
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

Chart.register(evaluationOverlayPlugin);

const sampleEditorPlugin = createSampleEditorPlugin((samples) => {
  reEvaluate();
});

const chart = new Chart(canvas, {
  type: 'scatter',
  plugins: [sampleEditorPlugin],
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

// ---- Action buttons ----------------------------------------------------

elBtnReset.addEventListener('click', () => {
  chart.data.datasets[0].data = buildDefaultSamples(state.profile.setpoint_mA);
  chart.update('none');
  reEvaluate();
});

// ---- Clipboard helpers -------------------------------------------------

function samplesFromClipboardText(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length < 2) return null;
    if (!parsed.every(p => typeof p.x === 'number' && typeof p.y === 'number')) return null;
    return parsed;
  } catch {
    return null;
  }
}

elBtnCopy.addEventListener('click', () => {
  const samples = chart.data.datasets[0].data;
  const text = JSON.stringify(samples.map(p => ({ x: p.x, y: p.y })), null, 2);
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
  const samples = samplesFromClipboardText(text);
  if (!samples) return;
  chart.data.datasets[0].data = samples;
  chart.update('none');
  reEvaluate();
});

elBtnClear.addEventListener('click', () => {
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

// ---- Initial evaluation ------------------------------------------------
reEvaluate();
