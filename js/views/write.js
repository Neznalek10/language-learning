import { store, logAnswer } from '../store.js';
import { ACCENTS } from '../data.js';
import { html, icon, plural, segmented, onSegmented, emptyState, esc, raw } from '../ui.js';
import { ruleHref } from '../learn/blocks.js';
import { addMistakes } from '../learn/mistakes.js';
import {
  LENGTHS, lengthOf, filterTopics, kindLabel, pickRandom, PRONOUNS, PRONOUN_GROUPS, requirementsOf,
} from '../learn/writing.js';
import {
  aiSettings, CRITERIA, aiReady, checkWriting, scoreOf, bandOf, wordCount, AiError,
} from '../ai.js';

const MIN_WORDS = 8;
const LEVELS = ['A1', 'A2', 'B1'];
const STRICT = [{ value: 'gentle', label: 'Gentle' }, { value: 'normal', label: 'Normal' }, { value: 'strict', label: 'Strict' }];
const FEEDBACK = [{ value: 'en', label: 'English' }, { value: 'cs', label: 'Czech' }, { value: 'fr', label: 'French' }];
const DEFAULT_WRITE = { length: 'medium', strict: 'normal', feedback: 'en', hints: true, pronouns: [] };

export { aiSettings };
export const writeOptions = () => ({ ...DEFAULT_WRITE, ...store.settings.write });
const entryOf = id => (store.write.topics[id] ??= {});
const scoreText = n => `${n}%`;
const rangeText = length => {
  const { min, max } = lengthOf(length);
  return `Aim for ${min} to ${max} words.`;
};
const mustList = items => html`${items.map(m => html`<li>${icon('check')}${m}</li>`)}`;
const pronounPicker = picked => PRONOUN_GROUPS.map(g => html`
  <p class="muted small w-pron-group">${g.label}</p>
  <div class="chips wrap">${PRONOUNS.filter(p => p.group === g.id).map(p => html`<button type="button" class="chip ${picked.includes(p.id) ? 'active' : ''}" aria-pressed="${String(picked.includes(p.id))}" data-pronoun="${p.id}" lang="fr">${p.label}</button>`)}</div>`);

export function removeCustom(mode, id) {
  const list = customOf(mode);
  list.splice(0, list.length, ...list.filter(t => t.id !== id));
  delete store.write.topics[id];
  store.save('write');
}

export function unitTitle(app, unit) {
  const course = app.courses[app.lang];
  const top = String(unit).split('.')[0];
  const meta = course?.units.find(u => String(u.id) === top);
  return meta ? `Unit ${top} · ${meta.title}` : `Unit ${top}`;
}

export const catalogOf = (app, mode) => (mode === 'speak' ? app.speaking : app.writing)[app.lang];
export const customOf = mode => ((store.write.custom ??= { write: [], speak: [] })[mode] ??= []);
export const allTopics = (app, mode) => [...customOf(mode), ...(catalogOf(app, mode)?.topics || [])];
export const findTopic = (app, mode, id) => allTopics(app, mode).find(t => t.id === id);

const topicMeta = (w, t) => (t.free ? 'Free writing' : [kindLabel(w, t.kind), t.custom ? 'My topic' : t.unit ? `Unit ${t.unit}` : 'Free'].join(' · '));

function topicRow(w, t, { href } = {}) {
  const e = store.write.topics[t.id] || {};
  const side = e.best != null ? html`<span class="w-best">${scoreText(e.best)}</span>` : e.draft?.text ? html`<span class="status-tag is-muted">Draft</span>` : '';
  const inner = html`<span class="tag">${t.level}</span>
    <span class="lesson-main"><strong>${t.title}</strong><small>${topicMeta(w, t)}</small></span>
    <span class="lesson-side">${side}</span>${icon('chevronRight', 'chevron')}`;
  return href
    ? html`<a class="lesson-row w-row" href="${href}">${inner}</a>`
    : html`<button type="button" class="lesson-row w-row" data-topic="${t.id}">${inner}</button>`;
}

