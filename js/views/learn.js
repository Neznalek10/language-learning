import { store } from '../store.js';
import { summarize } from '../srs.js';
import { tenseInfo } from '../conj.js';
import { unitConjVerbs, unitLabel } from '../units.js';
import { html, icon, plural, masteryBar, masteryLegend, wordRow, emptyState, segmented, onSegmented } from '../ui.js';
import {
  learnParts, learnGroups, partStates, groupStatus, nextStep, topicsOf, topicQuestions, levelTest, bestTest, hasTest, PASS,
} from '../learn/course.js';
import { learnContext, startExercises, startTest, unitHref, lessonHref, grammarLinks } from './lesson.js';
import { startDrill } from './drill.js';
import { topicCard } from './write.js';
import { drillsBody, mountDrills } from './drills.js';
import { topicsForParts } from '../learn/writing.js';

const STATUS = {
  passed: { label: 'Passed', cls: 'good' },
  skipped: { label: 'Skipped', cls: 'good' },
  open: { label: 'Open', cls: 'accent' },
  locked: { label: 'Locked', cls: 'muted' },
  soon: { label: 'Vocab only', cls: 'muted' },
};
const KINDS = [
  { key: 'grammar', label: 'Grammar' },
  { key: 'communication', label: 'Communication' },
  { key: 'vocabulary', label: 'Vocabulary' },
];

const partWords = part => [...part.words, ...part.verbs];
const groupWords = group => group.parts.flatMap(partWords);
const done = lesson => !!store.learn.lessons[lesson.id]?.practiced;
const pctOf = n => `${Math.round(n * 100)}%`;
const badge = (id, status) => html`<span class="unit-badge ${status === 'passed' || status === 'skipped' ? 'is-passed' : ''}">${status === 'passed' ? icon('check') : /^\d+$/.test(id) ? id : id.charAt(0).toUpperCase()}</span>`;
const statusTag = status => html`<span class="status-tag is-${STATUS[status].cls}">${status === 'locked' ? icon('lock') : ''}${STATUS[status].label}</span>`;

function courseState(app) {
  const parts = learnParts(app);
  return { parts, states: partStates(parts, store.learn) };
}

function groupCard(group, status) {
  const s = summarize(groupWords(group), store.progress);
  const lessons = group.parts.flatMap(p => p.lessons);
  const meta = [
    group.parts.length > 1 ? group.parts.map(p => p.id).join(' + ') : '',
    lessons.length ? `${lessons.filter(done).length}/${plural(lessons.length, 'lesson')}` : '',
    s.total ? plural(s.total, 'word') : '',
  ].filter(Boolean).join(' · ');
  return html`<a class="card unit-card is-${status}" href="${unitHref(group.id)}">
    <div class="unit-card-head">
      ${badge(group.id, status)}
      <div class="unit-card-main"><h2>${group.title || unitLabel(group.id)}</h2>${group.subtitle ? html`<div class="card-meta">${group.subtitle}</div>` : ''}</div>
      ${statusTag(status)}
    </div>
    <div class="unit-card-meta">${meta || 'Empty'}</div>
    ${s.total ? masteryBar(s.levels, { thin: true }) : ''}
  </a>`;
}

function levelCard(test) {
  const attempts = store.learn.tests[test.id] || [];
  const passed = !!store.learn.passed[test.id];
  const pass = Math.round((test.test.pass ?? PASS) * 100);
  return html`<section class="card test-card level-test ${passed ? 'is-passed' : ''}">
    <header class="card-head"><h2>${test.title}</h2><span class="card-meta">${pass}% to pass</span></header>
    <p class="muted small">${test.subtitle || `Covers every ${test.level} unit. Pass it to skip ${test.level}: every lesson opens and the next level starts.`}</p>
    ${attempts.length ? html`<div class="deck-stats">
      <div><strong>${pctOf(bestTest(store.learn, test.id))}</strong><span>best</span></div>
      <div><strong>${attempts.length}</strong><span>${attempts.length === 1 ? 'attempt' : 'attempts'}</span></div>
      <div><strong>${passed ? 'Yes' : 'No'}</strong><span>passed</span></div>
    </div>` : ''}
    <button class="btn ${passed ? 'btn-secondary' : 'btn-primary'} btn-block btn-lg" data-level="${test.id}">${icon('trophy')}${attempts.length ? 'Retake' : 'Take'} the ${test.level} test</button>
  </section>`;
}

