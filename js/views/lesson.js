import { store, logAnswer } from '../store.js';
import { record } from '../srs.js';
import { langName, ACCENTS } from '../data.js';
import { html, icon, plural, pct } from '../ui.js';
import { buildIndex, explainWord, whyBlock } from '../explain.js';
import { markedWords } from '../learn/answers.js';
import { renderCard, ruleHref } from '../learn/blocks.js';
import { articlesForTopics } from '../learn/grammar.js';
import { GAP } from '../learn/exercises/cloze.js';
import { toQuestions } from '../learn/exercises/index.js';
import { askAnswer } from '../learn/askai.js';
import { aiReady, aiSettings, AiError } from '../ai.js';
import { learnParts, partStates, nextStep, lessonQuestions, testQuestions, grade, saveTest, saveLesson, wordRef } from '../learn/course.js';

export function learnContext(app, extra = {}) {
  const lang = app.lang;
  const words = app.wordsOf(app.decksFor(lang));
  const byId = new Map(words.map(w => [w.id, w]));
  let index;
  return {
    lang,
    conj: app.conj[lang],
    settings: store.settings,
    rand: Math.random,
    langName,
    word: ref => byId.get(wordRef(lang, ref)),
    acceptedFor: id => store.learn.accepted[id] || [],
    explainWord: args => explainWord({
      ...args, reverse: false, index: (index ??= buildIndex(words)), strict: store.settings.strictAccents, conj: app.conj[lang],
    }),
    ...extra,
  };
}

export const unitHref = id => `#/unit/${encodeURIComponent(id)}`;
export const lessonHref = (part, lesson) => `#/lesson/${encodeURIComponent(part.id)}/${encodeURIComponent(lesson.id)}`;

export function findLesson(app, partId, lessonId) {
  const parts = learnParts(app);
  const part = parts.find(p => p.id === partId);
  const lesson = part?.lessons.find(l => l.id === lessonId);
  return { parts, part, lesson, states: partStates(parts, store.learn) };
}

// Links to the Grammar articles behind these Learn topics.
export function grammarLinks(app, topics, label = 'In Grammar') {
  const articles = articlesForTopics(app.grammar[app.lang], topics);
  if (!articles.length) return '';
  return html`<div class="g-see"><span>${label}</span>${articles.map(a => html`<a class="g-link" href="${ruleHref(a.id)}">${a.title}</a>`)}</div>`;
}

// Topics behind the wrong answers. A unit test's items name a lesson, a level test's items name a part.
function missedTopics(app, missed) {
  const parts = learnParts(app);
  const topics = new Map([
    ...parts.flatMap(p => p.lessons).map(l => [l.id, l.topics || []]),
    ...parts.map(p => [p.id, p.lessons.flatMap(l => l.topics || [])]),
  ]);
  return [...new Set(missed.flatMap(r => topics.get(r.question.lesson) || []))];
}

// mode "practice" gives feedback after every answer and brings wrong ones back once; "test" stays silent until the end.
export function startExercises(app, { mode = 'practice', title, questions, unitId, lessonId, restart, onAnswer }) {
  if (!questions.length) {
    app.toast('Nothing to practice here yet.');
    return;
  }
  app.learnSession = {
    mode, title, unitId, lessonId, restart, onAnswer,
    queue: questions.slice(),
    index: 0,
    results: [],
    returnTo: location.hash.startsWith('#/exercise') ? app.learnSession?.returnTo : location.hash,
  };
  app.go('exercise');
}

export function startLessonPractice(app, part, lesson) {
  const run = () => startExercises(app, {
    title: lesson.title, unitId: part.id, lessonId: lesson.id,
    questions: lessonQuestions(lesson, learnContext(app)), restart: run,
  });
  run();
}

// unit is a part (1.1, 3...) or a level's final test; it travels with the session so results know what was tested.
export function startTest(app, unit) {
  const run = () => {
    startExercises(app, {
      mode: 'test', title: unit.isLevel ? unit.title : `${unit.title} · Test`, unitId: unit.id,
      questions: testQuestions(unit, learnContext(app)), restart: run,
    });
    if (app.learnSession) app.learnSession.unit = unit;
  };
  run();
}

