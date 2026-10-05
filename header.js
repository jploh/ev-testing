// Shared site header. Pages write their own title markup inside <site-header>;
// this wraps it in the common <header> layout and adds the theme toggle.
// Load it in <head> (not deferred) so the theme is applied before first paint.
//
//   <site-header>            landing-page sizing
//   <site-header compact>    report-page sizing
//     <h1>…</h1><p class="lede">…</p>
//   </site-header>
//
// Breadcrumbs: crumbs="Label @ href | … | Current page". "Home" is prepended
// automatically; hrefs are resolved from the site root, so they work at any depth.

(() => {
  const THEME_KEY = 'ev-theme';
  const root = document.documentElement;
  // header.js lives at the site root, so its own URL locates the root.
  const SITE_ROOT = new URL('.', document.currentScript.src);

  function applyTheme(t) {
    root.setAttribute('data-theme', t);
    const sun = document.getElementById('ico-sun');
    const moon = document.getElementById('ico-moon');
    if (sun) sun.hidden = t === 'dark';
    if (moon) moon.hidden = t !== 'dark';
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }

  // Follows the OS setting on a first visit, then remembers the viewer's explicit choice.
  (function initTheme() {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(t);
  })();

  const THEME_BUTTON = `
    <button class="icon-btn" id="theme" aria-label="Toggle dark mode" title="Toggle dark mode">
      <svg id="ico-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      <svg id="ico-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" hidden><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    </button>`;

  const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  function buildCrumbs(spec) {
    const items = [{ label: 'Home', href: '' }].concat(spec.split('|').map(part => {
      const [label, href] = part.split('@').map(x => x.trim());
      return { label, href };
    }));
    const nav = document.createElement('nav');
    nav.className = 'crumbs';
    nav.setAttribute('aria-label', 'Breadcrumb');
    const ol = document.createElement('ol');
    items.forEach((item, i) => {
      const li = document.createElement('li');
      const last = i === items.length - 1;
      const el = document.createElement(last || item.href == null ? 'span' : 'a');
      el.textContent = item.label;
      if (last) el.setAttribute('aria-current', 'page');
      else if (item.href != null) el.href = new URL(item.href, SITE_ROOT).href;
      li.append(el);
      if (!last) li.insertAdjacentHTML('beforeend', CHEVRON);
      ol.append(li);
    });
    nav.append(ol);
    return nav;
  }

  class SiteHeader extends HTMLElement {
    connectedCallback() {
      // Defined while the parser is still in <head>, so children may not exist yet.
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.render(), { once: true });
      } else {
        this.render();
      }
    }

    render() {
      if (this.querySelector(':scope > header')) return;
      const header = document.createElement('header');
      const text = document.createElement('div');
      text.append(...this.childNodes);
      const crumbs = this.getAttribute('crumbs');
      if (crumbs) text.prepend(buildCrumbs(crumbs));
      header.append(text);
      header.insertAdjacentHTML('beforeend', THEME_BUTTON);
      this.append(header);

      applyTheme(root.getAttribute('data-theme'));
      header.querySelector('#theme').addEventListener('click', () =>
        applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
    }
  }

  customElements.define('site-header', SiteHeader);
})();
