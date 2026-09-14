// Theme toggle. Follows the OS setting on a first visit, then remembers the
// viewer's explicit choice. Matches the behaviour of the individual reports.
const root = document.documentElement;

function applyTheme(t) {
  root.setAttribute('data-theme', t);
  document.getElementById('ico-sun').hidden = t === 'dark';
  document.getElementById('ico-moon').hidden = t !== 'dark';
  try { localStorage.setItem('ev-theme', t); } catch (e) {}
}

(function initTheme() {
  let t = null;
  try { t = localStorage.getItem('ev-theme'); } catch (e) {}
  if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(t);
})();

document.getElementById('theme').addEventListener('click', () =>
  applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
