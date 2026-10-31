import { store } from '../store.js';
import { summarize } from '../srs.js';
import { conjVerbs, combos, persons, compact, subjectPrefix, tenseInfo, comboKey } from '../conj.js';
import { langName } from '../data.js';
import { html, icon, plural, pct, masteryBar, levelDots, segmented, onSegmented, emptyState } from '../ui.js';
import { startDrill } from './drill.js';

const LENGTHS = { single: ['10', '20', '30'], table: ['5', '10', '15'] };

export function conjSelection(app) {
  const s = store.settings;
  const data = app.conj[app.lang];
  const all = conjVerbs(app);
  const decks = [...new Map(all.map(v => [v.deck.id, v.deck])).values()];
  const deckIds = s.conjDecks?.filter(id => decks.some(d => d.id === id)) ?? decks.map(d => d.id);
  const inDecks = all.filter(v => deckIds.includes(v.deck.id));
  const verbs = s.conjVerbs ? inDecks.filter(v => s.conjVerbs.includes(v.inf)) : inDecks;
  const tenses = data ? s.conjTenses.filter(k => tenseInfo(data, k)) : [];
  return { lang: app.lang, data, all, decks, deckIds, inDecks, verbs, tenses };
}

function moodGroups(data) {
  const groups = new Map();
  for (const t of data.tenses) {
    if (!groups.has(t.mood)) groups.set(t.mood, []);
    groups.get(t.mood).push(t);
  }
  return [...groups];
}

const shortLabel = t => (t.mood === 'Indicatif' ? t.label : t.label.slice(t.mood.length + 1).replace(/^./, c => c.toUpperCase()));

function noTenses(app) {
  return {
    title: 'Tenses',
    body: emptyState({
      iconName: 'tenses',
      title: `No conjugation tables for ${langName(app.lang)}`,
      text: 'Conjugation practice is available for languages with generated tables. See tools/conjugate.py in the repository.',
    }),
  };
}

function conjTable(sel, verb, tense) {
  const p = store.conj[comboKey(sel.lang, verb.inf, tense.key)];
  return html`<section class="card conj-table">
    <header class="conj-table-head"><h3>${shortLabel(tense)}</h3>${levelDots(p)}</header>
    ${persons(verb, tense.key).map(i => {
      const forms = verb.data.t[tense.key][i];
      return html`<div class="conj-row"><span class="conj-subject">${subjectPrefix(sel.data, tense.key, i, forms[0])}</span><span class="conj-form">${compact(forms)}</span></div>`;
    })}
  </section>`;
}

function tenseSheet(app, sel, tense) {
  const sample = sel.verbs.find(v => v.data.t[tense.key]) || sel.all.find(v => v.data.t[tense.key]);
  app.sheet({
    title: tense.label,
    body: html`
      <p class="sheet-text">${tense.hint}</p>
      ${sample ? html`<div class="field-label">Example: ${sample.inf} (${sample.meaning})</div>${conjTable(sel, sample, tense)}` : ''}
      <button class="btn btn-primary btn-block btn-lg" data-go>${icon('play')}Practice ${tense.label}</button>`,
    onMount(body, close) {
      body.querySelector('[data-go]').addEventListener('click', () => {
        close();
        const s = store.settings;
        startDrill(app, { verbs: sel.verbs.length ? sel.verbs : sel.all, tenses: [tense.key], mode: s.conjMode, count: Number(s.conjLength), title: tense.label });
      });
    },
  });
}

function verbPicker(app, sel) {
  const chosen = new Set(sel.verbs.map(v => v.inf));
  app.sheet({
    title: 'Choose verbs',
    body: html`
      <label class="search">${icon('search')}<input type="search" placeholder="Search verbs" aria-label="Search verbs"></label>
      <div class="picker-actions"><button class="btn btn-text btn-sm" data-all>Select all</button><button class="btn btn-text btn-sm" data-none>Clear</button></div>
      <div class="check-list">${sel.decks.filter(d => sel.deckIds.includes(d.id)).map(d => html`
        <div class="check-group">${d.title}</div>
        ${sel.inDecks.filter(v => v.deck === d).map(v => html`<label class="check-row" data-search="${(v.inf + ' ' + v.meaning).toLowerCase()}">
          <input type="checkbox" value="${v.inf}" ${chosen.has(v.inf) ? 'checked' : ''}><span><strong>${v.inf}</strong><small>${v.meaning}</small></span>
        </label>`)}`)}
      </div>
      <button class="btn btn-primary btn-block btn-lg" data-done>Done</button>`,
    onMount(body, close) {
      const boxes = [...body.querySelectorAll('input[type=checkbox]')];
      const done = body.querySelector('[data-done]');
      const update = () => {
        const n = boxes.filter(b => b.checked).length;
        done.textContent = n ? `Use ${plural(n, 'verb')}` : 'Select at least one verb';
        done.disabled = !n;
      };
      body.addEventListener('change', update);
      body.querySelector('[data-all]').addEventListener('click', () => { boxes.forEach(b => { b.checked = true; }); update(); });
      body.querySelector('[data-none]').addEventListener('click', () => { boxes.forEach(b => { b.checked = false; }); update(); });
      body.querySelector('input[type=search]').addEventListener('input', e => {
        const term = e.target.value.trim().toLowerCase();
        body.querySelectorAll('.check-row').forEach(row => { row.hidden = term && !row.dataset.search.includes(term); });
      });
      done.addEventListener('click', () => {
        const picked = boxes.filter(b => b.checked).map(b => b.value);
        store.settings.conjVerbs = picked.length === boxes.length ? null : picked;
        store.save('settings');
        close();
        app.render();
      });
      update();
    },
  });
}

