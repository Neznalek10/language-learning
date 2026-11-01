import { store } from '../store.js';
import { baseLang } from '../data.js';
import { html, icon, plural, pct, segmented, onSegmented } from '../ui.js';
import { learnParts } from '../learn/course.js';
import {
  LEVELS, DRILL_COUNTS, DRILL_MODES, translateBank, filterDrill, pickDrill, drillStats, recordDrill, sessionItems,
} from '../learn/drills.js';
import { questionsFor } from '../learn/course.js';
import { learnContext, startExercises } from './lesson.js';

const DEFAULT_DRILL = { level: 'all', count: 10, mode: 'smart', hint: false };
export const drillOptions = () => {
  const o = { ...DEFAULT_DRILL, ...store.settings.drill };
  return o.mode === 'mistakes' ? { ...o, mode: 'smart' } : o;
};
const TRANSLATE = { id: 'translate', title: 'Translate into French', tags: {}, task: 'Translate into French' };

// A set is { id, title, subtitle, tags, items }; translation is built from the bank and the unit lessons.
export function drillSets(app) {
  const lang = app.lang;
  const translate = { ...TRANSLATE, subtitle: `${baseLang() === 'cs' ? 'A Czech' : 'An English'} sentence in, the French sentence out`, items: translateBank(app.translate[lang], learnParts(app, lang)) };
  return [translate, ...(app.drills[lang]?.sets || [])].filter(s => s.items.length);
}

export const findSet = (app, id) => drillSets(app).find(s => s.id === id);

const unitNumbers = items => [...new Set(items.filter(i => i.unit).map(i => String(i.unit).split('.')[0]))].sort((a, b) => a - b);

export function startDrill(app, set, filters, opts) {
  const run = () => {
    const pool = filterDrill(set.items, filters);
    const picked = pickDrill(pool, store.learn.drills, { mode: opts.mode, count: opts.count });
    startExercises(app, {
      title: set.title,
      questions: questionsFor(sessionItems(picked, set, { hint: opts.hint }), learnContext(app)),
      restart: run,
      onAnswer: (q, ok) => {
        recordDrill(store.learn.drills, q.id, ok);
        store.save('learn');
      },
    });
  };
  run();
}

// preset: { tag, unit, level } fills the options, for example from a grammar article.
export function openDrillSheet(app, set, preset = {}) {
  const saved = drillOptions();
  const filters = { level: saved.level, unit: 'all', tag: 'all', ...preset };
  let opts = { ...saved };
  const tags = Object.entries(set.tags || {});
  const units = unitNumbers(set.items);
  const available = () => filterDrill(set.items, filters);
  const label = () => {
    const pool = available();
    const n = opts.mode === 'mistakes' ? pool.filter(i => store.learn.drills[i.id]?.ok === false).length : pool.length;
    return n ? `Start · ${plural(Math.min(n, opts.count), 'sentence')}` : opts.mode === 'mistakes' ? 'No mistakes here yet' : 'No sentences match';
  };

  app.sheet({
    title: set.title,
    body: html`
      <p class="sheet-text">${set.subtitle || ''}</p>
      <div class="field-label">Level up to</div>
      ${segmented('level', [{ value: 'all', label: 'All' }, ...LEVELS.map(l => ({ value: l, label: l }))], filters.level)}
      ${units.length ? html`<div class="field-label">Unit</div>
        <select class="input" data-unit aria-label="Unit">
          <option value="all">All units</option>
          ${units.map(u => html`<option value="${u}" ${String(filters.unit) === u ? 'selected' : ''}>Unit ${u}</option>`)}
        </select>` : ''}
      ${tags.length ? html`<div class="field-label">Type</div>
        <select class="input" data-tag aria-label="Type">
          <option value="all">All types</option>
          ${tags.map(([key, title]) => html`<option value="${key}" ${filters.tag === key ? 'selected' : ''}>${title}</option>`)}
        </select>` : ''}
      <div class="field-label">Which sentences</div>
      ${segmented('mode', DRILL_MODES, opts.mode)}
      <div class="field-label">How many</div>
      ${segmented('count', DRILL_COUNTS.map(n => ({ value: String(n), label: String(n) })), String(opts.count))}
      <div class="field-label">Hints</div>
      ${segmented('hint', [{ value: 'off', label: 'Hide' }, { value: 'on', label: 'Show' }], opts.hint ? 'on' : 'off')}
      <button class="btn btn-primary btn-block btn-lg" data-go>${icon('play')}<span></span></button>`,
    onMount(body, close) {
      const go = body.querySelector('[data-go]');
      const refresh = () => {
        const text = label();
        go.querySelector('span').textContent = text;
        go.disabled = text.startsWith('No ');
      };
      refresh();
      onSegmented(body, (name, value) => {
        if (name === 'level') filters.level = value;
        else {
          opts = { ...opts, [name]: name === 'count' ? Number(value) : name === 'hint' ? value === 'on' : value };
        }
        // "My mistakes" is a one-off choice, so it is not remembered for next time.
        store.settings.drill = { ...drillOptions(), ...(name === 'level' ? { level: value } : name === 'mode' && value === 'mistakes' ? {} : { [name]: opts[name] }) };
        store.save('settings');
        refresh();
      });
      body.querySelector('[data-unit]')?.addEventListener('change', e => {
        filters.unit = e.target.value;
        refresh();
      });
      body.querySelector('[data-tag]')?.addEventListener('change', e => {
        filters.tag = e.target.value;
        refresh();
      });
      go.addEventListener('click', () => {
        close();
        startDrill(app, set, filters, opts);
      });
    },
  });
}

function setCard(set) {
  const s = drillStats(set.items, store.learn.drills);
  const meta = [plural(s.total, 'sentence'), s.seen ? `${s.seen} practiced` : 'not started', s.right + s.wrong ? `${pct(s.right, s.right + s.wrong)}% right` : ''].filter(Boolean).join(' · ');
  return html`<button type="button" class="card drill-card" data-set="${set.id}">
    <span class="drill-card-main"><strong>${set.title}</strong><small>${set.subtitle || ''}</small><small class="drill-meta">${meta}</small></span>
    ${icon('chevronRight', 'chevron')}
  </button>`;
}

export function drillsBody(app) {
  const sets = drillSets(app);
  if (!sets.length) return html`<p class="muted">No sentence drills for this language yet.</p>`;
  return html`
    <p class="muted small learn-help">Short sentence exercises, separate from the units. Pick a set, choose a level and a type, and go. "Don't know" shows the answer and brings the sentence back.</p>
    <div class="drill-list">${sets.map(setCard)}</div>`;
}

export function mountDrills(app, root) {
  const sets = drillSets(app);
  root.querySelectorAll('[data-set]').forEach(card => card.addEventListener('click', () => {
    openDrillSheet(app, sets.find(s => s.id === card.dataset.set));
  }));
}