// Used on unit pages and grammar articles: the writing or speaking tasks that belong there.
export function topicCard(app, mode, topics, heading) {
  const w = catalogOf(app, mode);
  if (!w || !topics.length) return '';
  return html`<section class="card">
    <header class="card-head"><h2>${heading}</h2><span class="card-meta">${plural(topics.length, mode === 'speak' ? 'speaking task' : 'writing task')}</span></header>
    <div class="lesson-list">${topics.map(t => topicRow(w, t, { href: `#/${mode}?topic=${encodeURIComponent(t.id)}` }))}</div>
  </section>`;
}

export function startWriting(app, topic, opts, text) {
  app.writeSession = { topicId: topic.id, topicName: topic.title, opts: { ...opts, level: opts.level || topic.level }, text, stage: 'edit', result: null, error: '' };
  app.go('writing');
}

export function openSetup(app, topic) {
  const saved = writeOptions();
  const e = store.write.topics[topic.id] || {};
  let opts = { ...saved, level: topic.level };

  app.sheet({
    title: topic.title,
    body: html`
      <p class="sheet-text">${topic.task}</p>
      <div class="field-label">Your text has to include</div>
      <ul class="unit-goals w-must" data-must>${mustList(requirementsOf(topic, opts))}</ul>
      <div class="field-label">Pronouns to practise (optional)</div>
      ${pronounPicker(opts.pronouns)}
      <div class="field-label">Expected level</div>
      ${segmented('level', LEVELS.map(l => ({ value: l, label: l })), opts.level)}
      <div class="field-label">Length</div>
      ${segmented('length', LENGTHS.map(l => ({ value: l.value, label: l.label })), opts.length)}
      <p class="muted small w-range" data-range>${rangeText(opts.length)}</p>
      <div class="field-label">How strict should the check be?</div>
      ${segmented('strict', STRICT, opts.strict)}
      <div class="field-label">Feedback language</div>
      ${segmented('feedback', FEEDBACK, opts.feedback)}
      <div class="field-label">Useful phrases while writing</div>
      ${segmented('hints', [{ value: 'on', label: 'Show' }, { value: 'off', label: 'Hide' }], opts.hints ? 'on' : 'off')}
      <button class="btn btn-primary btn-block btn-lg" data-start>${icon('play')}<span>${e.draft?.text ? 'Continue your draft' : 'Start writing'}</span></button>
      ${e.last ? html`<button class="btn btn-secondary btn-block" data-last>Last result · ${scoreText(e.last.score)}</button>` : ''}
      ${topic.custom ? html`<button class="btn btn-text btn-block" data-delete>${icon('trash')}Delete this topic</button>` : ''}`,
    onMount(body, close) {
      onSegmented(body, (name, value) => {
        opts = { ...opts, [name]: name === 'hints' ? value === 'on' : value };
        if (name === 'length') body.querySelector('[data-range]').textContent = rangeText(value);
        if (name !== 'level') {
          store.settings.write = { ...writeOptions(), [name]: opts[name] };
          store.save('settings');
        }
      });
      body.querySelectorAll('[data-pronoun]').forEach(chip => chip.addEventListener('click', () => {
        const id = chip.dataset.pronoun;
        const on = !opts.pronouns.includes(id);
        opts = { ...opts, pronouns: on ? [...opts.pronouns, id] : opts.pronouns.filter(x => x !== id) };
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', String(on));
        body.querySelector('[data-must]').innerHTML = mustList(requirementsOf(topic, opts)).s;
        store.settings.write = { ...writeOptions(), pronouns: opts.pronouns };
        store.save('settings');
      }));
      body.querySelector('[data-start]').addEventListener('click', () => {
        close();
        startWriting(app, topic, opts, e.draft?.text || '');
      });
      body.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!await app.confirm({ title: 'Delete this topic?', text: topic.title, confirmLabel: 'Delete', danger: true })) return;
        removeCustom('write', topic.id);
        close();
        app.render();
      });
      body.querySelector('[data-last]')?.addEventListener('click', () => {
        close();
        app.writeSession = { topicId: topic.id, opts: e.last.opts, text: e.last.text, stage: 'result', result: e.last.result, error: '' };
        app.go('writing');
      });
    },
  });
}

function notebookRow() {
  const open = (store.write.mistakes || []).filter(m => !m.done).length;
  return html`<a class="card w-notebook" href="#/mistakes">${icon('alert')}<span><strong>My mistakes</strong><small>${open ? `${plural(open, 'mistake')} to review` : 'Mistakes from your checks collect here'}</small></span>${icon('chevronRight', 'chevron')}</a>`;
}

// The topic list shared by the Write and Speak tabs. cfg: { mode, title, open(app, topic), actions: [{ label, icon, run(app) }], banner }.
export function pickerView(app, params, cfg) {
  const { mode } = cfg;
  const w = catalogOf(app, mode);
  if (!w) {
    return { title: cfg.title, body: emptyState({ iconName: mode === 'speak' ? 'speak' : 'write', title: `No ${cfg.noun} topics for this language yet`, text: `${cfg.title} practice exists for French so far.` }) };
  }
  const f = (app.ui[mode] = { level: 'all', unit: 'all', kind: 'all', query: '', ...app.ui[mode] });
  const units = [...new Set(w.topics.filter(t => t.unit).map(t => String(t.unit).split('.')[0]))].sort((a, b) => a - b);
  const kinds = Object.keys(w.kinds || {});
  const ready = aiReady(aiSettings());

  const body = html`
    ${ready ? '' : html`<div class="notice notice-warn">${icon('alert')}<span>${cfg.banner} Add a key in <a href="#/settings">Settings</a>.</span></div>`}
    <div class="quick w-actions">${cfg.actions.map((a, i) => html`<button class="quick-btn" data-action="${i}"><span class="quick-label">${icon(a.icon)}${a.label}</span></button>`)}</div>
    ${cfg.notebook ? notebookRow() : ''}
    <section class="card w-filters">
      <input class="input" type="search" placeholder="Search ${plural(allTopics(app, mode).length, 'topic')}" value="${f.query}" data-query aria-label="Search topics">
      ${segmented('level', [{ value: 'all', label: 'All levels' }, ...LEVELS.map(l => ({ value: l, label: l }))], f.level)}
      <select class="input" data-unit aria-label="Unit">
        <option value="all">All units</option>
        ${units.map(u => html`<option value="${u}" ${f.unit === u ? 'selected' : ''}>${unitTitle(app, u)}</option>`)}
        <option value="free" ${f.unit === 'free' ? 'selected' : ''}>Free and my topics</option>
      </select>
      <div class="chips">
        <button class="chip ${f.kind === 'all' ? 'active' : ''}" data-kind="all">All</button>
        ${kinds.map(k => html`<button class="chip ${f.kind === k ? 'active' : ''}" data-kind="${k}">${kindLabel(w, k)}</button>`)}
      </div>
    </section>
    <div class="w-list-head"><span data-count></span><button class="btn btn-secondary btn-sm" data-random>${icon('refresh')}Surprise me</button></div>
    <div data-list></div>`;

  return {
    title: cfg.title,
    body,
    mount(root) {
      const list = root.querySelector('[data-list]');
      const visible = () => filterTopics({ topics: allTopics(app, mode) }, f);
      const renderList = () => {
        const topics = visible();
        root.querySelector('[data-count]').textContent = plural(topics.length, 'topic');
        if (!topics.length) {
          list.innerHTML = emptyState({ iconName: 'search', title: 'No topics match', text: 'Try another level, unit or search.' }).s;
          return;
        }
        const groups = new Map();
        for (const t of topics) {
          const key = t.custom ? 'mine' : t.unit ? String(t.unit).split('.')[0] : 'free';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(t);
        }
        const heading = key => (key === 'mine' ? 'My topics' : key === 'free' ? 'Free topics' : unitTitle(app, key));
        list.innerHTML = [...groups].map(([key, items]) => html`
          <h3 class="group-title">${heading(key)}<span>${plural(items.length, 'topic')}</span></h3>
          <section class="card topic-list">${items.map(t => topicRow(w, t))}</section>`).map(x => x.s).join('');
      };
      renderList();

      onSegmented(root, (_, value) => {
        f.level = value;
        renderList();
      });
      root.querySelector('[data-query]').addEventListener('input', e => {
        f.query = e.target.value;
        renderList();
      });
      root.querySelector('[data-unit]').addEventListener('change', e => {
        f.unit = e.target.value;
        renderList();
      });
      root.querySelectorAll('[data-kind]').forEach(chip => chip.addEventListener('click', () => {
        f.kind = chip.dataset.kind;
        root.querySelectorAll('[data-kind]').forEach(c => c.classList.toggle('active', c === chip));
        renderList();
      }));
      root.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => cfg.actions[btn.dataset.action].run(app)));
      root.querySelector('[data-random]').addEventListener('click', () => {
        const t = pickRandom(visible());
        if (t) cfg.open(app, t);
      });
      list.addEventListener('click', e => {
        const row = e.target.closest('[data-topic]');
        if (row) cfg.open(app, findTopic(app, mode, row.dataset.topic));
      });

      const wanted = params.topic && findTopic(app, mode, params.topic);
      if (wanted) {
        history.replaceState(null, '', `#/${mode}`);
        cfg.open(app, wanted);
      }
    },
  };
}

