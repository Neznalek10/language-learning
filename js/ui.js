import { LEVELS, MAX_STREAK, levelOf } from './srs.js';
import { store } from './store.js';
import { unitLabel } from './units.js';
import { nounFor, locale } from './i18n.js';

class Raw {
  constructor(s) { this.s = s; }
}
export const raw = s => new Raw(s);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

const renderValue = v => {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(renderValue).join('');
  if (v instanceof Raw) return v.s;
  return esc(v);
};

// Interpolated values are escaped unless wrapped in raw() or produced by html``.
export const html = (strings, ...values) =>
  raw(strings.reduce((out, s, i) => out + s + (i < values.length ? renderValue(values[i]) : ''), ''));

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v12h14V9"/><path d="M10 21v-6h4v6"/>',
  decks: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12.5 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  words: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  stats: '<path d="M3 21h18"/><path d="M6 17v-6M11 17V5M16 17v-9M21 17v-3"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h12M20 18h0"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  flame: '<path d="M12 3c.8 3.4 5 5.4 5 10a5 5 0 0 1-10 0c0-2 .9-3.6 2-4.6.3 1.6 1.2 2.6 2 2.6 0-3-1-5.2 1-8Z"/>',
  play: '<path d="M7 4.5v15l12-7.5-12-7.5Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M10 17h4v4h-4z"/>',
  bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  tenses: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/>',
  units: '<path d="M4 5a2 2 0 0 1 2-2h12v15H6a2 2 0 0 0-2 2V5Z"/><path d="M4 20a2 2 0 0 0 2 2h12v-4"/><path d="M9 8h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2Z"/>',
  grammar: '<path d="M2 5c3-1.5 6.5-1.5 10 1 3.5-2.5 7-2.5 10-1v14c-3-1.5-6.5-1.5-10 1-3.5-2.5-7-2.5-10-1V5Z"/><path d="M12 6v14"/>',
  learn: '<path d="m2 9 10-5 10 5-10 5L2 9Z"/><path d="M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5"/><path d="M22 9v6"/>',
  write: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  speak: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
};

export const icon = (name, cls = '') =>
  raw(`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`);

export const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
export const fmt = n => (n >= 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : n.toLocaleString(locale()));
export const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${nounFor(n, one, many)}`;
export const answersText = a => a.join(' / ');

export function masteryBar(levels, { thin = false } = {}) {
  const total = Object.values(levels).reduce((a, b) => a + b, 0);
  const segments = LEVELS.filter(l => levels[l.key]).map(l => html`
    <span class="seg lvl-${l.key}" style="flex-grow:${levels[l.key]}" title="${l.label}: ${levels[l.key]}"></span>`);
  return html`<div class="mastery-bar ${thin ? 'thin' : ''}" role="img"
    aria-label="${LEVELS.map(l => `${l.label} ${levels[l.key]}`).join(', ')}">${total ? segments : html`<span class="seg lvl-new" style="flex-grow:1"></span>`}</div>`;
}

export function masteryLegend(levels, { links = false } = {}) {
  return html`<div class="legend">${LEVELS.map(l => {
    const inner = html`<span class="swatch lvl-${l.key}"></span><span class="legend-label">${l.label}</span><span class="legend-value">${fmt(levels[l.key])}</span>`;
    return links
      ? html`<a class="legend-item" href="#/words?level=${l.key}">${inner}</a>`
      : html`<span class="legend-item">${inner}</span>`;
  })}</div>`;
}

export function levelDots(p) {
  const streak = p?.streak || 0;
  const level = levelOf(p);
  const dots = Array.from({ length: MAX_STREAK }, (_, i) => html`<i class="${i < streak ? `on lvl-${level}` : ''}"></i>`);
  return html`<span class="dots" title="${streak} correct in a row" aria-label="${streak} of ${MAX_STREAK} correct in a row">${dots}</span>`;
}

export function scorePair(p) {
  if (!p) return html`<span class="score muted">Not practiced</span>`;
  return html`<span class="score"><span class="score-ok">${icon('check')}${p.right}</span><span class="score-ko">${icon('x')}${p.wrong}</span></span>`;
}

export function wordRow(word, p, { showDeck = false } = {}) {
  return html`<div class="word-row" data-search="${(word.q + ' ' + word.a.join(' ')).toLowerCase()}">
    <div class="word-main">
      <div class="word-q">${word.q}</div>
      <div class="word-a" lang="${word.deck.lang}">${answersText(word.a)}</div>
      ${showDeck || word.unit || word.level ? html`<div class="word-deck">${[
        showDeck ? word.deck.title : '',
        word.unit ? html`<span class="tag">${unitLabel(word.unit)}</span>` : '',
        word.level ? html`<span class="tag">${word.level}</span>` : '',
      ]}</div>` : ''}
    </div>
    <div class="word-side">${levelDots(p)}${scorePair(p)}</div>
  </div>`;
}

export function segmented(name, options, value) {
  return html`<div class="segmented" role="radiogroup" data-name="${name}">${options.map(o => html`
    <button type="button" role="radio" aria-checked="${String(o.value === value)}" class="${o.value === value ? 'active' : ''}" data-value="${o.value}">${o.label}</button>`)}</div>`;
}

export function onSegmented(root, handler) {
  root.querySelectorAll('.segmented').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('button[data-value]');
      if (!btn) return;
      group.querySelectorAll('button').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-checked', String(b === btn));
      });
      handler(group.dataset.name, btn.dataset.value);
    });
  });
}

export function emptyState({ iconName = 'info', title, text, action }) {
  return html`<div class="empty">
    <div class="empty-icon">${icon(iconName)}</div>
    <h3>${title}</h3>
    ${text ? html`<p>${text}</p>` : ''}
    ${action || ''}
  </div>`;
}

const THEME_COLORS = { light: '#f3f3f0', dark: '#0d0d0d' };

export function applyTheme() {
  const theme = store.settings.theme;
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
  document.querySelectorAll('meta[name=theme-color]').forEach(meta => {
    meta.content = THEME_COLORS[theme] || THEME_COLORS[meta.media.includes('dark') ? 'dark' : 'light'];
  });
}