function promptMarkup(q, filled) {
  if (q.segments) return html`${q.segments.map(p => (p.mark ? html`<u class="mark-np">${p.t}</u>` : p.t))}`;
  if (!q.gap) return html`${q.prompt}`;
  const [before, after] = q.prompt.split(GAP);
  return html`${before}<span class="gap ${filled ? 'filled' : ''}">${filled || '  '}</span>${after}`;
}

function accentBar(lang) {
  const accents = ACCENTS[lang];
  return accents ? html`${accents.split(' ').map(ch => html`<button type="button" tabindex="-1" data-char="${ch}">${ch}</button>`)}` : html``;
}

function insertChar(input, ch) {
  const { selectionStart: s0, selectionEnd: s1, value } = input;
  input.value = value.slice(0, s0) + ch + value.slice(s1);
  input.setSelectionRange(s0 + ch.length, s0 + ch.length);
  input.focus();
}

const FEEDBACK = {
  exact: { tone: 'good', icon: 'check', title: 'Correct' },
  accentOk: { tone: 'warn', icon: 'info', title: 'Correct, but watch the accents' },
  accent: { tone: 'warn', icon: 'alert', title: 'Almost: the accents are wrong' },
  typo: { tone: 'warn', icon: 'alert', title: 'Almost: check the spelling' },
  wrong: { tone: 'bad', icon: 'x', title: 'Not quite' },
  skipped: { tone: 'bad', icon: 'info', title: 'Here is the answer' },
  override: { tone: 'good', icon: 'check', title: 'Marked as correct' },
};

const feedbackKey = (result, skipped) => (skipped ? 'skipped' : result.kind === 'accent' ? (result.ok ? 'accentOk' : 'accent') : result.kind);

// What to show as the right answer: the full sentence for gaps and forms, with the words you missed marked.
function answerMarkup(q, result, given, key) {
  const expected = result.expected;
  if (q.full) return html`${q.full(expected)}`;
  if (key !== 'exact' && key !== 'override' && given && q.sentence) return markedWords(given, expected);
  return html`${q.shownAnswer || expected}`;
}

function reasonsFor(q, result, given, key) {
  const why = key === 'exact' || key === 'override' || !given || !q.explain ? null : q.explain(result, given);
  const reasons = [q.why, ...(why?.reasons || [])].filter(Boolean);
  return { why, block: key === 'exact' ? '' : whyBlock({ reasons, rule: why?.rule, facts: why?.facts }) };
}

export function feedbackMarkup(q, result, given, key) {
  const { why, block } = reasonsFor(q, result, given, key);
  const f = FEEDBACK[key === 'typo' && why?.category && why.category !== 'typo' ? 'wrong' : key];
  const others = q.answers.filter(a => a !== result.expected).slice(0, 3);
  const marked = why?.marked && !q.full && !q.sentence ? why.marked : answerMarkup(q, result, given, key);
  return {
    tone: f.tone,
    markup: html`
      <div class="feedback-head">${icon(f.icon)}<strong>${f.title}</strong></div>
      ${key !== 'exact' || q.full ? html`<div class="feedback-answer ${q.sentence || q.full ? 'is-sentence' : ''}" lang="${q.answerLang}">${marked}</div>` : ''}
      ${given && key !== 'exact' && key !== 'override' ? html`<div class="feedback-given">You wrote: <s>${given}</s></div>` : ''}
      ${others.length && key !== 'exact' ? html`<div class="feedback-also">Also accepted: ${others.join(' · ')}</div>` : ''}
      ${block}`,
  };
}