function continueHero(step) {
  if (!step) return '';
  const { part, lesson } = step;
  return html`<section class="hero learn-hero">
    <div class="hero-eyebrow">${unitLabel(part.id)} · ${part.title}</div>
    <div class="hero-label">${lesson ? `Lesson ${lesson.index + 1}: ${lesson.title}` : `Test ${part.id}`}</div>
    <div class="hero-sub">${lesson ? 'Learn it, then practice it' : `You need ${Math.round((part.test.pass ?? PASS) * 100)}% to pass`}</div>
    ${lesson
      ? html`<a class="btn btn-on-accent" href="${lessonHref(part, lesson)}">${icon('play')}Continue</a>`
      : html`<button class="btn btn-on-accent" data-test="${part.id}">${icon('trophy')}Take the test</button>`}
  </section>`;
}

function pathBody(app, parts, states) {
  const groups = learnGroups(app, app.lang, parts);
  const levels = [...new Set(groups.map(g => g.level || ''))];
  return html`
    ${continueHero(nextStep(parts, states, store.learn))}
    ${levels.map(level => {
      const list = groups.filter(g => (g.level || '') === level);
      const test = level && levelTest(app, level, app.lang, parts);
      return html`<h3 class="group-title">${level || 'Other units'}<span>${plural(list.length, 'unit')}</span></h3>
        <div class="unit-list">${list.map(g => groupCard(g, groupStatus(g, states)))}</div>
        ${test ? levelCard(test) : ''}`;
    })}`;
}

function topicsBody(topics) {
  if (!topics.length) return emptyState({ iconName: 'units', title: 'No topics yet', text: 'Topics appear as lessons get written.' });
  return html`
    <p class="muted small learn-help">Pick any topics you've reached and practice just those, mixed. Locked topics open as you go through the lessons.</p>
    ${KINDS.map(kind => {
      const list = topics.filter(t => (t.kind || 'grammar') === kind.key);
      return list.length ? html`<h3 class="group-title">${kind.label}</h3>
        <section class="card topic-list">${list.map(t => {
          const first = t.lessons[0];
          const where = [...new Set(t.lessons.filter(x => x.available).map(x => x.unit.id))].map(id => `Unit ${id}`).join(', ');
          return html`<div class="topic-row ${t.available ? '' : 'is-locked'}">
            <label class="check-row"><input type="checkbox" data-topic="${t.id}" ${t.available ? '' : 'disabled'}>
              <span><strong>${t.title}</strong><small>${t.available
                ? `${where} · ${plural(t.items.length + t.words.length, 'question')}`
                : `Opens with unit ${first.unit.id}, lesson ${first.lesson.index + 1}`}</small></span>
            </label>
            ${t.available ? html`<a class="icon-btn" href="#/topic/${encodeURIComponent(t.id)}" aria-label="Open ${t.title}">${icon('chevronRight')}</a>` : html`<span class="icon-btn" aria-hidden="true">${icon('lock')}</span>`}
          </div>`;
        })}</section>` : '';
    })}
    <div class="sticky-cta"><button class="btn btn-primary btn-block btn-lg" data-mix disabled>${icon('play')}<span>Pick topics to practice</span></button></div>`;
}

export function learnView(app, { view = 'path' }) {
  const { parts, states } = courseState(app);
  if (!parts.length) {
    return {
      title: 'Learn',
      body: emptyState({
        iconName: 'learn',
        title: 'No course for this language yet',
        text: 'Lessons exist for French so far. Words with a "unit" value still show up here as units you can practice.',
      }),
    };
  }
  const topics = topicsOf(app, store.learn);
  const tab = view === 'drills' ? 'drills' : topics.length && view === 'topics' ? 'topics' : 'path';

  return {
    title: 'Learn',
    body: html`
      ${segmented('view', [{ value: 'path', label: 'Path' }, ...(topics.length ? [{ value: 'topics', label: 'Topics' }] : []), { value: 'drills', label: 'Drills' }], tab)}
      ${tab === 'drills' ? drillsBody(app) : tab === 'topics' ? topicsBody(topics) : pathBody(app, parts, states)}`,
    mount(root) {
      onSegmented(root, (_, value) => app.go(value === 'path' ? 'learn' : `learn?view=${value}`, { replace: true }));
      if (tab === 'drills') mountDrills(app, root);
      root.querySelector('[data-test]')?.addEventListener('click', e => startTest(app, parts.find(p => p.id === e.currentTarget.dataset.test)));
      root.querySelectorAll('[data-level]').forEach(btn => btn.addEventListener('click', () => startTest(app, levelTest(app, btn.dataset.level))));
      const mix = root.querySelector('[data-mix]');
      if (!mix) return;
      const picked = () => topics.filter(t => root.querySelector(`[data-topic="${CSS.escape(t.id)}"]`)?.checked);
      root.addEventListener('change', () => {
        const n = picked().length;
        mix.disabled = !n;
        mix.querySelector('span').textContent = n ? `Practice ${plural(n, 'topic')}` : 'Pick topics to practice';
      });
      mix.addEventListener('click', () => {
        const chosen = picked();
        const run = () => startExercises(app, {
          title: chosen.map(t => t.title).join(' + '), questions: topicQuestions(chosen, learnContext(app)), restart: run,
        });
        run();
      });
    },
  };
}

