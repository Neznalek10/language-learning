import { store, logAnswer } from '../store.js';
import { record, pickSession, levelOf, LEVELS } from '../srs.js';
import { combos, persons, personLabel, compact, subjectPrefix, checkForm, tenseInfo } from '../conj.js';
import { ACCENTS } from '../data.js';
import { html, icon, plural, pct, levelDots } from '../ui.js';
import { explainForm, whyBlock } from '../explain.js';

export function startDrill(app, { verbs, tenses, mode, count, title, items }) {
  const lang = app.lang;
  if (!items) {
    const pool = combos(lang, verbs, tenses);
    const picked = pickSession(pool, store.conj, { mode: 'smart', count });
    items = mode === 'table' ? picked.map(combo => ({ combo })) : withPersons(picked, count);
  }
  if (!items.length) {
    app.toast('No tables match this selection.');
    return;
  }
  app.conjSession = {
    lang,
    mode,
    title,
    items,
    index: 0,
    results: [],
    restart: { verbs, tenses, mode, count, title },
    returnTo: location.hash.startsWith('#/drill') ? app.conjSession?.returnTo : location.hash,
  };
  app.go('drill');
}

// One form per question; when there are fewer tables than questions, ask other persons of the same table.
function withPersons(picked, count) {
  const items = [];
  const used = new Map();
  for (let round = 0; items.length < count && round < 6; round++) {
    for (const combo of picked) {
      if (items.length >= count) break;
      const taken = used.get(combo.id) || [];
      const options = persons(combo.verb, combo.tense).filter(i => !taken.includes(i));
      if (!options.length) continue;
      const person = options[Math.floor(Math.random() * options.length)];
      used.set(combo.id, [...taken, person]);
      items.push({ combo, person });
    }
  }
  return items;
}

function summaryView(session, data) {
  const total = session.results.length;
  const correct = session.results.filter(r => r.ok).length;
  const levelUps = session.results.filter(r => r.ok && LEVELS.findIndex(l => l.key === levelOf(r.after)) > LEVELS.findIndex(l => l.key === levelOf(r.prev))).length;
  const missed = session.results.filter(r => !r.ok);
  const score = pct(correct, total);
  const headline = !total ? 'Session ended' : score === 100 ? 'Perfect session' : score >= 80 ? 'Great work' : score >= 50 ? 'Good progress' : 'Keep at it';

  return html`<div class="summary">
    <div class="summary-ring" style="--p:${score}"><span>${score}%</span></div>
    <h2>${headline}</h2>
    <p class="summary-sub">${correct} of ${plural(total, session.mode === 'table' ? 'table' : 'form')} correct${levelUps ? ` · ${plural(levelUps, 'verb tense')} leveled up` : ''}</p>
    <div class="summary-stats">
      <div><strong>${correct}</strong><span>Correct</span></div>
      <div><strong>${missed.length}</strong><span>Missed</span></div>
      <div><strong>${levelUps}</strong><span>Level ups</span></div>
    </div>
    ${missed.length ? html`<section class="card summary-missed">
      <header class="card-head"><h2>Review these</h2></header>
      <div class="word-list">${missed.map(r => {
        const { verb, tense } = r.item.combo;
        const rows = r.item.person == null ? persons(verb, tense) : [r.item.person];
        return html`<div class="word-row">
          <div class="word-main">
            <div class="word-q">${verb.inf} <span class="muted small">· ${tenseInfo(data, tense).label}</span></div>
            ${rows.filter(i => !r.rows[i]?.ok).map(i => {
              const forms = verb.data.t[tense][i];
              return html`<div class="word-a" lang="fr">${subjectPrefix(data, tense, i, forms[0])}${compact(forms)}</div>`;
            })}
          </div>
        </div>`;
      })}</div>
    </section>` : ''}
    <div class="summary-actions">
      ${missed.length ? html`<button class="btn btn-primary btn-block btn-lg" data-again>${icon('repeat')}Practice missed (${missed.length})</button>` : ''}
      <button class="btn ${missed.length ? 'btn-secondary' : 'btn-primary'} btn-block btn-lg" data-next>${icon('play')}New session</button>
      <button class="btn btn-text btn-block" data-done>Done</button>
    </div>
  </div>`;
}