// Wraps the first occurrence of every mistake in <mark>, without overlaps.
export function markText(text, errors) {
  const spans = [];
  for (const { wrong } of errors) {
    const at = text.toLowerCase().indexOf(wrong.toLowerCase());
    if (at < 0 || spans.some(s => at < s.end && at + wrong.length > s.start)) continue;
    spans.push({ start: at, end: at + wrong.length });
  }
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const s of spans) {
    out += esc(text.slice(pos, s.start)) + `<mark>${esc(text.slice(s.start, s.end))}</mark>`;
    pos = s.end;
  }
  return raw(out + esc(text.slice(pos)));
}

export function recordAttempt(topicId, session, result, score, now = Date.now()) {
  const e = entryOf(topicId);
  (e.attempts ??= []).push({ at: now, score, words: wordCount(session.text) });
  e.best = Math.max(e.best ?? 0, score);
  e.last = { at: now, text: session.text, opts: session.opts, result, score };
  delete e.draft;
  addMistakes((store.write.mistakes ??= []), result.errors, { source: 'write', topic: session.topic?.title || session.topicName || '', now, bump: !session.fromChat });
}

function saveDraft(topicId, text) {
  const e = entryOf(topicId);
  if (text.trim()) e.draft = { text, at: Date.now() };
  else delete e.draft;
  store.save('write');
}