function practiceSummary(app, session) {
  const first = session.results.filter(r => !r.question.again);
  const correct = first.filter(r => r.ok).length;
  const score = pct(correct, first.length);
  const missed = first.filter(r => !r.ok);
  const { part, lesson } = session.lessonId ? findLesson(app, session.unitId, session.lessonId) : {};
  const next = lesson && part.lessons[lesson.index + 1];
  const headline = score === 100 ? 'Perfect' : score >= 80 ? 'Great work' : score >= 50 ? 'Good progress' : 'Keep at it';
  return html`<div class="summary">
    <div class="summary-ring" style="--p:${score}"><span>${score}%</span></div>
    <h2>${headline}</h2>
    <p class="summary-sub">${correct} of ${plural(first.length, 'question')} right the first time</p>
    ${missed.length ? html`<section class="card summary-missed">
      <header class="card-head"><h2>Review these</h2></header>
      <div class="word-list">${missed.map(r => html`<div class="word-row"><div class="word-main">
        <div class="word-q">${r.question.prompt}</div>
        <div class="word-a" lang="${r.question.answerLang}">${r.question.full ? r.question.full(r.result.expected) : r.question.shownAnswer || r.result.expected}</div>
      </div>${r.given ? html`<div class="word-side"><span class="given">${r.given}</span></div>` : ''}</div>`)}</div>
    </section>` : ''}
    <div class="summary-actions">
      ${next ? html`<a class="btn btn-primary btn-block btn-lg" href="${lessonHref(part, next)}">${icon('chevronRight')}Next lesson: ${next.title}</a>` : ''}
      ${lesson && !next && part.test ? html`<button class="btn btn-primary btn-block btn-lg" data-test>${icon('trophy')}Take the test for ${part.id}</button>` : ''}
      <button class="btn btn-secondary btn-block btn-lg" data-again>${icon('repeat')}Practice again</button>
      <button class="btn btn-text btn-block" data-done>Done</button>
    </div>
  </div>`;
}

function testSummary(app, session, result) {
  const unit = session.unit;
  const { parts, states } = findLesson(app);
  const score = Math.round(result.score * 100);
  const after = result.passed ? nextStep(parts, states, store.learn)?.part : null;
  const missed = session.results.filter(r => !r.ok);
  const partTitle = key => (key === 'words' ? 'Vocabulary' : unit.labels?.[key] || unit.lessons.find(l => l.id === key)?.title || key);
  const order = key => (key === 'words' ? -1 : unit.order ? unit.order.indexOf(key) : unit.lessons.findIndex(l => l.id === key));
  const scores = result.parts.slice().sort((a, b) => order(a.key) - order(b.key));
  return html`<div class="summary">
    <div class="summary-ring ${result.passed ? 'is-pass' : 'is-fail'}" style="--p:${score}"><span>${score}%</span></div>
    <h2>${result.passed ? (unit.isLevel ? `${unit.level} passed` : `${unit.id} passed`) : 'Not passed yet'}</h2>
    ${result.passed && unit.isLevel ? html`<p class="summary-sub">Every ${unit.level} lesson is now open.</p>` : ''}
    <p class="summary-sub">${result.correct} of ${plural(result.total, 'question')} correct · ${Math.round(result.pass * 100)}% needed</p>
    <section class="card summary-missed">
      <header class="card-head"><h2>${unit.isLevel ? 'By unit' : 'By lesson'}</h2></header>
      <div class="tense-list">${scores.map(p => html`<div class="tense-row">
        <span class="tense-row-main"><span class="tense-row-title">${partTitle(p.key)}</span>
          <div class="mastery-bar thin"><span class="seg lvl-mastered" style="flex-grow:${p.correct}"></span><span class="seg lvl-new" style="flex-grow:${p.total - p.correct}"></span></div></span>
        <span class="tense-row-value">${p.correct}/${p.total}</span>
      </div>`)}</div>
    </section>
    ${missed.length && grammarLinks(app, missedTopics(app, missed)) ? html`<section class="card summary-missed">
      <header class="card-head"><h2>Read up</h2></header>
      ${grammarLinks(app, missedTopics(app, missed), 'Rules behind your mistakes')}
    </section>` : ''}
    ${missed.length ? html`<section class="card summary-missed">
      <header class="card-head"><h2>Mistakes</h2><span class="card-meta">${missed.length}</span></header>
      <div class="test-review">${missed.map(r => {
        const key = r.given ? feedbackKey(r.result, false) : 'skipped';
        const fb = feedbackMarkup(r.question, r.result, r.given, key);
        return html`<div class="test-mistake">
          <div class="test-mistake-label">${r.question.label}</div>
          <div class="test-mistake-prompt" lang="${r.question.promptLang}">${promptMarkup(r.question)}</div>
          <div class="feedback tone-${fb.tone}">${fb.markup}</div>
        </div>`;
      })}</div>
    </section>` : ''}
    <div class="summary-actions">
      ${after ? html`<a class="btn btn-primary btn-block btn-lg" href="${unitHref(after.unitId)}">${icon('chevronRight')}Continue: ${after.id} ${after.title}</a>` : ''}
      ${!result.passed ? html`<button class="btn btn-primary btn-block btn-lg" data-again>${icon('repeat')}Retake the test</button>` : ''}
      ${!result.passed && unit.lessons[0] ? html`<a class="btn btn-secondary btn-block btn-lg" href="${lessonHref(unit, unit.lessons[0])}">${icon('units')}Redo ${unit.id} from lesson 1</a>` : ''}
      <button class="btn btn-text btn-block" data-done>${unit.isLevel ? 'Back to the path' : 'Back to the unit'}</button>
    </div>
  </div>`;
}

