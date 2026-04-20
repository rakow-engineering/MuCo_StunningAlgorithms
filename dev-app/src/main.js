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

import spec1 from '@algo/algorithms/stunning_embedded_v10.json';
import spec2 from '@algo/algorithms/stunning_current_v1.json';
import spec3 from '@algo/algorithms/stunning_current_integral_v1.json';

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

// A realistic stunning waveform: ramp up, sustain above setpoint, then stop
const DEFAULT_SAMPLES = [
  { x: 0.0, y:   0 },
  { x: 0.2, y:  50 },
  { x: 0.5, y: 250 },
  { x: 0.8, y: 460 },
  { x: 1.0, y: 505 },
  { x: 1.5, y: 512 },
  { x: 2.0, y: 498 },
  { x: 2.5, y: 508 },
  { x: 3.2, y: 502 },
  { x: 3.8, y:  20 },
];

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
const elBtnReset   = document.getElementById('btn-reset');
const elBtnClear   = document.getElementById('btn-clear');
const canvas       = document.getElementById('dev-chart');

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

// ---- Re-evaluate and update UI -----------------------------------------

function reEvaluate() {
  const spec    = SPECS[state.algoId];
  const samples = chart.data.datasets[0].data;

  if (!spec || samples.length < 2) {
    evaluationOverlayPlugin.setEvaluationData('dev-chart', null);
    chart.update();
    renderResults(null);
    return;
  }

  const result = evaluate(buildLogEntry(samples), spec);
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
          ${evaluationOverlayPlugin.formatViolation(v)}
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
      data: DEFAULT_SAMPLES.map(p => ({ x: p.x, y: p.y })),
      showLine:         true,
      borderColor:      'rgba(33, 150, 243, 0.9)',
      backgroundColor:  'rgba(33, 150, 243, 0.7)',
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
        grid:  { color: 'rgba(255,255,255,0.06)' },
        ticks: { color: '#8a8a9a' }
      },
      y: {
        type:  'linear',
        title: { display: true, text: 'Current (mA)', color: '#8a8a9a' },
        min:   0,
        grid:  { color: 'rgba(255,255,255,0.06)' },
        ticks: { color: '#8a8a9a' }
      }
    }
  }
});

// Chart.js handles canvas sizing via responsive:true / maintainAspectRatio:false.
// The chart-wrap container drives the size through CSS flex layout.
window.addEventListener('resize', () => chart.resize());

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

// ---- Action buttons ----------------------------------------------------

elBtnReset.addEventListener('click', () => {
  chart.data.datasets[0].data = DEFAULT_SAMPLES.map(p => ({ x: p.x, y: p.y }));
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