export function tensesView(app) {
  const sel = conjSelection(app);
  if (!sel.data || !sel.all.length) return noTenses(app);
  const s = store.settings;
  const lang = app.lang;
  const pool = combos(lang, sel.verbs, sel.tenses);
  const length = LENGTHS[s.conjMode].includes(String(s.conjLength)) ? String(s.conjLength) : LENGTHS[s.conjMode][0];
  const questions = s.conjMode === 'table' ? Math.min(Number(length), pool.length) : (pool.length ? Number(length) : 0);
  const verbNote = s.conjVerbs ? `${sel.verbs.length} of ${sel.inDecks.length} verbs` : `All ${plural(sel.inDecks.length, 'verb')}`;

  const body = html`
    <section class="card conj-setup">
      <header class="card-head"><h2>Practice</h2><span class="card-meta">${plural(sel.verbs.length, 'verb')} · ${plural(sel.tenses.length, 'tense')}</span></header>

      <div class="field-row"><span class="field-label">Tenses</span>
        <span class="presets"><button data-preset="core">Core</button><button data-preset="all">All</button><button data-preset="none">Clear</button></span>
      </div>
      ${moodGroups(sel.data).map(([mood, tenses]) => html`
        <div class="mood-label">${mood}</div>
        <div class="chips wrap">${tenses.map(t => html`
          <button class="chip ${sel.tenses.includes(t.key) ? 'active' : ''}" data-tense="${t.key}" aria-pressed="${String(sel.tenses.includes(t.key))}">
            ${shortLabel(t)}${t.level === 'literary' ? html`<span class="chip-tag">literary</span>` : ''}
          </button>`)}
        </div>`)}

      <div class="field-label">Verb categories</div>
      <div class="chips wrap">${sel.decks.map(d => {
        const n = sel.all.filter(v => v.deck === d).length;
        return html`<button class="chip ${sel.deckIds.includes(d.id) ? 'active' : ''}" data-deck="${d.id}" aria-pressed="${String(sel.deckIds.includes(d.id))}">${d.title}<span class="chip-count">${n}</span></button>`;
      })}</div>
      <button class="btn btn-secondary btn-sm pick-verbs" data-pick ${sel.inDecks.length ? '' : 'disabled'}>${icon('words')}${verbNote}${icon('chevronRight')}</button>

      <div class="form-grid conj-options">
        <div><div class="field-label">Mode</div>${segmented('mode', [{ value: 'single', label: 'One form' }, { value: 'table', label: 'Full table' }], s.conjMode)}</div>
        <div><div class="field-label">${s.conjMode === 'table' ? 'Tables' : 'Questions'}</div>${segmented('length', LENGTHS[s.conjMode].map(v => ({ value: v, label: v })), length)}</div>
      </div>

      <button class="btn btn-primary btn-block btn-lg" data-start ${questions ? '' : 'disabled'}>${icon('play')}${questions ? `Start · ${plural(questions, s.conjMode === 'table' ? 'table' : 'question')}` : 'Pick at least one tense and verb'}</button>
    </section>

    <section class="card">
      <header class="card-head"><h2>Progress by tense</h2><span class="card-meta">All ${plural(sel.all.length, 'verb')}</span></header>
      <div class="tense-list">${sel.data.tenses.map(t => {
        const sum = summarize(combos(lang, sel.all, [t.key]), store.conj);
        return html`<button class="tense-row" data-info="${t.key}">
          <span class="tense-row-main"><span class="tense-row-title">${t.label}${t.level === 'literary' ? html`<span class="chip-tag">literary</span>` : ''}</span>${masteryBar(sum.levels, { thin: true })}</span>
          <span class="tense-row-value">${pct(sum.levels.mastered, sum.total)}%</span>${icon('info', 'chevron')}
        </button>`;
      })}</div>
    </section>

    <section class="card">
      <header class="card-head"><h2>Verb tables</h2><span class="card-meta">${plural(sel.all.length, 'verb')}</span></header>
      <label class="search">${icon('search')}<input type="search" placeholder="Search verbs" aria-label="Search verbs"></label>
      <div class="deck-list verb-list">${sel.all.map(v => html`
        <a class="deck-row" href="#/verb/${encodeURIComponent(v.inf)}" data-search="${(v.inf + ' ' + v.meaning).toLowerCase()}">
          <div class="deck-row-main"><div class="deck-row-title">${v.inf}</div><div class="deck-row-meta">${v.meaning} · ${v.deck.title}</div></div>
          ${icon('chevronRight', 'chevron')}
        </a>`)}
      </div>
    </section>`;

  return {
    title: 'Tenses',
    back: 'grammar',
    tab: 'grammar',
    body,
    mount(root) {
      const save = () => {
        store.save('settings');
        app.render();
      };
      root.querySelectorAll('[data-tense]').forEach(chip => chip.addEventListener('click', () => {
        const key = chip.dataset.tense;
        const set = new Set(sel.tenses);
        if (set.has(key)) set.delete(key);
        else set.add(key);
        s.conjTenses = sel.data.tenses.map(t => t.key).filter(k => set.has(k));
        save();
      }));
      root.querySelectorAll('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        s.conjTenses = sel.data.tenses.filter(t => preset === 'all' || (preset === 'core' && t.level === 'core')).map(t => t.key);
        save();
      }));
      root.querySelectorAll('[data-deck]').forEach(chip => chip.addEventListener('click', () => {
        const set = new Set(sel.deckIds);
        if (set.has(chip.dataset.deck)) set.delete(chip.dataset.deck);
        else set.add(chip.dataset.deck);
        s.conjDecks = sel.decks.map(d => d.id).filter(id => set.has(id));
        save();
      }));
      onSegmented(root, (name, value) => {
        if (name === 'mode') {
          s.conjMode = value;
          s.conjLength = Number(LENGTHS[value][0]);
        }
        if (name === 'length') s.conjLength = Number(value);
        save();
      });
      root.querySelector('[data-pick]').addEventListener('click', () => verbPicker(app, sel));
      root.querySelector('[data-start]').addEventListener('click', () => {
        startDrill(app, { verbs: sel.verbs, tenses: sel.tenses, mode: s.conjMode, count: Number(length), title: 'Tenses' });
      });
      root.querySelectorAll('[data-info]').forEach(row => row.addEventListener('click', () => tenseSheet(app, sel, tenseInfo(sel.data, row.dataset.info))));
      const rows = [...root.querySelectorAll('.verb-list .deck-row')];
      root.querySelector('.verb-list').previousElementSibling.querySelector('input').addEventListener('input', e => {
        const term = e.target.value.trim().toLowerCase();
        rows.forEach(r => { r.hidden = term && !r.dataset.search.includes(term); });
      });
    },
  };
}

