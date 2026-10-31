import { store } from '../store.js';
import { summarize } from '../srs.js';
import { combos, tenseInfo } from '../conj.js';
import { collectUnits, unitConjVerbs, unitLabel } from '../units.js';
import { html, icon, plural, pct, masteryBar, masteryLegend, wordRow, emptyState } from '../ui.js';
import { startDrill } from './drill.js';

const unitHref = u => `#/unit/${encodeURIComponent(u.id)}`;

function counts(u) {
  return [
    u.words.length && plural(u.words.length, 'word'),
    u.verbs.length && plural(u.verbs.length, 'verb'),
    u.tenses.length && plural(u.tenses.length, 'tense'),
  ].filter(Boolean).join(' · ') || 'Empty';
}

export function unitsView(app) {
  const units = collectUnits(app);
  if (!units.length) {
    return {
      title: 'Units',
      body: emptyState({
        iconName: 'units',
        title: 'No units yet',
        text: 'Every word is currently not in a unit. Give words a unit when you add them, or set "unit" in a deck file, and each unit will collect its words, verbs and tenses here.',
        action: html`<a class="btn btn-primary" href="#/import?mode=add">${icon('plus')}Add a word</a>`,
      }),
    };
  }

  const body = html`
    <div class="unit-list">${units.map(u => {
      const s = summarize([...u.words, ...u.verbs], store.progress);
      return html`<a class="card unit-card" href="${unitHref(u)}">
        <div class="unit-card-head">
          <span class="unit-badge">${/^\d+$/.test(u.id) ? u.id : u.id.charAt(0).toUpperCase()}</span>
          <div class="unit-card-main"><h2>${unitLabel(u.id)}</h2>${u.title ? html`<div class="card-meta">${u.title}</div>` : ''}</div>
          ${icon('chevronRight', 'chevron')}
        </div>
        <div class="unit-card-meta">${counts(u)}${s.total ? ` · ${pct(s.levels.mastered, s.total)}% mastered` : ''}</div>
        ${s.total ? masteryBar(s.levels, { thin: true }) : ''}
      </a>`;
    })}</div>
    <p class="muted small unit-help">Words join a unit through their "unit" value. Words without one are not in any unit.</p>`;

  return { title: 'Units', body };
}

export function unitView(app, { id }) {
  const unit = collectUnits(app).find(u => u.id === id);
  if (!unit) return { redirect: 'units' };
  const s = store.settings;
  const vocab = [...unit.words, ...unit.verbs];
  const vocabSum = summarize(vocab, store.progress);
  const verbs = unit.tenses.length ? unitConjVerbs(app, unit) : [];
  const ownVerbs = verbs.length && unit.verbs.length;
  const data = app.conj[app.lang];
  const label = unitLabel(unit.id);

  const runTenses = () => startDrill(app, { verbs, tenses: unit.tenses, mode: s.conjMode, count: Number(s.conjLength), title: label });
  const runVocab = next => app.startSession({ pool: vocab, mode: 'smart', count: Infinity, title: label, next });

  const body = html`
    <section class="card unit-head">
      <div class="eyebrow">${unit.title || 'Everything assigned to this unit'}</div>
      <div class="deck-stats">
        <div><strong>${unit.words.length}</strong><span>${unit.words.length === 1 ? 'word' : 'words'}</span></div>
        <div><strong>${unit.verbs.length}</strong><span>${unit.verbs.length === 1 ? 'verb' : 'verbs'}</span></div>
        <div><strong>${unit.tenses.length}</strong><span>${unit.tenses.length === 1 ? 'tense' : 'tenses'}</span></div>
      </div>
      ${vocab.length ? html`${masteryBar(vocabSum.levels)}${masteryLegend(vocabSum.levels)}` : ''}
      <button class="btn btn-primary btn-block btn-lg" data-all ${vocab.length || unit.tenses.length ? '' : 'disabled'}>${icon('play')}Practice unit</button>
      ${vocab.length && unit.tenses.length ? html`<div class="deck-actions">
        <button class="btn btn-secondary" data-vocab>${icon('words')}Vocabulary</button>
        <button class="btn btn-secondary" data-tenses>${icon('tenses')}Tenses</button>
      </div>` : ''}
      ${vocab.length || unit.tenses.length ? html`<p class="muted small unit-plan">${[
        vocab.length ? `All ${plural(vocab.length, 'word')} as vocabulary` : '',
        unit.tenses.length ? `${unit.tenses.map(t => tenseInfo(data, t).label).join(', ')} with ${ownVerbs ? 'this unit\'s verbs' : 'all verbs'}` : '',
      ].filter(Boolean).join(', then ')}.</p>` : ''}
    </section>

    ${unit.words.length ? html`<section class="card">
      <header class="card-head"><h2>Words</h2><span class="card-meta">${plural(unit.words.length, 'word')}</span></header>
      <div class="word-list">${unit.words.map(w => wordRow(w, store.progress[w.id], { showDeck: true }))}</div>
    </section>` : ''}

    ${unit.verbs.length ? html`<section class="card">
      <header class="card-head"><h2>Verbs</h2><span class="card-meta">${plural(unit.verbs.length, 'verb')}</span></header>
      <div class="word-list">${unit.verbs.map(w => wordRow(w, store.progress[w.id], { showDeck: true }))}</div>
    </section>` : ''}

    <section class="card">
      <header class="card-head"><h2>Tenses</h2><span class="card-meta">${unit.tenses.length ? `with ${ownVerbs ? 'this unit\'s verbs' : 'all verbs'}` : ''}</span></header>
      ${unit.tenses.length
        ? html`<div class="tense-list">${unit.tenses.map(t => {
            const sum = summarize(combos(app.lang, verbs, [t]), store.conj);
            return html`<div class="tense-row"><span class="tense-row-main"><span class="tense-row-title">${tenseInfo(data, t).label}</span>${masteryBar(sum.levels, { thin: true })}</span>
              <span class="tense-row-value">${pct(sum.levels.mastered, sum.total)}%</span></div>`;
          })}</div>`
        : html`<p class="muted small">No tenses in this unit. List them under "units" in words.json, for example <code>"units": {"fr": {"${unit.id}": {"tenses": ["present"]}}}</code>.</p>`}
    </section>`;

  return {
    title: label,
    back: 'units',
    tab: 'units',
    hideLang: true,
    body,
    mount(root) {
      root.querySelector('[data-all]').addEventListener('click', () => {
        if (!vocab.length) return runTenses();
        runVocab(unit.tenses.length ? { label: 'Continue with tenses', run: runTenses } : undefined);
      });
      root.querySelector('[data-vocab]')?.addEventListener('click', () => runVocab());
      root.querySelector('[data-tenses]')?.addEventListener('click', runTenses);
    },
  };
}