export async function runCheck(app, session, topic) {
  const g = app.grammar[app.lang];
  const rules = (g?.articles || []).map(a => ({ id: a.id, title: a.title }));
  session.stage = 'checking';
  session.error = '';
  app.render();
  try {
    const result = await checkWriting(aiSettings(), {
      topic, text: session.text, opts: session.opts, range: rangeOf(session.opts.length), rules,
    });
    const score = scoreOf(result.criteria);
    recordAttempt(topic.id, session, result, score);
    store.save('write');
    logAnswer(app.lang, score >= 50);
    session.result = result;
    session.stage = 'result';
  } catch (e) {
    session.stage = 'edit';
    session.error = e instanceof AiError ? e.message : 'Something went wrong while checking. Your text is safe.';
  }
  if (location.hash.startsWith('#/writing') && app.writeSession === session) app.render();
}

const rangeOf = length => {
  const { min, max } = lengthOf(length);
  return { min, max };
};

const accentBar = () => html`<div class="accent-bar">${ACCENTS.fr.split(' ').map(ch => html`<button type="button" tabindex="-1" data-char="${ch}">${ch}</button>`)}</div>`;

function editBody(app, session, topic, w) {
  const range = rangeOf(session.opts.length);
  return html`
    <section class="card unit-head">
      <div class="eyebrow">${topicMeta(w, topic)} · judged at ${session.opts.level}</div>
      <h2 class="topic-title">${topic.title}</h2>
      <p class="muted">${topic.task}</p>
      ${requirementsOf(topic, session.opts).length ? html`<ul class="unit-goals w-must">${mustList(requirementsOf(topic, session.opts))}</ul>` : ''}
      ${session.opts.hints && topic.phrases.length ? html`<div class="g-see w-phrases"><span>Phrases</span>${topic.phrases.map(p => html`<span class="g-link w-phrase" lang="fr">${p}</span>`)}</div>` : ''}
    </section>
    <section class="card">
      ${session.error ? html`<div class="notice notice-bad">${icon('alert')}<span>${session.error}</span></div>` : ''}
      <textarea class="input textarea w-text" lang="fr" rows="10" spellcheck="false" autocapitalize="sentences" autocomplete="off"
        placeholder="Écris ton texte ici..." aria-label="Your French text">${session.text}</textarea>
      ${accentBar()}
      <div class="w-count" data-count></div>
      <button class="btn btn-primary btn-block btn-lg" data-check>${icon('check')}Check my text</button>
    </section>
    <p class="muted small w-hint">Your draft is saved on this device as you type.${topic.free ? '' : ` ${range.min} to ${range.max} words is the target.`}</p>`;
}

