/**
 * Theme manager — light / dark switching with localStorage persistence.
 *
 * The `data-theme` attribute on <html> drives CSS variable selection.
 * Call initTheme() as early as possible (ideally also add a tiny inline
 * script to <head> to avoid flash-of-wrong-theme on load).
 */

const STORAGE_KEY = 'workbench-theme';

export function initTheme() {
  let dark = true;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      dark = saved !== 'light';
    } else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      dark = false;
    }
  } catch {}
  _apply(dark);
}

export function toggleTheme() {
  _apply(!getIsDark());
}

export function getIsDark() {
  return document.documentElement.getAttribute('data-theme') !== 'light';
}

function _apply(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  try { localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light'); } catch {}
}
