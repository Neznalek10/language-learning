import { store } from '../store.js';
import { shuffle } from '../srs.js';
import { conjVerbs, tenseInfo } from '../conj.js';
import { unitLabel } from '../units.js';
import { html, icon, plural, segmented, onSegmented, emptyState } from '../ui.js';
import { renderBlock, ruleHref } from '../learn/blocks.js';
import { LEVELS, levelLabel, withinLevel, searchArticles } from '../learn/grammar.js';
import { topicsOf, questionsFor } from '../learn/course.js';
import { learnContext, startExercises, lessonHref, mountCheck } from './lesson.js';
import { startDrill } from './drill.js';
import { drillSets, findSet, openDrillSheet } from './drills.js';
import { topicCard } from './write.js';
import { topicsForRule } from '../learn/writing.js';

const chapterHref = id => `#/chapter/${encodeURIComponent(id)}`;
const levelTag = text => html`<span class="g-level">${text}</span>`;
const level = () => store.settings.grammarLevel || 'all';
// A path chapter is read in order, so the level filter never hides its steps.
const visibleIn = (chapter, lvl) => (chapter.path ? chapter.articles : chapter.articles.filter(a => withinLevel(a, lvl)));

// The grammar files load in the background after start; a view opened before that waits for them.
function waiting(app, title) {
  return {
    title,
    tab: 'grammar',
    body: html`<div class="loading" aria-label="Loading"><span></span><span></span><span></span></div>`,
    mount: () => app.grammarReady?.then(() => app.render()),
  };
}

function articleRow(a, { chapter } = {}) {
  return html`<a class="deck-row g-row" href="${ruleHref(a.id)}">
    <div class="deck-row-main">
      <div class="deck-row-title">${a.title}</div>
      <div class="deck-row-meta">${[a.fr ? html`<span lang="fr">${a.fr}</span>` : '', chapter ? `${a.fr ? ' · ' : ''}${chapter.title}` : '']}</div>
    </div>
    ${levelTag(levelLabel(a))}${icon('chevronRight', 'chevron')}
  </a>`;
}

function practiceArticles(app, title, articles, { mix = false } = {}) {
  const items = articles.flatMap(a => (a.checks || []).map(c => ({ ...c, lesson: a.id })));
  const run = () => {
    const questions = questionsFor(items, learnContext(app));
    startExercises(app, { title, questions: mix ? shuffle(questions).slice(0, 20) : questions, restart: run });
  };
  run();
}

export function grammarView(app) {
  const g = app.grammar[app.lang];
  if (!g && app.grammarPending) return waiting(app, 'Grammar');
  const hasTables = !!app.conj[app.lang] && conjVerbs(app).length > 0;
  if (!g && !hasTables) {
    return {
      title: 'Grammar',
      body: emptyState({ iconName: 'grammar', title: 'No grammar for this language yet', text: 'The grammar reference exists for French so far.' }),
    };
  }
  const lvl = level();
  const tables = hasTables ? html`<a class="card g-tables" href="#/tenses">
    <span class="g-tables-icon">${icon('tenses')}</span>
    <span class="g-tables-main"><strong>Verb tables & drill</strong><small>Every tense of ${plural(conjVerbs(app).length, 'verb')}, practice by tense or verb</small></span>
    ${icon('chevronRight', 'chevron')}
  </a>` : '';

  const sentences = html`<a class="card g-tables" href="#/learn?view=drills">
    <span class="g-tables-icon">${icon('repeat')}</span>
    <span class="g-tables-main"><strong>Sentence drills</strong><small>Translate, replace with pronouns, make it negative, ask a question</small></span>
    ${icon('chevronRight', 'chevron')}
  </a>`;

  const body = html`
    ${g ? html`
      <label class="search g-search">${icon('search')}<input type="search" placeholder="Search: lui, passé composé, negation…" aria-label="Search grammar" autocomplete="off"></label>
      ${segmented('level', [{ value: 'all', label: 'All' }, ...LEVELS.map(l => ({ value: l, label: l }))], lvl)}
      <section class="card deck-list g-results" hidden></section>` : ''}
    <div class="g-home">
      ${tables}
      ${sentences}
      ${g ? html`<h3 class="group-title">Chapters<span>${plural(g.chapters.reduce((n, ch) => n + visibleIn(ch, lvl).length, 0), 'article')}</span></h3>
        <div class="g-chapters">${g.chapters.map(ch => {
          const n = visibleIn(ch, lvl).length;
          return html`<a class="card g-chapter ${n ? '' : 'is-empty'}" href="${chapterHref(ch.id)}">
            <span class="unit-badge">${ch.number}</span>
            <span class="g-chapter-main"><strong>${ch.title}</strong><small>${ch.subtitle || ''}</small></span>
            <span class="g-count">${n}</span>
          </a>`;
        })}</div>` : ''}
    </div>`;

  return {
    title: 'Grammar',
    body,
    mount(root) {
      onSegmented(root, (_, value) => {
        store.settings.grammarLevel = value;
        store.save('settings');
        app.render();
      });
      const input = root.querySelector('.g-search input');
      if (!input) return;
      const results = root.querySelector('.g-results');
      const home = root.querySelector('.g-home');
      input.addEventListener('input', () => {
        const query = input.value.trim();
        const found = query ? searchArticles(g, query, lvl) : [];
        results.innerHTML = (found.length
          ? html`${found.slice(0, 30).map(a => articleRow(a, { chapter: g.chapters.find(c => c.id === a.chapter) }))}`
          : html`<p class="muted small g-none">Nothing found${lvl !== 'all' ? ` up to ${lvl}` : ''}.</p>`).s;
        results.hidden = !query;
        home.hidden = !!query;
      });
    },
  };
}