// A missed pronoun requirement links straight to its grammar article.
function pronounLink(req, g) {
  const rule = !req.met && PRONOUNS.find(p => p.must === req.item)?.rule;
  const article = rule && g?.byId.get(rule);
  return article ? html`<a class="g-link" href="${ruleHref(article.id)}">${article.title}</a>` : '';
}

function resultBody(app, session, topic, w) {
  const r = session.result;
  const score = scoreOf(r.criteria);
  const band = bandOf(score);
  const met = r.requirements.filter(x => x.met).length;
  const g = app.grammar[app.lang];
  const articles = r.rules.map(id => g?.byId.get(id)).filter(Boolean);
  const best = store.write.topics[topic.id]?.best;

  return html`
    <section class="card w-score tone-${band.tone}">
      <div class="eyebrow">${topic.title} · judged at ${session.opts.level}</div>
      <div class="w-score-main"><span class="w-score-num">${scoreText(score)}</span><span class="w-score-band">${band.label}</span></div>
      ${r.verdict ? html`<p class="w-verdict">${r.verdict}</p>` : ''}
      <div class="w-criteria">${CRITERIA.map(c => html`<div class="w-criterion">
        <span>${c.label}</span><span class="w-bar"><i style="width:${r.criteria[c.key] * 10}%"></i></span><span class="w-crit-num">${r.criteria[c.key]}/10</span>
      </div>`)}</div>
      ${best != null && best > score ? html`<p class="muted small">Your best on this topic: ${scoreText(best)}</p>` : ''}
    </section>

    ${r.requirements.length ? html`<section class="card">
      <header class="card-head"><h2>Requirements</h2><span class="card-meta">${met} of ${r.requirements.length} met</span></header>
      <ul class="w-reqs">${r.requirements.map(x => html`<li class="${x.met ? 'is-met' : 'is-missed'}">${icon(x.met ? 'check' : 'x')}<span>${x.item}${x.note ? html`<small>${x.note}</small>` : ''}${pronounLink(x, g)}</span></li>`)}</ul>
    </section>` : ''}

    <section class="card">
      <header class="card-head"><h2>Your text</h2><span class="card-meta">${plural(wordCount(session.text), 'word')}</span></header>
      <p class="w-original" lang="fr">${markText(session.text, r.errors)}</p>
    </section>

    ${r.errors.length ? html`<section class="card">
      <header class="card-head"><h2>Mistakes</h2><span class="card-meta">${r.errors.length}</span></header>
      <div class="w-items">${r.errors.map(e => html`<div class="w-item">
        <div class="w-change" lang="fr"><s>${e.wrong}</s><span class="w-arrow">${icon('chevronRight')}</span><strong>${e.right}</strong></div>
        <p>${e.why}</p>
        ${e.rule && g?.byId.get(e.rule) ? html`<a class="g-link" href="${ruleHref(e.rule)}">${g.byId.get(e.rule).title}</a>` : ''}
      </div>`)}</div>
    </section>` : html`<div class="notice notice-good">${icon('check')}<span>No clear mistakes found.</span></div>`}

    ${r.better.length ? html`<section class="card">
      <header class="card-head"><h2>Could sound more natural</h2><span class="card-meta">${r.better.length}</span></header>
      <div class="w-items">${r.better.map(b => html`<div class="w-item">
        <div class="w-change" lang="fr"><span>${b.original}</span><span class="w-arrow">${icon('chevronRight')}</span><strong>${b.suggestion}</strong></div>
        <p>${b.why}</p>
      </div>`)}</div>
    </section>` : ''}

    <section class="card">
      <header class="card-head"><h2>Corrected text</h2><button class="btn btn-secondary btn-sm" data-copy>${icon('copy')}Copy</button></header>
      <p class="w-original" lang="fr">${r.corrected}</p>
    </section>

    ${articles.length ? html`<section class="card summary-missed">
      <header class="card-head"><h2>Read up</h2></header>
      <div class="g-see"><span>Rules behind your mistakes</span>${articles.map(a => html`<a class="g-link" href="${ruleHref(a.id)}">${a.title}</a>`)}</div>
    </section>` : ''}

    <div class="summary-actions">
      <button class="btn btn-primary btn-block btn-lg" data-improve>${icon('repeat')}Improve this text</button>
      <a class="btn btn-secondary btn-block btn-lg" href="#/write">${icon('write')}Another topic</a>
    </div>`;
}

