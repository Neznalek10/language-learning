import { store } from '../store.js';
import { summarize } from '../srs.js';
import { TYPES, typeLabel, langName, slug } from '../data.js';
import { html, icon, pct, plural, masteryBar, masteryLegend, wordRow, emptyState } from '../ui.js';
import { openPracticeSheet } from './practice.js';

export function noDecks() {
  return emptyState({
    iconName: 'decks',
    title: 'No words yet',
    text: 'Add decks to words.json in your repository, or add words right here on this device.',
    action: html`<a class="btn btn-primary" href="#/import?mode=add">${icon('plus')}Add words</a>`,
  });
}

export const deckHref = d => `#/deck/${encodeURIComponent(d.id)}`;

export function deckRow(d) {
  const s = summarize(d.words, store.progress);
  return html`<a class="deck-row" href="${deckHref(d)}">
    <div class="deck-row-main">
      <div class="deck-row-title">${d.title}${d.local ? html`<span class="badge">This device</span>` : ''}</div>
      <div class="deck-row-meta">${plural(s.total, 'word')} · ${pct(s.levels.mastered, s.total)}% mastered${s.due ? html` · <span class="due">${s.due} due</span>` : ''}</div>
      ${masteryBar(s.levels, { thin: true })}
    </div>
    ${icon('chevronRight', 'chevron')}
  </a>`;
}

export function decksView(app) {
  const decks = app.decksFor();
  if (!decks.length) return { title: 'Decks', body: noDecks() };

  const order = [...TYPES.map(t => t.key), ...new Set(decks.map(d => d.type))];
  const types = [...new Set(order)].filter(t => decks.some(d => d.type === t));
  const filter = types.includes(app.ui.deckType) ? app.ui.deckType : 'all';
  const shown = filter === 'all' ? types : [filter];

  const body = html`
    <div class="toolbar">
      <div class="chips" role="tablist">
        ${[{ key: 'all', label: 'All' }, ...types.map(t => ({ key: t, label: typeLabel(t) }))].map(c => html`
          <button class="chip ${c.key === filter ? 'active' : ''}" data-type="${c.key}" role="tab" aria-selected="${String(c.key === filter)}">${c.label}</button>`)}
      </div>
      <a class="btn btn-secondary btn-sm" href="#/import?mode=add">${icon('plus')}Add</a>
    </div>
    ${shown.map(type => {
      const group = decks.filter(d => d.type === type);
      const words = group.reduce((n, d) => n + d.words.length, 0);
      return html`<section class="group">
        <h3 class="group-title">${typeLabel(type)}<span>${plural(group.length, 'deck')} · ${plural(words, 'word')}</span></h3>
        <div class="card deck-list">${group.map(deckRow)}</div>
      </section>`;
    })}`;

  return {
    title: 'Decks',
    body,
    mount(root) {
      root.querySelectorAll('[data-type]').forEach(chip => chip.addEventListener('click', () => {
        app.ui.deckType = chip.dataset.type;
        app.render();
      }));
    },
  };
}

function downloadDeck(deck) {
  const data = {
    lang: deck.lang,
    from: deck.from,
    type: deck.type,
    title: deck.title,
    unit: deck.unit,
    level: deck.level,
    words: deck.words.map(w => ({
      q: w.q,
      a: w.a.length === 1 ? w.a[0] : w.a,
      ...(w.note ? { note: w.note } : {}),
      ...(w.why ? { why: w.why } : {}),
      ...(w.unit !== deck.unit ? { unit: w.unit } : {}),
      ...(w.level !== deck.level ? { level: w.level } : {}),
    })),
  };
  const lines = data.words.map(w => `    ${JSON.stringify(w)}`).join(',\n');
  const head = Object.entries(data).filter(([k]) => k !== 'words').map(([k, v]) => `  "${k}": ${JSON.stringify(v)},`).join('\n');
  const blob = new Blob([`{\n${head}\n  "words": [\n${lines}\n  ]\n}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${slug(deck.title)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function deckView(app, { id }) {
  const deck = app.deck(id);
  if (!deck) return { redirect: 'decks' };
  const s = summarize(deck.words, store.progress);

  const body = html`
    <section class="card deck-head">
      <div class="eyebrow">${typeLabel(deck.type)} · ${langName(deck.from)} → ${langName(deck.lang)}${deck.local ? ' · Imported on this device' : ''}</div>
      <div class="deck-stats">
        <div><strong>${s.total}</strong><span>words</span></div>
        <div><strong>${pct(s.levels.mastered, s.total)}%</strong><span>mastered</span></div>
        <div><strong>${s.due}</strong><span>due now</span></div>
      </div>
      ${masteryBar(s.levels)}
      ${masteryLegend(s.levels)}
      <button class="btn btn-primary btn-block" data-practice>${icon('play')}Practice this deck</button>
      ${deck.type === 'verbs' && app.conj[deck.lang] ? html`<button class="btn btn-secondary btn-block deck-tenses" data-tenses>${icon('tenses')}Practice tenses</button>` : ''}
      ${deck.local ? html`<div class="deck-actions">
        <button class="btn btn-secondary" data-download>${icon('download')}Download JSON</button>
        <button class="btn btn-ghost-danger" data-delete>${icon('trash')}Delete</button>
      </div>` : ''}
    </section>
    <section class="card">
      <header class="card-head"><h2>Words</h2><span class="card-meta">Correct in a row · right / wrong</span></header>
      <div class="word-list">${deck.words.map(w => wordRow(w, store.progress[w.id]))}</div>
    </section>`;

  return {
    title: deck.title,
    back: 'decks',
    tab: 'decks',
    hideLang: true,
    body,
    mount(root) {
      root.querySelector('[data-practice]').addEventListener('click', () => openPracticeSheet(app, { decks: [deck], title: deck.title }));
      root.querySelector('[data-tenses]')?.addEventListener('click', () => {
        store.settings.conjDecks = [deck.id];
        store.settings.conjVerbs = null;
        store.save('settings');
        app.go('tenses');
      });
      root.querySelector('[data-download]')?.addEventListener('click', () => downloadDeck(deck));
      root.querySelector('[data-delete]')?.addEventListener('click', async () => {
        const ok = await app.confirm({
          title: 'Delete this deck?',
          text: `"${deck.title}" and its progress will be removed from this device. This can't be undone.`,
          confirmLabel: 'Delete deck',
          danger: true,
        });
        if (!ok) return;
        store.imports = store.imports.filter(d => d.id !== deck.id);
        delete store.additions[deck.id];
        for (const w of deck.words) delete store.progress[w.id];
        store.save('imports');
        store.save('additions');
        store.save('progress');
        await app.reload();
        app.toast(`Deleted "${deck.title}"`, { kind: 'success' });
        app.go('decks');
      });
    },
  };
}