export function exerciseView(app) {
  const session = app.learnSession;
  if (!session) return { redirect: 'learn' };
  const isTest = session.mode === 'test';

  const body = html`<div class="practice">
    <header class="practice-top">
      <button class="icon-btn" data-quit aria-label="End">${icon('x')}</button>
      <div class="progress" role="progressbar"><div class="progress-fill"></div></div>
      <div class="practice-count"></div>
    </header>
    <div class="practice-stage">
      <div class="q-card">
        <div class="q-meta"><span class="q-direction"></span><span class="q-deck">${session.title}</span></div>
        <div class="q-prompt"></div>
        <div class="q-sub" hidden></div>
      </div>
      <div class="answer"></div>
      <div class="feedback" hidden aria-live="polite"></div>
    </div>
    <footer class="practice-actions"></footer>
  </div>`;

  return {
    focus: true,
    tab: 'learn',
    body,
    mount(root) {
      const $ = sel => root.querySelector(sel);
      let state = 'ask';
      let input = null;
      let chosen = [];

      const quit = () => {
        app.learnSession = null;
        location.hash = session.returnTo || '#/learn';
      };

      const finish = () => {
        state = 'done';
        let markup;
        if (isTest) {
          const result = grade(session.results, session.unit);
          saveTest(store.learn, session.unit, result);
          store.save('learn');
          markup = testSummary(app, session, result);
        } else {
          if (session.lessonId) {
            const first = session.results.filter(r => !r.question.again);
            saveLesson(store.learn, session.lessonId, { score: first.length ? first.filter(r => r.ok).length / first.length : 0 });
            store.save('learn');
          }
          markup = practiceSummary(app, session);
        }
        root.innerHTML = markup.s;
        root.querySelector('[data-again]')?.addEventListener('click', () => session.restart());
        root.querySelector('[data-test]')?.addEventListener('click', () => startTest(app, findLesson(app, session.unitId).part));
        root.querySelector('[data-done]').addEventListener('click', quit);
        window.scrollTo(0, 0);
      };

      const setActions = markup => {
        $('.practice-actions').innerHTML = markup.s;
      };

      const answerValue = q => (q.input === 'tiles' ? chosen.map(i => q.tiles[i]).join(' ') : input.value);

      const renderTiles = q => {
        $('.answer').innerHTML = html`
          <div class="tile-answer ${chosen.length ? '' : 'is-empty'}">${chosen.length
            ? chosen.map((t, n) => html`<button type="button" class="word-tile" data-unpick="${n}" lang="fr">${q.tiles[t]}</button>`)
            : html`<span>Tap the words in the right order</span>`}</div>
          <div class="tile-bank">${q.tiles.map((t, i) => html`<button type="button" class="word-tile" data-pick="${i}" lang="fr" ${chosen.includes(i) ? 'disabled' : ''}>${t}</button>`)}</div>`.s;
      };

      const showQuestion = () => {
        state = 'ask';
        chosen = [];
        const q = session.queue[session.index];
        const total = session.queue.length;
        $('.progress-fill').style.width = `${(session.index / total) * 100}%`;
        $('.practice-count').textContent = `${session.index + 1} / ${total}`;
        $('.q-direction').textContent = q.label;
        const prompt = $('.q-prompt');
        prompt.innerHTML = promptMarkup(q).s;
        prompt.lang = q.promptLang;
        prompt.classList.toggle('is-sentence', !!(q.sentence || q.gap));
        const sub = $('.q-sub');
        sub.textContent = q.sub || '';
        sub.hidden = !q.sub;
        $('.q-card').classList.remove('shake', 'is-good', 'is-bad', 'is-warn');
        $('.feedback').hidden = true;
        if (q.input === 'tiles') {
          input = null;
          renderTiles(q);
        } else {
          $('.answer').innerHTML = html`
            <input class="answer-input ${q.sentence ? 'is-sentence' : ''}" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="${q.sentence ? 'Write the sentence' : 'Type the answer'}" aria-label="Your answer" lang="${q.answerLang}">
            <div class="accent-bar">${accentBar(q.answerLang)}</div>`.s;
          input = $('.answer-input');
          input.addEventListener('keydown', onEnter);
          $('.accent-bar').addEventListener('pointerdown', e => e.preventDefault());
          input.focus({ preventScroll: true });
        }
        setActions(html`<button class="btn btn-text" data-skip>Don't know</button>
          <button class="btn btn-primary btn-lg" data-check>${isTest ? 'Next' : 'Check'}</button>`);
      };

      const recordAnswer = (q, ok, delta = 1) => {
        if (q.word) {
          store.progress[q.word.id] = record(store.progress[q.word.id], ok);
          store.save('progress');
        }
        logAnswer(app.lang, ok, delta);
      };

      const showFeedback = (q, result, given, key) => {
        const fb = feedbackMarkup(q, result, given, key);
        const box = $('.feedback');
        box.className = `feedback tone-${fb.tone}`;
        box.innerHTML = fb.markup.s;
        box.hidden = false;
        $('.q-card').classList.remove('is-good', 'is-bad', 'is-warn');
        $('.q-card').classList.add(`is-${fb.tone}`);
        if (q.gap) $('.q-prompt').innerHTML = promptMarkup(q, result.expected).s;
      };

      const submit = skipped => {
        const q = session.queue[session.index];
        const value = answerValue(q);
        if (!skipped && !value.trim()) {
          input?.focus();
          return;
        }
        const given = skipped ? '' : value.trim();
        const result = skipped ? { kind: 'wrong', ok: false, expected: q.answers[0] } : q.check(value);
        recordAnswer(q, result.ok);
        session.results.push({ question: q, ok: result.ok, given, result });
        if (!q.again) session.onAnswer?.(q, result.ok);
        if (isTest) return next();

        if (!result.ok && !q.again) session.queue.push({ ...q, again: true });
        state = 'feedback';
        if (input) {
          input.readOnly = true;
          input.classList.add(result.ok ? 'is-good' : 'is-bad');
        } else {
          root.querySelectorAll('.word-tile').forEach(b => { b.disabled = true; });
        }
        $('.progress-fill').style.width = `${((session.index + 1) / session.queue.length) * 100}%`;
        $('.practice-count').textContent = `${session.index + 1} / ${session.queue.length}`;
        const key = feedbackKey(result, skipped);
        showFeedback(q, result, given, key);
        if (!result.ok && !skipped) $('.q-card').classList.add('shake');
        const last = session.index + 1 >= session.queue.length;
        const canAsk = !result.ok && !skipped && !isTest && (q.sentence || q.gap) && input;
        setActions(html`${!result.ok && !skipped ? html`<span class="practice-appeal"><button class="btn btn-text" data-override>I was right</button>${canAsk ? html`<button class="btn btn-text" data-ask>${icon('bulb')}Ask AI</button>` : ''}</span>` : html`<span></span>`}
          <button class="btn btn-primary btn-lg" data-continue>${last ? 'See results' : 'Continue'}</button>`);
        $('[data-continue]').focus({ preventScroll: true });
      };

      // Your answer is accepted from now on for this question on this device.
      const override = () => {
        const q = session.queue[session.index];
        const last = session.results.at(-1);
        last.ok = true;
        session.onAnswer?.(q, true);
        const list = (store.learn.accepted[q.id] ??= []);
        if (!list.includes(last.given)) list.push(last.given);
        store.save('learn');
        recordAnswer(q, true, 0);
        const again = session.queue.findIndex((x, i) => i > session.index && x.again && x.id === q.id);
        if (again >= 0) session.queue.splice(again, 1);
        input?.classList.replace('is-bad', 'is-good');
        $('.q-card').classList.remove('shake');
        showFeedback(q, last.result, last.given, 'override');
        $('.practice-appeal').replaceWith(document.createElement('span'));
        const isLast = session.index + 1 >= session.queue.length;
        $('[data-continue]').textContent = isLast ? 'See results' : 'Continue';
      };

      // The AI judges your answer; if it agrees, it is accepted like "I was right".
      const ask = async () => {
        const q = session.queue[session.index];
        const last = session.results.at(-1);
        if (!aiReady(aiSettings())) {
          app.toast('Add an AI key in Settings to ask the AI.', { kind: 'error' });
          return;
        }
        const button = $('[data-ask]');
        button.disabled = true;
        button.lastChild.textContent = 'Asking...';
        try {
          const verdict = await askAnswer(aiSettings(), q, last.given);
          if (state !== 'feedback' || session.results.at(-1) !== last) return;
          if (verdict.correct) {
            override();
            app.toast(`The AI agrees. ${verdict.why}`, { kind: 'success', duration: 6000 });
            return;
          }
          const note = document.createElement('div');
          note.className = 'feedback-ai';
          note.textContent = `AI: ${verdict.why || 'Not correct.'}`;
          $('.feedback').append(note);
          button.remove();
        } catch (e) {
          app.toast(e instanceof AiError ? e.message : 'Could not ask the AI.', { kind: 'error' });
          button.disabled = false;
          button.lastChild.textContent = 'Ask AI';
        }
      };

      const next = () => {
        session.index++;
        if (session.index >= session.queue.length) finish();
        else showQuestion();
      };

      // Stops here so the same Enter doesn't also skip past the feedback.
      function onEnter(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        if (state === 'ask') submit(false);
      }

      root.addEventListener('keydown', e => {
        if (e.key === 'Enter' && state === 'feedback' && e.target.tagName !== 'BUTTON') {
          e.preventDefault();
          next();
        }
      });

      root.addEventListener('click', e => {
        const t = e.target.closest('button');
        if (!t || state === 'done') return;
        const q = session.queue[session.index];
        if (t.matches('[data-quit]')) quit();
        else if (t.matches('[data-check]')) submit(false);
        else if (t.matches('[data-skip]')) submit(true);
        else if (t.matches('[data-continue]')) next();
        else if (t.matches('[data-override]')) override();
        else if (t.matches('[data-ask]')) ask();
        else if (t.matches('[data-char]') && state === 'ask' && input) insertChar(input, t.dataset.char);
        else if (t.matches('[data-pick]') && state === 'ask') {
          chosen.push(Number(t.dataset.pick));
          renderTiles(q);
        } else if (t.matches('[data-unpick]') && state === 'ask') {
          chosen.splice(Number(t.dataset.unpick), 1);
          renderTiles(q);
        }
      });

      if (session.index >= session.queue.length) finish();
      else showQuestion();
    },
  };
}

