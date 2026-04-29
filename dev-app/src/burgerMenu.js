/**
 * BurgerMenu — Appearance (dark-mode toggle) + Curves section.
 *
 * Usage:
 *   const menu = createBurgerMenu({ curves, getCurveId, getIsDark, onToggleTheme,
 *                                   onCurveChange, onReset, onSaveCurve, onCopy, onClear });
 *   someHeaderElement.appendChild(menu.root);
 */
export function createBurgerMenu({
  curves,
  getCurveId,
  getIsDark,
  onToggleTheme,
  onCurveChange,
  onReset,
  onSaveCurve,
  onCopy,
  onCopyBitmap,
  onPaste,
  onClear,
}) {
  let isOpen = false;

  // ---- Container ----
  const container = document.createElement('div');
  container.className = 'bm-container';

  // ---- Burger button ----
  const btn = document.createElement('button');
  btn.className = 'bm-button';
  btn.title = 'Menu';
  btn.setAttribute('aria-label', 'Open menu');
  btn.setAttribute('aria-expanded', 'false');
  for (let i = 0; i < 3; i++) {
    const line = document.createElement('span');
    line.className = 'bm-line';
    btn.appendChild(line);
  }

  // ---- Dropdown ----
  const dropdown = document.createElement('div');
  dropdown.className = 'bm-dropdown';

  // ================================================================
  // Section 1: Appearance
  // ================================================================
  const appSection = document.createElement('div');
  appSection.className = 'bm-section';

  const appTitle = document.createElement('div');
  appTitle.className = 'bm-section-title';
  appTitle.textContent = 'Appearance';
  appSection.appendChild(appTitle);

  // Dark mode row — div (not button) so it doesn't close the menu on click
  const themeRow = document.createElement('div');
  themeRow.className = 'bm-item';

  const themeIconEl = document.createElement('span');
  themeIconEl.className = 'bm-item-icon';

  const themeTextEl = document.createElement('span');
  themeTextEl.className = 'bm-item-text';
  themeTextEl.textContent = 'Dark Mode';

  const toggleTrack = document.createElement('div');
  toggleTrack.className = 'bm-toggle-track';
  const toggleThumb = document.createElement('div');
  toggleThumb.className = 'bm-toggle-thumb';
  toggleTrack.appendChild(toggleThumb);

  function syncToggle() {
    const dark = getIsDark();
    themeIconEl.textContent = dark ? '🌙' : '☀️';
    toggleTrack.classList.toggle('bm-toggle-on', dark);
    toggleThumb.classList.toggle('bm-toggle-on', dark);
  }

  toggleTrack.addEventListener('click', () => {
    onToggleTheme();
    syncToggle();
  });

  themeRow.appendChild(themeIconEl);
  themeRow.appendChild(themeTextEl);
  themeRow.appendChild(toggleTrack);
  appSection.appendChild(themeRow);

  // ================================================================
  // Section 2: Curves
  // ================================================================
  const curvesSection = document.createElement('div');
  curvesSection.className = 'bm-section';

  const curvesTitle = document.createElement('div');
  curvesTitle.className = 'bm-section-title';
  curvesTitle.textContent = 'Curves';
  curvesSection.appendChild(curvesTitle);

  // Curve selector
  const curveSelect = document.createElement('select');
  curveSelect.className = 'bm-curve-select';
  for (const [id, { name }] of Object.entries(curves)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    curveSelect.appendChild(opt);
  }
  curveSelect.value = getCurveId();
  curveSelect.addEventListener('change', () => onCurveChange(curveSelect.value));
  curvesSection.appendChild(curveSelect);

  const sep = document.createElement('div');
  sep.className = 'bm-sep';
  curvesSection.appendChild(sep);

  // Action items — close the dropdown, then run the action
  function makeItem(icon, text, action) {
    const item = document.createElement('button');
    item.className = 'bm-item';
    const iconEl = document.createElement('span');
    iconEl.className = 'bm-item-icon';
    iconEl.textContent = icon;
    const textEl = document.createElement('span');
    textEl.className = 'bm-item-text';
    textEl.textContent = text;
    item.appendChild(iconEl);
    item.appendChild(textEl);
    item.addEventListener('click', () => { close(); action(); });
    return item;
  }

  curvesSection.appendChild(makeItem('↺',  'Reset curve',  () => onReset()));
  curvesSection.appendChild(makeItem('💾', 'Save curve…', () => onSaveCurve(addCurveOption)));
  curvesSection.appendChild(makeItem('✕',  'Clear all',   () => onClear()));

  // ================================================================
  // Section 3: Copy / Export
  // ================================================================
  const exportSection = document.createElement('div');
  exportSection.className = 'bm-section';

  const exportTitle = document.createElement('div');
  exportTitle.className = 'bm-section-title';
  exportTitle.textContent = 'Copy / Export';
  exportSection.appendChild(exportTitle);

  exportSection.appendChild(makeItem('📋', 'Copy curve JSON', () => onCopy()));
  exportSection.appendChild(makeItem('🖼️', 'Copy as image',  () => onCopyBitmap()));
  exportSection.appendChild(makeItem('📥', 'Paste curve',    () => onPaste()));

  dropdown.appendChild(appSection);
  dropdown.appendChild(curvesSection);
  dropdown.appendChild(exportSection);
  container.appendChild(btn);
  container.appendChild(dropdown);

  // ---- Open / Close ----
  function open() {
    isOpen = true;
    curveSelect.value = getCurveId(); // sync in case curveId changed
    syncToggle();
    btn.classList.add('bm-open');
    btn.setAttribute('aria-expanded', 'true');
    dropdown.classList.add('bm-visible');
  }

  function close() {
    isOpen = false;
    btn.classList.remove('bm-open');
    btn.setAttribute('aria-expanded', 'false');
    dropdown.classList.remove('bm-visible');
  }

  btn.addEventListener('click', () => (isOpen ? close() : open()));

  document.addEventListener('mousedown', (e) => {
    if (isOpen && !container.contains(e.target)) close();
  });

  document.addEventListener('keydown', (e) => {
    if (isOpen && e.key === 'Escape') close();
  });

  // ---- Public helpers ----
  function addCurveOption(id, name) {
    if (!curveSelect.querySelector(`option[value="${id}"]`)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      curveSelect.appendChild(opt);
    }
    curveSelect.value = id;
  }

  function setCurveValue(id) {
    curveSelect.value = id;
  }

  return { root: container, addCurveOption, setCurveValue };
}
