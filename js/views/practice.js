import { store, logAnswer } from '../store.js';
import { record, summarize, levelOf, countFor, LEVELS, MODES } from '../srs.js';
import { check, variants } from '../check.js';
import { langName, ACCENTS } from '../data.js';
import { html, icon, plural, pct, answersText, levelDots, segmented, onSegmented } from '../ui.js';
import { explainWord, buildIndex, whyBlock } from '../explain.js';

const LENGTHS = [
  { value: '10', label: '10' },
  { value: '20', label: '20' },
  { value: '30', label: '30' },
  { value: '0', label: 'All' },
];

export function openPracticeSheet(app, { decks, title }) {
  const s = summarize(app.wordsOf(decks), store.progress);
  const { from, lang } = decks[0];
  let mode = 'smart';
  let length = String(store.settings.sessionLength);

  const available = () => countFor(mode, s);
  const startLabel = () => {
    const n = Math.min(available(), Number(length) || Infinity);
    return n ? `Start · ${plural(n, 'word')}` : 'No words in this group';
  };

  app.sheet({
    title: `Practice ${title}`,
    body: html`
      <div class="field-label">What to practice</div>
      <div class="chips wrap">${MODES.map(m => {
        const n = countFor(m.key, s);
        return html`<button class="chip ${m.key === mode ? 'active' : ''}" data-mode="${m.key}" ${n ? '' : 'disabled'}>
          ${m.label}<span class="chip-count">${n}</span></button>`;
      })}</div>
      <div class="field-label">Session length</div>
      ${segmented('length', LENGTHS, length)}
      <div class="field-label">Direction</div>
      ${segmented('direction', [
        { value: 'forward', label: `${langName(from)} → ${langName(lang)}` },
        { value: 'reverse', label: `${langName(lang)} → ${langName(from)}` },
        { value: 'mixed', label: 'Mixed' },
      ], store.settings.direction)}
      <button class="btn btn-primary btn-block btn-lg" data-go>${icon('play')}<span>${startLabel()}</span></button>`,
    onMount(body, close) {
      const go = body.querySelector('[data-go]');
      const refresh = () => {
        go.querySelector('span').textContent = startLabel();
        go.disabled = !available();
      };
      body.querySelectorAll('[data-mode]').forEach(chip => chip.addEventListener('click', () => {
        mode = chip.dataset.mode;
        body.querySelectorAll('[data-mode]').forEach(c => c.classList.toggle('active', c === chip));
        refresh();
      }));
      onSegmented(body, (name, value) => {
        if (name === 'length') length = value;
        if (name === 'direction') {
          store.settings.direction = value;
          store.save('settings');
        }
        refresh();
      });
      go.addEventListener('click', () => {
        close();
        const label = MODES.find(m => m.key === mode).label;
        app.startSession({ decks, mode, count: Number(length) || Infinity, title: mode === 'smart' ? title : `${title} · ${label}` });
      });
    },
  });
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

function questionParts(item) {
  const { word, reverse } = item;
  const { deck } = word;
  return reverse
    ? { prompt: answersText(word.a), promptLang: deck.lang, accepted: variants(word.q), shown: [word.q], answerLang: deck.from }
    : { prompt: word.q, promptLang: deck.from, accepted: word.a, shown: word.a, answerLang: deck.lang };
}

function summaryView(session) {
  const total = session.results.length;
  const correct = session.results.filter(r => r.ok).length;
  const levelUps = session.results.filter(r => r.ok && LEVELS.findIndex(l => l.key === levelOf(r.after)) > LEVELS.findIndex(l => l.key === levelOf(r.prev))).length;
  const missed = session.results.filter(r => !r.ok);
  const score = pct(correct, total);
  const headline = !total ? 'Session ended' : score === 100 ? 'Perfect session' : score >= 80 ? 'Great work' : score >= 50 ? 'Good progress' : 'Keep at it';

  return html`<div class="summary">
    <div class="summary-ring" style="--p:${score}"><span>${score}%</span></div>
    <h2>${headline}</h2>
    <p class="summary-sub">${correct} of ${plural(total, 'word')} correct${levelUps ? ` · ${plural(levelUps, 'word')} leveled up` : ''}</p>
    <div class="summary-stats">
      <div><strong>${correct}</strong><span>Correct</span></div>
      <div><strong>${missed.length}</strong><span>Missed</span></div>
      <div><strong>${levelUps}</strong><span>Level ups</span></div>
    </div>
    ${missed.length ? html`<section class="card summary-missed">
      <header class="card-head"><h2>Review these</h2></header>
      <div class="word-list">${missed.map(r => html`<div class="word-row">
        <div class="word-main"><div class="word-q">${r.word.q}</div><div class="word-a" lang="${r.word.deck.lang}">${answersText(r.word.a)}</div></div>
        ${r.given ? html`<div class="word-side"><span class="given">${r.given}</span></div>` : ''}
      </div>`)}</div>
    </section>` : ''}
    <div class="summary-actions">
      ${session.next ? html`<button class="btn btn-primary btn-block btn-lg" data-chain>${icon('chevronRight')}${session.next.label}</button>` : ''}
      ${missed.length ? html`<button class="btn ${session.next ? 'btn-secondary' : 'btn-primary'} btn-block btn-lg" data-again>${icon('repeat')}Practice missed words (${missed.length})</button>` : ''}
      <button class="btn ${missed.length || session.next ? 'btn-secondary' : 'btn-primary'} btn-block btn-lg" data-next>${icon('play')}New session</button>
      <button class="btn btn-text btn-block" data-done>Done</button>
    </div>
  </div>`;
}

export function practiceView(app) {
  const session = app.session;
  if (!session) return { redirect: 'home' };
  const total = session.items.length;

  const body = html`<div class="practice">
    <header class="practice-top">
      <button class="icon-btn" data-quit aria-label="End session">${icon('x')}</button>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}"><div class="progress-fill"></div></div>
      <div class="practice-count"></div>
    </header>
    <div class="practice-stage">
      <div class="q-card">
        <div class="q-meta"><span class="q-direction"></span><span class="q-deck"></span></div>
        <div class="q-prompt"></div>
        <div class="q-level"></div>
      </div>
      <div class="answer">
        <input class="answer-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="Type the translation" aria-label="Your answer">
        <div class="accent-bar"></div>
      </div>
      <div class="feedback" hidden aria-live="polite"></div>
    </div>
    <footer class="practice-actions"></footer>
  </div>`;

  return {
    focus: true,
    tab: 'home',
    body,
    mount(root) {
      const $ = sel => root.querySelector(sel);
      const input = $('.answer-input');
      let state = 'ask';

      const finish = () => {
        state = 'done';
        root.innerHTML = summaryView(session).s;
        root.querySelector('[data-again]')?.addEventListener('click', () => {
          const words = session.results.filter(r => !r.ok).map(r => r.word);
          app.startSession({ words, title: session.title, decks: session.restart.decks, pool: session.restart.pool });
        });
        root.querySelector('[data-chain]')?.addEventListener('click', () => session.next.run());
        root.querySelector('[data-next]').addEventListener('click', () => app.startSession(session.restart));
        root.querySelector('[data-done]').addEventListener('click', quit);
      };

      const quit = () => {
        app.session = null;
        location.hash = session.returnTo || '#/home';
      };

      const setActions = markup => {
        $('.practice-actions').innerHTML = markup.s;
      };

      const showQuestion = () => {
        state = 'ask';
        const item = session.items[session.index];
        const q = questionParts(item);
        $('.progress-fill').style.width = `${(session.index / total) * 100}%`;
        $('.practice-count').textContent = `${session.index + 1} / ${total}`;
        $('.q-direction').textContent = `Translate to ${langName(q.answerLang)}`;
        $('.q-deck').textContent = item.word.deck.title;
        const prompt = $('.q-prompt');
        prompt.textContent = item.word.note && !item.reverse ? `${q.prompt} (${item.word.note})` : q.prompt;
        prompt.lang = q.promptLang;
        $('.q-level').innerHTML = levelDots(store.progress[item.word.id]).s;
        $('.q-card').classList.remove('shake', 'is-good', 'is-bad', 'is-warn');
        const accents = ACCENTS[q.answerLang];
        $('.accent-bar').innerHTML = accents ? accents.split(' ').map(ch => html`<button type="button" tabindex="-1" data-char="${ch}">${ch}</button>`.s).join('') : '';
        input.value = '';
        input.readOnly = false;
        input.lang = q.answerLang;
        input.className = 'answer-input';
        $('.feedback').hidden = true;
        setActions(html`<button class="btn btn-text" data-skip>Don't know</button>
          <button class="btn btn-primary btn-lg" data-check>Check</button>`);
        input.focus({ preventScroll: true });
      };

      const index = buildIndex(app.wordsOf(app.decksFor(session.items[0].word.deck.lang)));

      const renderFeedback = (key, result, q, item) => {
        const { after, given } = session.results.at(-1);
        const why = key === 'exact' || key === 'override' ? null : explainWord({
          given, expected: result.expected, kind: result.kind, word: item.word, reverse: item.reverse,
          index, strict: store.settings.strictAccents, conj: app.conj[item.word.deck.lang],
        });
        const f = FEEDBACK[key === 'typo' && why?.category !== 'typo' ? 'wrong' : key];
        const others = q.shown.filter(a => a !== result.expected);
        const showGiven = given && key !== 'exact' && key !== 'override';
        const fb = $('.feedback');
        fb.className = `feedback tone-${f.tone}`;
        fb.innerHTML = html`
          <div class="feedback-head">${icon(f.icon)}<strong>${f.title}</strong>
            <span class="feedback-level">${levelDots(after)}<span>${LEVELS.find(l => l.key === levelOf(after)).label}</span></span>
          </div>
          ${key !== 'exact' ? html`<div class="feedback-answer" lang="${q.answerLang}">${why?.marked || result.expected}</div>` : ''}
          ${showGiven ? html`<div class="feedback-given">You wrote: <s>${given}</s></div>` : ''}
          ${others.length ? html`<div class="feedback-also">Also accepted: ${others.join(', ')}</div>` : ''}
          ${why ? whyBlock(why) : ''}`.s;
        fb.hidden = false;
        $('.q-card').classList.add(`is-${f.tone}`);
      };

      const submit = skipped => {
        const value = input.value;
        if (!skipped && !value.trim()) {
          input.focus();
          return;
        }
        const item = session.items[session.index];
        const q = questionParts(item);
        const result = skipped ? { kind: 'wrong', ok: false, expected: q.accepted[0] } : check(value, q.accepted, store.settings);
        const prev = store.progress[item.word.id];
        const after = record(prev, result.ok);
        store.progress[item.word.id] = after;
        store.save('progress');
        logAnswer(item.word.deck.lang, result.ok);
        session.results.push({ word: item.word, ok: result.ok, given: skipped ? '' : value.trim(), prev, after });

        state = 'feedback';
        input.readOnly = true;
        input.classList.add(result.ok ? 'is-good' : 'is-bad');
        $('.progress-fill').style.width = `${((session.index + 1) / total) * 100}%`;
        const key = skipped ? 'skipped' : result.kind === 'accent' ? (result.ok ? 'accentOk' : 'accent') : result.kind;
        renderFeedback(key, result, q, item);
        if (!result.ok && !skipped) $('.q-card').classList.add('shake');
        setActions(html`${!result.ok && !skipped ? html`<button class="btn btn-text" data-override>I was right</button>` : html`<span></span>`}
          <button class="btn btn-primary btn-lg" data-continue>${session.index + 1 < total ? 'Continue' : 'See results'}</button>`);
        input.focus({ preventScroll: true });

        const override = $('[data-override]');
        override?.addEventListener('click', () => {
          const last = session.results.at(-1);
          last.ok = true;
          last.after = record(last.prev, true);
          store.progress[item.word.id] = last.after;
          store.save('progress');
          logAnswer(item.word.deck.lang, true, 0);
          input.classList.replace('is-bad', 'is-good');
          $('.q-card').classList.remove('is-bad', 'is-warn', 'shake');
          renderFeedback('override', result, q, item);
          override.replaceWith(document.createElement('span'));
          input.focus({ preventScroll: true });
        });
      };

      const next = () => {
        session.index++;
        if (session.index >= total) finish();
        else showQuestion();
      };

      root.addEventListener('click', e => {
        const t = e.target.closest('button');
        if (!t || state === 'done') return;
        if (t.matches('[data-quit]')) quit();
        else if (t.matches('[data-check]')) submit(false);
        else if (t.matches('[data-skip]')) submit(true);
        else if (t.matches('[data-continue]')) next();
        else if (t.matches('[data-char]') && state === 'ask') {
          const { selectionStart: s0, selectionEnd: s1, value } = input;
          input.value = value.slice(0, s0) + t.dataset.char + value.slice(s1);
          input.setSelectionRange(s0 + 1, s0 + 1);
          input.focus();
        }
      });
      root.querySelector('.accent-bar').addEventListener('pointerdown', e => e.preventDefault());
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (state === 'ask') submit(false);
        else if (state === 'feedback') next();
      });

      if (session.index >= total) finish();
      else showQuestion();
    },
  };
}