// One Learn card at a time; the last one leads into practice.
export function lessonView(app, { id = '' }) {
  const [unitId, lessonId] = id.split('/');
  const { part: unit, lesson, states } = findLesson(app, unitId, lessonId);
  if (!lesson) return { redirect: 'learn' };
  if (!states.get(unit.id).lessons[lesson.index]) {
    app.toast('Finish the previous lesson first.');
    return { redirect: `unit/${encodeURIComponent(unit.unitId)}` };
  }
  const cards = lesson.learn || [];
  const ctx = learnContext(app, { lesson });
  const total = cards.length;

  const body = html`
    <div class="learn-progress" aria-hidden="true">${cards.map((_, i) => html`<i data-dot="${i}"></i>`)}</div>
    <section class="card learn-card" aria-live="polite"></section>
    <div class="learn-nav">
      <button class="btn btn-secondary btn-lg" data-prev>${icon('back')}Back</button>
      <button class="btn btn-primary btn-lg" data-next></button>
    </div>
    <button class="btn btn-text btn-block learn-skip" data-practice>Skip to practice</button>
    ${grammarLinks(app, lesson.topics)}`;

  return {
    title: `${lesson.index + 1}. ${lesson.title}`,
    back: `unit/${encodeURIComponent(unit.unitId)}`,
    tab: 'learn',
    hideLang: true,
    body,
    mount(root) {
      let at = 0;
      const card = root.querySelector('.learn-card');
      const practice = () => startLessonPractice(app, unit, lesson);

      const show = () => {
        card.innerHTML = total ? renderCard(cards[at], ctx).s : html`<p class="learn-p">This lesson goes straight to practice.</p>`.s;
        root.querySelectorAll('[data-dot]').forEach((d, i) => d.classList.toggle('on', i <= at));
        root.querySelector('[data-prev]').disabled = at === 0;
        const last = at >= total - 1;
        root.querySelector('[data-next]').innerHTML = (last ? html`${icon('play')}Start practice` : html`Next${icon('chevronRight')}`).s;
        root.querySelector('.learn-skip').hidden = last;
        if (last && !store.learn.lessons[lesson.id]?.learned) {
          saveLesson(store.learn, lesson.id, { learned: true });
          store.save('learn');
        }
        const checks = (cards[at]?.blocks || []).filter(b => b.type === 'check');
        card.querySelectorAll('[data-check]').forEach((el, n) => mountCheck(el, checks[n], `${lesson.id}-c${at}-${n}`, ctx));
      };

      root.querySelector('[data-prev]').addEventListener('click', () => {
        at = Math.max(0, at - 1);
        show();
        window.scrollTo(0, 0);
      });
      root.querySelector('[data-next]').addEventListener('click', () => {
        if (at >= total - 1) return practice();
        at++;
        show();
        window.scrollTo(0, 0);
      });
      root.querySelector('[data-practice]').addEventListener('click', practice);
      show();
    },
  };
}