export function chapterView(app, { id }) {
  const g = app.grammar[app.lang];
  if (!g && app.grammarPending) return waiting(app, 'Grammar');
  const chapter = g?.chapters.find(c => c.id === id);
  if (!chapter) return { redirect: 'grammar' };
  const lvl = level();
  const shown = visibleIn(chapter, lvl);
  const hidden = chapter.articles.length - shown.length;
  const checks = shown.reduce((n, a) => n + (a.checks?.length || 0), 0);

  const body = html`
    <section class="card unit-head">
      <div class="unit-card-head">
        <span class="unit-badge">${chapter.number}</span>
        <div class="unit-card-main"><h2>${chapter.title}</h2>${chapter.subtitle ? html`<div class="card-meta">${chapter.subtitle}</div>` : ''}</div>
      </div>
      <div class="deck-stats">${LEVELS.map(l => html`<div><strong>${chapter.articles.filter(a => a.level === l).length}</strong><span>${l}</span></div>`)}</div>
      <button class="btn btn-primary btn-block btn-lg" data-mix ${checks ? '' : 'disabled'}>${icon('play')}Practice this chapter</button>
    </section>
    <section class="card deck-list">${shown.map(a => articleRow(a))}</section>
    ${hidden ? html`<p class="muted small learn-help">${plural(hidden, 'article')} above ${lvl} hidden. Change the level on the Grammar page to see them.</p>` : ''}`;

  return {
    title: 'Grammar',
    back: 'grammar',
    tab: 'grammar',
    hideLang: true,
    body,
    mount(root) {
      root.querySelector('[data-mix]').addEventListener('click', () => practiceArticles(app, chapter.title, shown, { mix: true }));
    },
  };
}

function relatedLessons(app, article) {
  if (!article.topics?.length) return [];
  const topics = topicsOf(app, store.learn).filter(t => article.topics.includes(t.id));
  const seen = new Set();
  return topics.flatMap(t => t.lessons).filter(x => !seen.has(x.lesson.id) && seen.add(x.lesson.id));
}