function partSection(app, part, st, { heading }) {
  const vocab = partWords(part);
  const vocabSum = summarize(vocab, store.progress);
  const attempts = store.learn.tests[part.id] || [];
  const pass = Math.round((part.test?.pass ?? PASS) * 100);
  const data = app.conj[app.lang];

  const lessonRow = (lesson, i) => {
    const mark = store.learn.lessons[lesson.id] || {};
    const open = st.lessons[i];
    const inner = html`
      <span class="lesson-num ${mark.practiced ? 'is-done' : ''}">${mark.practiced ? icon('check') : open ? i + 1 : icon('lock')}</span>
      <span class="lesson-main"><strong>${lesson.title}</strong><small>${open ? lesson.subtitle || '' : 'Finish the previous lesson first'}</small></span>
      <span class="lesson-side">${mark.practiced ? pctOf(mark.best) : mark.learned ? 'Learned' : ''}</span>`;
    return open
      ? html`<a class="lesson-row" href="${lessonHref(part, lesson)}">${inner}${icon('chevronRight', 'chevron')}</a>`
      : html`<div class="lesson-row is-locked">${inner}</div>`;
  };

  return html`
    ${heading ? html`<h3 class="group-title part-title">${part.id} · ${part.title}<span>${statusTag(st.status)}</span></h3>` : ''}
    ${part.lessons.length ? html`<section class="card">
      <header class="card-head"><h2>Lessons</h2><span class="card-meta">${part.lessons.filter(done).length} of ${part.lessons.length} practiced</span></header>
      ${part.goals?.length ? html`<ul class="unit-goals">${part.goals.map(g => html`<li>${icon('check')}${g}</li>`)}</ul>` : ''}
      <div class="lesson-list">${part.lessons.map(lessonRow)}</div>
    </section>` : ''}

    ${hasTest(part) ? html`<section class="card test-card ${st.status === 'passed' ? 'is-passed' : ''}">
      <header class="card-head"><h2>Test ${part.id}</h2><span class="card-meta">${pass}% to pass</span></header>
      <p class="muted small">${st.test ? `${part.test.count || 20} questions you haven't seen in practice. No hints until the end.` : 'Opens when every lesson above is practiced.'}</p>
      ${attempts.length ? html`<div class="deck-stats">
        <div><strong>${pctOf(bestTest(store.learn, part.id))}</strong><span>best</span></div>
        <div><strong>${attempts.length}</strong><span>${attempts.length === 1 ? 'attempt' : 'attempts'}</span></div>
        <div><strong>${st.status === 'passed' ? 'Yes' : 'No'}</strong><span>passed</span></div>
      </div>` : ''}
      <button class="btn ${st.status === 'passed' ? 'btn-secondary' : 'btn-primary'} btn-block btn-lg" data-test="${part.id}" ${st.test ? '' : 'disabled'}>${icon(st.test ? 'trophy' : 'lock')}${attempts.length ? 'Retake the test' : 'Take the test'}</button>
    </section>` : ''}

    ${vocab.length || part.tenses.length ? html`<section class="card">
      <header class="card-head"><h2>Practice</h2><span class="card-meta">${plural(vocab.length, 'word')}</span></header>
      ${vocab.length ? html`${masteryBar(vocabSum.levels)}${masteryLegend(vocabSum.levels)}` : ''}
      <div class="deck-actions">
        ${vocab.length ? html`<button class="btn btn-secondary" data-vocab="${part.id}">${icon('words')}Vocabulary</button>` : ''}
        ${part.tenses.length ? html`<button class="btn btn-secondary" data-tenses="${part.id}">${icon('tenses')}${part.tenses.map(t => tenseInfo(data, t)?.label).filter(Boolean).join(', ')}</button>` : ''}
      </div>
      ${vocab.length ? html`<details class="word-details"><summary>All words${icon('chevronDown')}</summary>
        <div class="word-list">${vocab.map(w => wordRow(w, store.progress[w.id], { showDeck: true }))}</div>
      </details>` : ''}
    </section>` : ''}`;
}