export function writingView(app) {
  const session = app.writeSession;
  const w = app.writing[app.lang];
  const topic = session && (session.topic || findTopic(app, 'write', session.topicId));
  if (!topic) return { redirect: 'write' };

  if (session.stage === 'checking') {
    return {
      title: topic.title, tab: 'write', hideLang: true,
      body: html`<div class="empty"><div class="loading" aria-label="Checking"><span></span><span></span><span></span></div>
        <h3>Reading your text</h3><p>This usually takes 10 to 30 seconds.</p></div>`,
    };
  }

  const result = session.stage === 'result';
  return {
    title: result ? 'Result' : topic.title,
    back: 'write',
    tab: 'write',
    hideLang: true,
    body: result ? resultBody(app, session, topic, w) : editBody(app, session, topic, w),
    mount(root) {
      if (result) {
        root.querySelector('[data-improve]').addEventListener('click', () => {
          session.stage = 'edit';
          app.render();
        });
        root.querySelector('[data-copy]').addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(session.result.corrected);
            app.toast('Copied', { kind: 'success' });
          } catch {
            app.toast('Could not copy. Select the text and copy it by hand.', { kind: 'error' });
          }
        });
        return;
      }
      const area = root.querySelector('.w-text');
      const count = root.querySelector('[data-count]');
      const range = rangeOf(session.opts.length);
      const update = () => {
        const n = wordCount(area.value);
        count.textContent = topic.free ? plural(n, 'word') : `${plural(n, 'word')} · aim for ${range.min} to ${range.max}`;
        count.classList.toggle('is-low', !topic.free && n < range.min);
        count.classList.toggle('is-high', !topic.free && n > range.max);
      };
      update();
      area.addEventListener('input', () => {
        session.text = area.value;
        saveDraft(topic.id, area.value);
        update();
      });
      root.querySelector('.accent-bar').addEventListener('click', e => {
        const btn = e.target.closest('[data-char]');
        if (!btn) return;
        const { selectionStart: s0, selectionEnd: s1, value } = area;
        area.value = value.slice(0, s0) + btn.dataset.char + value.slice(s1);
        area.setSelectionRange(s0 + 1, s0 + 1);
        area.focus();
        area.dispatchEvent(new Event('input'));
      });
      root.querySelector('[data-check]').addEventListener('click', () => {
        session.text = area.value;
        if (wordCount(session.text) < MIN_WORDS) {
          app.toast(`Write at least ${MIN_WORDS} words first.`);
          return;
        }
        if (!aiReady(aiSettings())) {
          app.toast('Set up AI checking in Settings first. Your draft is saved.', { kind: 'error' });
          return;
        }
        runCheck(app, session, topic);
      });
    },
  };
}