export function ruleView(app, { id }) {
  const g = app.grammar[app.lang];
  if (!g && app.grammarPending) return waiting(app, 'Grammar');
  const article = g?.byId.get(id);
  if (!article) return { redirect: 'grammar' };
  const chapter = g.chapters.find(c => c.id === article.chapter);
  const ctx = learnContext(app, { grammar: g });
  const data = app.conj[app.lang];
  const prev = g.articles[article.index - 1];
  const next = g.articles[article.index + 1];
  const lessons = relatedLessons(app, article);
  const learnItems = topicsOf(app, store.learn).filter(t => article.topics?.includes(t.id) && t.available);
  const tense = article.tense && data && tenseInfo(data, article.tense);
  const seeAlso = (article.see || []).map(x => g.byId.get(x)).filter(Boolean);
  const verbs = (article.verbs || []).filter(v => data?.verbs[v]);
  const checks = article.checks || [];
  const questionCount = questionsFor(checks, ctx).length;
  const drillLinks = (article.drills || []).filter(d => findSet(app, d.set));
  const translateSet = drillSets(app).find(s => s.id === 'translate');
  const translateCount = translateSet ? translateSet.items.filter(i => i.tags?.includes(article.id)).length : 0;

  const body = html`
    <section class="card g-head">
      <div class="eyebrow">${chapter.number}. ${chapter.title}</div>
      <h2 class="topic-title">${article.title}</h2>
      <div class="g-head-meta">${article.fr ? html`<span lang="fr">${article.fr}</span>` : ''}${levelTag(levelLabel(article))}</div>
      ${article.sections.length > 2 ? html`<div class="g-jump">${article.sections.map((s, i) => html`<button type="button" class="chip" data-jump="${i}">${s.title}</button>`)}
        ${checks.length ? html`<button type="button" class="chip" data-jump="practice">Practice</button>` : ''}</div>` : ''}
    </section>

    ${article.sections.map((s, i) => html`<section class="card learn-card g-section" id="g-s-${i}">
      <h2 class="learn-title">${s.title}${s.level ? levelTag(s.level) : ''}</h2>
      ${s.blocks.map(b => renderBlock(b, ctx))}
    </section>`)}

    <section class="card g-practice" id="g-s-practice">
      <header class="card-head"><h2>Try it yourself</h2><span class="card-meta">${plural(questionCount, 'question')}</span></header>
      <div class="g-actions">
        ${checks.length ? html`<button class="btn btn-primary btn-block btn-lg" data-checks>${icon('play')}Practice this rule</button>` : ''}
        ${learnItems.length ? html`<button class="btn btn-secondary btn-block" data-learn>${icon('learn')}More from your Learn lessons</button>` : ''}
        ${drillLinks.map((d, i) => html`<button class="btn btn-secondary btn-block" data-drill="${i}">${icon('repeat')}${d.label}</button>`)}
        ${translateCount ? html`<button class="btn btn-secondary btn-block" data-translate>${icon('units')}Translate sentences with this rule (${translateCount})</button>` : ''}
        ${tense ? html`<button class="btn btn-secondary btn-block" data-tense>${icon('tenses')}Drill the ${tense.label}</button>` : ''}
      </div>
    </section>

    ${seeAlso.length || lessons.length || verbs.length ? html`<section class="card g-related">
      <header class="card-head"><h2>Related</h2></header>
      ${seeAlso.length ? html`<div class="deck-list">${seeAlso.map(a => articleRow(a))}</div>` : ''}
      ${verbs.length ? html`<div class="g-see"><span>Verb tables</span>${verbs.map(v => html`<a class="g-link" href="#/verb/${encodeURIComponent(v)}" lang="fr">${v}</a>`)}</div>` : ''}
      ${lessons.length ? html`<div class="field-label">Taught in Learn</div><div class="lesson-list">${lessons.map(({ unit, lesson, available }) => (available
        ? html`<a class="lesson-row" href="${lessonHref(unit, lesson)}"><span class="lesson-num">${lesson.index + 1}</span>
            <span class="lesson-main"><strong>${lesson.title}</strong><small>${unitLabel(unit.id)} · ${unit.title}</small></span>${icon('chevronRight', 'chevron')}</a>`
        : html`<div class="lesson-row is-locked"><span class="lesson-num">${icon('lock')}</span>
            <span class="lesson-main"><strong>${lesson.title}</strong><small>${unitLabel(unit.id)} · not reached yet</small></span></div>`))}</div>` : ''}
    </section>` : ''}

    ${topicCard(app, 'write', topicsForRule(app.writing[app.lang], article.id), 'Write with this rule')}
    ${topicCard(app, 'speak', topicsForRule(app.speaking[app.lang], article.id), 'Speak with this rule')}

    <nav class="g-pager">
      ${prev ? html`<a class="btn btn-secondary" href="${ruleHref(prev.id)}">${icon('back')}<span>${prev.title}</span></a>` : html`<span></span>`}
      ${next ? html`<a class="btn btn-secondary" href="${ruleHref(next.id)}"><span>${next.title}</span>${icon('chevronRight')}</a>` : html`<span></span>`}
    </nav>`;

  return {
    title: chapter.title,
    back: `chapter/${encodeURIComponent(chapter.id)}`,
    tab: 'grammar',
    hideLang: true,
    body,
    mount(root) {
      root.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => {
        root.querySelector(`#g-s-${b.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));
      const inline = article.sections.flatMap((s, i) => s.blocks.filter(b => b.type === 'check').map((b, n) => ({ b, id: `${article.id}-c${i}-${n}` })));
      root.querySelectorAll('[data-check]').forEach((el, n) => inline[n] && mountCheck(el, inline[n].b, inline[n].id, ctx));
      root.querySelectorAll('[data-drill]').forEach(btn => btn.addEventListener('click', () => {
        const d = drillLinks[btn.dataset.drill];
        openDrillSheet(app, findSet(app, d.set), { tag: d.tag, level: 'all' });
      }));
      root.querySelector('[data-translate]')?.addEventListener('click', () => openDrillSheet(app, translateSet, { tag: article.id, level: 'all' }));
      root.querySelector('[data-checks]')?.addEventListener('click', () => practiceArticles(app, article.title, [article]));
      root.querySelector('[data-learn]')?.addEventListener('click', () => {
        const items = learnItems.flatMap(t => t.items);
        const run = () => startExercises(app, { title: article.title, questions: shuffle(questionsFor(items, learnContext(app))).slice(0, 20), restart: run });
        run();
      });
      root.querySelector('[data-tense]')?.addEventListener('click', () => {
        const all = conjVerbs(app).filter(v => v.data.t[article.tense]);
        const s = store.settings;
        startDrill(app, { verbs: all, tenses: [article.tense], mode: s.conjMode, count: Number(s.conjLength), title: tense.label });
      });
    },
  };
}