// A quick try-it-now question inside a Learn card. Nothing is recorded.
export function mountCheck(el, block, id, ctx) {
  const [q] = toQuestions({ id, ...block.item }, ctx);
  if (!q) return;
  el.innerHTML = html`
    <div class="learn-check-label">${icon('target')}Try it · ${q.label}</div>
    <div class="learn-check-prompt" lang="${q.promptLang}">${promptMarkup(q)}</div>
    ${q.sub ? html`<div class="learn-check-sub">${q.sub}</div>` : ''}
    <div class="learn-check-row">
      <input class="input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" aria-label="Your answer" lang="${q.answerLang}">
      <button class="btn btn-primary" type="button" data-try>Check</button>
    </div>
    <div class="accent-bar">${accentBar(q.answerLang)}</div>
    <div class="feedback" hidden></div>`.s;
  const input = el.querySelector('input');
  const box = el.querySelector('.feedback');
  const go = () => {
    if (!input.value.trim()) return input.focus();
    const result = q.check(input.value);
    const key = feedbackKey(result, false);
    const fb = feedbackMarkup(q, result, input.value.trim(), key);
    box.className = `feedback tone-${fb.tone}`;
    box.innerHTML = fb.markup.s;
    box.hidden = false;
    if (q.gap && result.ok) el.querySelector('.learn-check-prompt').innerHTML = promptMarkup(q, result.expected).s;
  };
  el.querySelector('[data-try]').addEventListener('click', go);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
    }
  });
  el.querySelector('.accent-bar').addEventListener('pointerdown', e => e.preventDefault());
  el.querySelector('.accent-bar').addEventListener('click', e => {
    const b = e.target.closest('[data-char]');
    if (b) insertChar(input, b.dataset.char);
  });
}
