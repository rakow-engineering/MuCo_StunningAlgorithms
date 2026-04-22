/**
 * Algorithm Editor — modal step-field editor for an algorithm spec JSON.
 *
 * Usage:
 *   const editor = createAlgoEditor(onChange);
 *   editor.open(spec);   // opens modal with a deep-cloned working copy
 *   // onChange(workingSpec) is called on every field change
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const STEP_CATEGORIES = ['startup', 'filter', 'monitor', 'completion'];
const CATEGORY_LABELS = {
  startup:    'Startup',
  filter:     'Filter',
  monitor:    'Monitor',
  completion: 'Completion',
};

const CURRENT_BINDINGS  = ['setpoint_mA', 'nominal_mA', 'min_nominal_setpoint'];
const DURATION_BINDINGS = ['required_duration_s'];

const BINDING_LABELS = {
  setpoint_mA:          'Setpoint',
  nominal_mA:           'Nominal',
  min_nominal_setpoint: 'Min(Setpoint, Nominal)',
  required_duration_s:  'Required duration',
};

const AFTER_OPTIONS = [
  { value: 'after_ramp',    label: 'After ramp phase' },
  { value: 'first_above_A', label: 'First above Nominal' },
];

/** Field descriptors per op. */
function stepFields(op) {
  switch (op) {
    case 'ramp_to_threshold':
      return [
        { key: 'threshold',                 label: 'Threshold',          type: 'binding',         options: CURRENT_BINDINGS },
        { key: 'current_threshold_percent', label: 'Reach (%)',          type: 'int',             min: 1,  max: 100, unit: '%' },
        { key: 'timeout_ms',                label: 'Timeout',            type: 'int',             min: 0,             unit: 'ms' },
        { key: 'ramp_start_mA',             label: 'Ramp start current', type: 'float',           min: 0,             unit: 'mA' },
        { key: 'count_during_ramp',         label: 'Count during ramp',  type: 'bool' },
      ];
    case 'glitch_ignore':
      return [
        { key: 'ref',        label: 'Reference level', type: 'binding', options: CURRENT_BINDINGS },
        { key: 'max_gap_ms', label: 'Max gap',         type: 'int',     min: 0, unit: 'ms' },
      ];
    case 'sustain_thresholds':
      return [
        { key: 'after',                        label: 'Start after',       type: 'select',          options: AFTER_OPTIONS },
        { key: 'warn_below',                   label: 'Warn reference',    type: 'binding',         options: CURRENT_BINDINGS },
        { key: 'warn_below_threshold_percent', label: 'Warn threshold (%)', type: 'int_nullable',   min: 1, max: 100, unit: '%' },
        { key: 'fail_below',                   label: 'Fail reference',    type: 'binding',         options: CURRENT_BINDINGS },
        { key: 'fail_below_threshold_percent', label: 'Fail threshold (%)', type: 'int_nullable',   min: 1, max: 100, unit: '%' },
      ];
    case 'min_duration_above':
      return [
        { key: 'threshold',    label: 'Threshold',        type: 'binding', options: CURRENT_BINDINGS },
        { key: 'duration_from',label: 'Required duration', type: 'binding', options: DURATION_BINDINGS },
      ];
    case 'charge_integral':
      return [
        { key: 'limit_to',                  label: 'Clamp at',        type: 'binding', options: CURRENT_BINDINGS },
        { key: 'current_threshold_percent', label: 'Cutoff (%)',      type: 'int',     min: 1, max: 100, unit: '%' },
        { key: 'target.duration_from',      label: 'Target duration', type: 'binding', options: DURATION_BINDINGS },
        { key: 'target.current_from',       label: 'Target current',  type: 'binding', options: CURRENT_BINDINGS },
      ];
    case 'invalid_timeout':
      return [
        { key: 'max_invalid_s', label: 'Max invalid time', type: 'float', min: 0, unit: 's' },
      ];
    case 'total_timeout':
      return [
        { key: 'factor',       label: 'Factor',            type: 'float', min: 0.1 },
        { key: 'duration_from',label: 'Required duration', type: 'binding', options: DURATION_BINDINGS },
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDeep(obj, key) {
  return key.split('.').reduce((o, k) => o?.[k], obj);
}

function setDeep(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function div(cls, ...children) {
  const d = document.createElement('div');
  d.className = cls;
  children.flat().forEach(c => { if (c != null) d.appendChild(c); });
  return d;
}

function txt(content) { return document.createTextNode(content); }

// ---------------------------------------------------------------------------
// Field renderers
// ---------------------------------------------------------------------------

function makeSelect(options, currentValue, onChange) {
  const sel = document.createElement('select');
  sel.className = 'ae-select';
  for (const { value, label } of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === currentValue) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function makeBindingSelect(bindingNames, currentValue, onChange) {
  return makeSelect(
    bindingNames.map(n => ({ value: n, label: BINDING_LABELS[n] ?? n })),
    currentValue ?? bindingNames[0],
    onChange
  );
}

function makeNumInput(value, { min, max, step = 1, isFloat = false }, onChange) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.className = 'ae-input';
  inp.value = value ?? 0;
  if (min != null) inp.min = min;
  if (max != null) inp.max = max;
  inp.step = step;
  inp.addEventListener('input', () => {
    const v = isFloat ? parseFloat(inp.value) : parseInt(inp.value, 10);
    if (!isNaN(v)) onChange(v);
  });
  return inp;
}

function makeUnit(unit) {
  if (!unit) return null;
  const s = document.createElement('span');
  s.className = 'ae-unit';
  s.textContent = unit;
  return s;
}

/**
 * Renders one field row and returns it.
 * `step` is the mutable working step object.
 * `onChange` is called with no arguments whenever the value changes.
 */
function renderField(step, field, onChange) {
  const { key, label, type, unit } = field;

  const labelEl = document.createElement('span');
  labelEl.className = 'ae-field-label';
  labelEl.textContent = label;

  const controlWrap = div('ae-field-control');
  const row = div('ae-field', labelEl, controlWrap);

  const numOpts = { min: field.min, max: field.max, isFloat: type === 'float' };

  switch (type) {
    case 'bool': {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ae-checkbox';
      cb.checked = Boolean(getDeep(step, key));
      cb.addEventListener('change', () => { setDeep(step, key, cb.checked); onChange(); });
      const lbl = document.createElement('label');
      lbl.className = 'ae-bool-label';
      lbl.appendChild(cb);
      lbl.appendChild(txt(label));
      // For bool, return a simpler one-column row
      const boolRow = div('ae-field-bool', lbl);
      return boolRow;
    }

    case 'binding': {
      const sel = makeBindingSelect(field.options, getDeep(step, key),
        v => { setDeep(step, key, v); onChange(); });
      controlWrap.appendChild(sel);
      break;
    }

    case 'select': {
      const sel = makeSelect(field.options, getDeep(step, key),
        v => { setDeep(step, key, v); onChange(); });
      controlWrap.appendChild(sel);
      break;
    }

    case 'int':
    case 'float': {
      const inp = makeNumInput(getDeep(step, key), numOpts,
        v => { setDeep(step, key, v); onChange(); });
      const u = makeUnit(unit);
      controlWrap.appendChild(inp);
      if (u) controlWrap.appendChild(u);
      break;
    }

    case 'int_nullable': {
      const raw = getDeep(step, key);
      const enabled = raw != null;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ae-checkbox';
      cb.checked = enabled;

      const inp = makeNumInput(raw ?? 100, { ...numOpts, isFloat: false },
        v => { setDeep(step, key, v); onChange(); });
      inp.disabled = !enabled;
      if (!enabled) inp.classList.add('ae-disabled');

      cb.addEventListener('change', () => {
        inp.disabled = !cb.checked;
        inp.classList.toggle('ae-disabled', !cb.checked);
        setDeep(step, key, cb.checked ? (parseInt(inp.value, 10) || 100) : null);
        onChange();
      });

      const u = makeUnit(unit);
      controlWrap.appendChild(cb);
      controlWrap.appendChild(inp);
      if (u) controlWrap.appendChild(u);
      break;
    }

    default: {
      const s = document.createElement('span');
      s.className = 'ae-unit';
      s.textContent = '—';
      controlWrap.appendChild(s);
    }
  }

  return row;
}

// ---------------------------------------------------------------------------
// Step card
// ---------------------------------------------------------------------------

function renderStep(step, onChange) {
  const fields = stepFields(step.op);

  const opEl = document.createElement('span');
  opEl.className = 'ae-step-op';
  opEl.textContent = step.op;

  const idEl = document.createElement('span');
  idEl.className = 'ae-step-id';
  idEl.textContent = `id: ${step.id}`;

  const head = div('ae-step-header', opEl, idEl);
  const body = div('ae-step-body', ...fields.map(f => renderField(step, f, onChange)));
  return div('ae-step', head, body);
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createAlgoEditor(onChange) {
  let workingSpec = null;
  let activeCategory = STEP_CATEGORIES[0];

  // ---- Modal skeleton ----
  const overlay = div('ae-overlay');
  const modal   = div('ae-modal');
  overlay.appendChild(modal);

  const titleEl = div('ae-title');
  const closeX  = document.createElement('button');
  closeX.className   = 'ae-close';
  closeX.textContent = '×';
  closeX.addEventListener('click', close);

  modal.appendChild(div('ae-header', titleEl, closeX));

  // Tabs
  const tabBar = div('ae-tabs');
  const tabBtns = {};
  for (const cat of STEP_CATEGORIES) {
    const btn = document.createElement('button');
    btn.className   = 'ae-tab';
    btn.textContent = CATEGORY_LABELS[cat];
    btn.addEventListener('click', () => selectTab(cat));
    tabBtns[cat] = btn;
    tabBar.appendChild(btn);
  }
  modal.appendChild(tabBar);

  // Content
  const content = div('ae-content');
  modal.appendChild(content);

  // Footer
  const dlBtn = document.createElement('button');
  dlBtn.className   = 'ae-btn ae-btn-primary';
  dlBtn.textContent = 'Download JSON';
  dlBtn.addEventListener('click', download);

  const closeFtr = document.createElement('button');
  closeFtr.className   = 'ae-btn';
  closeFtr.textContent = 'Close';
  closeFtr.addEventListener('click', close);

  modal.appendChild(div('ae-footer', dlBtn, closeFtr));

  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);

  // ---- Drag-to-move ----
  const header = modal.querySelector('.ae-header');
  let dragOX = 0, dragOY = 0;

  header.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = modal.getBoundingClientRect();
    dragOX = e.clientX - rect.left;
    dragOY = e.clientY - rect.top;

    function onMove(e) {
      const x = Math.max(0, Math.min(e.clientX - dragOX, window.innerWidth  - modal.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - dragOY, window.innerHeight - modal.offsetHeight));
      modal.style.left = x + 'px';
      modal.style.top  = y + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ---- Logic ----

  function selectTab(cat) {
    activeCategory = cat;
    for (const [c, btn] of Object.entries(tabBtns)) {
      btn.classList.toggle('ae-tab-active', c === cat);
    }
    renderContent();
  }

  function renderContent() {
    content.innerHTML = '';
    if (!workingSpec) return;

    const steps = (workingSpec.steps ?? []).filter(s => s.type === activeCategory);
    if (steps.length === 0) {
      const msg = div('ae-empty');
      msg.textContent = 'No steps in this category.';
      content.appendChild(msg);
      return;
    }
    const notify = () => onChange(workingSpec);
    steps.forEach(s => content.appendChild(renderStep(s, notify)));
  }

  function download() {
    if (!workingSpec) return;
    const json = JSON.stringify(workingSpec, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${workingSpec.algorithm_id ?? 'algorithm'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function open(spec) {
    workingSpec = JSON.parse(JSON.stringify(spec)); // deep clone
    titleEl.textContent = spec.display_name ?? `Algorithm ${spec.algorithm_id}`;
    selectTab(activeCategory);
    overlay.classList.add('ae-visible');
    // Center on first open; preserve position if already moved
    if (!modal.style.left) {
      modal.style.left = Math.max(0, (window.innerWidth  - modal.offsetWidth)  / 2) + 'px';
      modal.style.top  = Math.max(0, (window.innerHeight - modal.offsetHeight) / 2) + 'px';
    }
  }

  function close() {
    overlay.classList.remove('ae-visible');
  }

  return { open, close };
}