export function verbView(app, { id }) {
  const sel = conjSelection(app);
  const verb = sel.all.find(v => v.inf === id);
  if (!verb) return { redirect: 'tenses' };
  const d = verb.data;

  const body = html`
    <section class="card verb-head">
      <div class="eyebrow">${verb.deck.title} · ${langName(verb.deck.from)} → ${langName(verb.deck.lang)}</div>
      <div class="verb-meaning">${verb.meaning}</div>
      <div class="verb-facts">
        <span><small>Auxiliary</small>${d.aux}</span>
        <span><small>Past participle</small>${d.pp}</span>
        <span><small>Present participle</small>${d.ppr}</span>
      </div>
      <button class="btn btn-primary btn-block" data-practice>${icon('play')}Practice this verb</button>
    </section>
    ${moodGroups(sel.data).map(([mood, tenses]) => {
      const available = tenses.filter(t => d.t[t.key]);
      return available.length ? html`<h3 class="group-title">${mood}</h3>
        <div class="conj-grid">${available.map(t => conjTable(sel, verb, t))}</div>` : '';
    })}`;

  return {
    title: verb.inf,
    back: 'tenses',
    tab: 'grammar',
    hideLang: true,
    body,
    mount(root) {
      root.querySelector('[data-practice]').addEventListener('click', () => {
        const s = store.settings;
        const tenses = sel.tenses.length ? sel.tenses : sel.data.tenses.filter(t => t.level === 'core').map(t => t.key);
        startDrill(app, { verbs: [verb], tenses, mode: s.conjMode, count: Number(s.conjLength), title: verb.inf });
      });
    },
  };
}