export function drillView(app) {
  const session = app.conjSession;
  const data = session && app.conj[session.lang];
  if (!session || !data) return { redirect: 'tenses' };
  const total = session.items.length;
  const table = session.mode === 'table';

  const body = html`<div class="practice">
    <header class="practice-top">
      <button class="icon-btn" data-quit aria-label="End session">${icon('x')}</button>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}"><div class="progress-fill"></div></div>
      <div class="practice-count"></div>
    </header>
    <div class="practice-stage">
      <div class="q-card">
        <div class="q-meta"><span class="q-direction"></span><span class="q-deck"></span></div>
        <div class="q-prompt" lang="fr"></div>
        <div class="q-sub"></div>
        <div class="q-level"></div>
      </div>
      <div class="answer">
        <div class="fill-rows"></div>
        <div class="accent-bar">${ACCENTS.fr.split(' ').map(ch => html`<button type="button" tabindex="-1" data-char="${ch}">${ch}</button>`)}</div>
      </div>
      <div class="feedback" hidden aria-live="polite"></div>
    </div>
    <footer class="practice-actions"></footer>
  </div>`;

  return {
    focus: true,
    tab: 'grammar',
    body,
    mount(root) {
      const $ = sel => root.querySelector(sel);
      let state = 'ask';
      let inputs = [];
      let active = null;

      const quit = () => {
        app.conjSession = null;
        location.hash = session.returnTo || '#/tenses';
      };

      const finish = () => {
        state = 'done';
        root.innerHTML = summaryView(session, data).s;
        root.querySelector('[data-again]')?.addEventListener('click', () => {
          const items = session.results.filter(r => !r.ok).map(r => r.item);
          startDrill(app, { ...session.restart, items });
        });
        root.querySelector('[data-next]').addEventListener('click', () => startDrill(app, session.restart));
        root.querySelector('[data-done]').addEventListener('click', quit);
      };

      const setActions = markup => {
        $('.practice-actions').innerHTML = markup.s;
      };

      const showQuestion = () => {
        state = 'ask';
        const item = session.items[session.index];
        const { verb, tense } = item.combo;
        const info = tenseInfo(data, tense);
        $('.progress-fill').style.width = `${(session.index / total) * 100}%`;
        $('.practice-count').textContent = `${session.index + 1} / ${total}`;
        $('.q-direction').textContent = info.label;
        $('.q-deck').textContent = verb.deck.title;
        $('.q-prompt').textContent = verb.inf;
        $('.q-sub').textContent = verb.meaning;
        $('.q-level').innerHTML = levelDots(store.conj[item.combo.id]).s;
        $('.q-card').classList.remove('shake', 'is-good', 'is-bad', 'is-warn');
        const rows = item.person == null ? persons(verb, tense) : [item.person];
        $('.fill-rows').className = `fill-rows ${table ? 'is-table' : ''}`;
        $('.fill-rows').innerHTML = rows.map(i => html`<label class="fill-row" data-person="${i}">
          <span class="fill-label">${personLabel(data, tense, i)}</span>
          <input class="answer-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="${table ? 'next' : 'go'}" lang="fr" aria-label="${personLabel(data, tense, i)}">
          <span class="fill-expected" hidden></span>
          <span class="fill-why" hidden></span>
        </label>`.s).join('');
        inputs = [...root.querySelectorAll('.fill-row input')];
        inputs.forEach(input => input.addEventListener('focus', () => { active = input; }));
        $('.feedback').hidden = true;
        setActions(html`<button class="btn btn-text" data-skip>Show answer</button>
          <button class="btn btn-primary btn-lg" data-check>Check</button>`);
        active = inputs[0];
        inputs[0].focus({ preventScroll: true });
      };

      const submit = skipped => {
        if (!skipped && inputs.every(i => !i.value.trim())) {
          inputs[0].focus();
          return;
        }
        state = 'feedback';
        const item = session.items[session.index];
        const { verb, tense, id } = item.combo;
        const rows = {};
        let rule = null;
        let rowsOk = 0;
        let accentOnly = false;
        for (const input of inputs) {
          const i = Number(input.closest('.fill-row').dataset.person);
          const forms = verb.data.t[tense][i];
          const result = skipped ? { kind: 'wrong', ok: false } : checkForm(input.value, forms, store.settings);
          const prefix = subjectPrefix(data, tense, i, forms[0]);
          const why = result.ok && result.kind !== 'accent' ? null : explainForm({
            given: input.value, expected: result.expected, kind: result.kind, verb, tense, person: i, data, strict: store.settings.strictAccents,
          });
          rows[i] = { ok: result.ok, given: input.value.trim(), why, answer: html`${prefix}${why?.marked || compact(forms)}` };
          if (why) rule = why.rule;
          accentOnly ||= why?.category === 'accent' || why?.category === 'typo';
          rowsOk += result.ok ? 1 : 0;

          input.readOnly = true;
          input.classList.add(result.ok ? 'is-good' : 'is-bad');
          const expected = input.parentElement.querySelector('.fill-expected');
          expected.innerHTML = rows[i].answer.s;
          expected.hidden = !table || !why;
          const reason = input.parentElement.querySelector('.fill-why');
          reason.textContent = why?.reasons[0] || '';
          reason.hidden = !table || !reason.textContent;
        }
        const ok = rowsOk === inputs.length;
        const prev = store.conj[id];
        const after = record(prev, ok);
        store.conj[id] = after;
        store.save('conj');
        logAnswer(session.lang, ok);
        session.results.push({ item, ok, rows, prev, after });

        $('.progress-fill').style.width = `${((session.index + 1) / total) * 100}%`;
        renderFeedback(ok, skipped, rowsOk, accentOnly, after, false, rows, rule);
        if (!ok && !skipped) $('.q-card').classList.add('shake');
        setActions(html`${!ok && !skipped ? html`<button class="btn btn-text" data-override>I was right</button>` : html`<span></span>`}
          <button class="btn btn-primary btn-lg" data-continue>${session.index + 1 < total ? 'Continue' : 'See results'}</button>`);
        (table ? $('[data-continue]') : inputs[0]).focus({ preventScroll: true });
      };

      const renderFeedback = (ok, skipped, rowsOk, accentOnly, after, overridden = false, rows = {}, rule = null) => {
        const single = !table && Object.values(rows)[0];
        const tone = ok ? (accentOnly && !overridden ? 'warn' : 'good') : 'bad';
        const title = overridden ? 'Marked as correct'
          : skipped ? 'Here are the answers'
          : ok ? (accentOnly ? 'Correct, but watch the accents' : 'Correct')
          : table ? `${rowsOk} of ${inputs.length} correct` : accentOnly ? 'Almost: check the accents and spelling' : 'Not quite';
        const fb = $('.feedback');
        fb.className = `feedback tone-${tone}`;
        fb.innerHTML = html`<div class="feedback-head">${icon(ok ? 'check' : skipped ? 'info' : 'x')}<strong>${title}</strong>
          <span class="feedback-level">${levelDots(after)}<span>${LEVELS.find(l => l.key === levelOf(after)).label}</span></span></div>
          ${single && (!ok || accentOnly) && !overridden ? html`<div class="feedback-answer" lang="fr">${single.answer}</div>` : ''}
          ${!overridden && rule ? whyBlock({ reasons: single?.why?.reasons || [], rule }) : ''}`.s;
        fb.hidden = false;
        $('.q-card').classList.remove('is-good', 'is-bad', 'is-warn');
        $('.q-card').classList.add(`is-${tone}`);
      };

      const override = () => {
        const last = session.results.at(-1);
        last.ok = true;
        last.after = record(last.prev, true);
        Object.values(last.rows).forEach(r => { r.ok = true; });
        store.conj[last.item.combo.id] = last.after;
        store.save('conj');
        logAnswer(session.lang, true, 0);
        inputs.forEach(i => i.classList.replace('is-bad', 'is-good'));
        $('.q-card').classList.remove('shake');
        renderFeedback(true, false, inputs.length, false, last.after, true);
        $('[data-override]').replaceWith(document.createElement('span'));
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
        else if (t.matches('[data-override]')) override();
        else if (t.matches('[data-char]') && state === 'ask' && active) {
          const { selectionStart: s0, selectionEnd: s1, value } = active;
          active.value = value.slice(0, s0) + t.dataset.char + value.slice(s1);
          active.setSelectionRange(s0 + 1, s0 + 1);
          active.focus();
        }
      });
      root.querySelector('.accent-bar').addEventListener('pointerdown', e => e.preventDefault());
      root.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || !e.target.matches('.fill-row input')) return;
        e.preventDefault();
        if (state === 'feedback') return next();
        if (state !== 'ask') return;
        const at = inputs.indexOf(e.target);
        if (at < inputs.length - 1) inputs[at + 1].focus();
        else submit(false);
      });

      if (session.index >= total) finish();
      else showQuestion();
    },
  };
}