export function unitView(app, { id }) {
  const { parts, states } = courseState(app);
  const group = learnGroups(app, app.lang, parts).find(g => g.id === id);
  if (!group) return { redirect: 'learn' };
  const status = groupStatus(group, states);
  const multi = group.parts.length > 1;
  const ids = group.parts.map(p => p.id);
  const blocker = status === 'locked' ? parts.find(p => states.get(p.id).status === 'open') : null;

  const body = html`
    <section class="card unit-head">
      <div class="unit-card-head">
        ${badge(group.id, status)}
        <div class="unit-card-main"><h2>${group.title || unitLabel(group.id)}</h2>${group.subtitle ? html`<div class="card-meta">${group.subtitle}</div>` : ''}</div>
        ${statusTag(status)}
      </div>
      ${multi ? html`<div class="unit-parts">${group.parts.map(p => html`<span><strong>${p.id}</strong> ${p.title}</span>`)}</div>` : ''}
      ${blocker ? html`<div class="notice notice-warn">${icon('lock')}<span>Finish ${unitLabel(blocker.id)} first. To skip ahead, pass the ${group.level} final test at the end of the path.</span></div>` : ''}
      ${status === 'soon' ? html`<p class="muted small">Lessons for this unit aren't written yet. Its vocabulary is ready to practice.</p>` : ''}
    </section>
    ${group.parts.map(p => partSection(app, p, states.get(p.id), { heading: multi }))}
    ${topicCard(app, 'write', topicsForParts(app.writing[app.lang], ids), 'Write about it')}
    ${topicCard(app, 'speak', topicsForParts(app.speaking[app.lang], ids), 'Speak about it')}`;

  return {
    title: unitLabel(group.id),
    back: 'learn',
    tab: 'learn',
    hideLang: true,
    body,
    mount(root) {
      const part = pid => parts.find(p => p.id === pid);
      root.querySelectorAll('[data-test]').forEach(b => b.addEventListener('click', () => startTest(app, part(b.dataset.test))));
      root.querySelectorAll('[data-vocab]').forEach(b => b.addEventListener('click', () => {
        const p = part(b.dataset.vocab);
        app.startSession({ pool: partWords(p), mode: 'smart', count: store.settings.sessionLength, title: `${p.id} ${p.title}` });
      }));
      root.querySelectorAll('[data-tenses]').forEach(b => b.addEventListener('click', () => {
        const p = part(b.dataset.tenses);
        startDrill(app, {
          verbs: unitConjVerbs(app, p), tenses: p.tenses, mode: store.settings.conjMode, count: Number(store.settings.conjLength), title: `${p.id} ${p.title}`,
        });
      }));
    },
  };
}

export function topicView(app, { id }) {
  const topic = topicsOf(app, store.learn).find(t => t.id === id);
  if (!topic || !topic.available) return { redirect: 'learn?view=topics' };
  const kind = KINDS.find(k => k.key === (topic.kind || 'grammar'));
  const open = topic.lessons.filter(x => x.available);

  const body = html`
    <section class="card unit-head">
      <div class="eyebrow">${kind.label}</div>
      <h2 class="topic-title">${topic.title}</h2>
      ${(topic.cs ?? topic.en) ? html`<p class="muted">${topic.cs ?? topic.en}</p>` : ''}
      <div class="deck-stats">
        <div><strong>${topic.items.length}</strong><span>exercises</span></div>
        <div><strong>${topic.words.length}</strong><span>words</span></div>
        <div><strong>${open.length}</strong><span>${open.length === 1 ? 'lesson' : 'lessons'}</span></div>
      </div>
      <button class="btn btn-primary btn-block btn-lg" data-practice>${icon('play')}Practice this topic</button>
      ${grammarLinks(app, [topic.id])}
    </section>
    <section class="card">
      <header class="card-head"><h2>Taught in</h2></header>
      <div class="lesson-list">${topic.lessons.map(({ unit, lesson, available }) => (available
        ? html`<a class="lesson-row" href="${lessonHref(unit, lesson)}">
            <span class="lesson-num">${lesson.index + 1}</span>
            <span class="lesson-main"><strong>${lesson.title}</strong><small>${unitLabel(unit.id)} · ${unit.title}</small></span>
            ${icon('chevronRight', 'chevron')}
          </a>`
        : html`<div class="lesson-row is-locked">
            <span class="lesson-num">${icon('lock')}</span>
            <span class="lesson-main"><strong>${lesson.title}</strong><small>${unitLabel(unit.id)} · not reached yet</small></span>
          </div>`))}</div>
    </section>`;

  return {
    title: topic.title,
    back: 'learn?view=topics',
    tab: 'learn',
    hideLang: true,
    body,
    mount(root) {
      root.querySelector('[data-practice]').addEventListener('click', () => {
        const run = () => startExercises(app, { title: topic.title, questions: topicQuestions([topic], learnContext(app)), restart: run });
        run();
      });
    },
  };
}
