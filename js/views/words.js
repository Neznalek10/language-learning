import { store } from '../store.js';
import { summarize, levelOf, LEVELS } from '../srs.js';
import { html, icon, fmt, wordRow, emptyState } from '../ui.js';
import { noDecks } from './decks.js';

const ORDER = { mastered: 0, familiar: 1, learning: 2, new: 3 };

export function wordsView(app, { level = 'all' }) {
  const decks = app.decksFor();
  if (!decks.length) return { title: 'Words', body: noDecks() };

  const words = app.wordsOf(decks);
  const s = summarize(words, store.progress);
  const tabs = [{ key: 'all', label: 'All', count: s.total }, ...LEVELS.map(l => ({ key: l.key, label: l.label, count: s.levels[l.key] }))];
  const active = tabs.some(t => t.key === level) ? level : 'all';
  const info = LEVELS.find(l => l.key === active);

  const list = words
    .map(w => ({ w, p: store.progress[w.id] }))
    .filter(({ p }) => active === 'all' || levelOf(p) === active)
    .sort((a, b) => ORDER[levelOf(a.p)] - ORDER[levelOf(b.p)] || (b.p?.streak || 0) - (a.p?.streak || 0) || a.w.q.localeCompare(b.w.q, 'cs'));

  const body = html`
    <div class="level-tabs" role="tablist">${tabs.map(t => html`
      <a class="level-tab ${t.key === active ? 'active' : ''}" href="#/words?level=${t.key}" role="tab" aria-selected="${String(t.key === active)}">
        ${t.key !== 'all' ? html`<span class="swatch lvl-${t.key}"></span>` : ''}<span>${t.label}</span><span class="level-tab-count">${fmt(t.count)}</span>
      </a>`)}
    </div>
    ${info ? html`<p class="level-hint">${info.hint}</p>` : ''}
    <label class="search">${icon('search')}<input type="search" placeholder="Search ${fmt(list.length)} words" aria-label="Search words"></label>
    ${list.length
      ? html`<div class="card word-list">${list.map(({ w, p }) => wordRow(w, p, { showDeck: true }))}</div>
        <p class="no-results" hidden>No words match your search.</p>`
      : emptyState({ iconName: 'words', title: `No ${info ? info.label.toLowerCase() : ''} words yet`, text: 'Practice a few sessions and words will move up through the levels.' })}
    ${list.length ? html`<div class="sticky-cta"><button class="btn btn-primary btn-block btn-lg" data-practice>${icon('play')}Practice ${active === 'all' ? 'these words' : `${info.label.toLowerCase()} words`}</button></div>` : ''}`;

  return {
    title: 'Words',
    body,
    mount(root) {
      const rows = [...root.querySelectorAll('.word-row')];
      const empty = root.querySelector('.no-results');
      root.querySelector('input[type=search]').addEventListener('input', e => {
        const term = e.target.value.trim().toLowerCase();
        let shown = 0;
        for (const row of rows) {
          const match = !term || row.dataset.search.includes(term);
          row.hidden = !match;
          shown += match;
        }
        if (empty) empty.hidden = shown > 0;
      });
      root.querySelector('[data-practice]')?.addEventListener('click', () => {
        app.startSession({ decks, mode: active, title: info ? `${info.label} words` : 'All words' });
      });
    },
  };
}
