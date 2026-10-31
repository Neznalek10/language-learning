import { store } from '../store.js';
import { html, icon, plural, segmented, onSegmented, emptyState } from '../ui.js';
import { ruleHref } from '../learn/blocks.js';
import { questionsFor } from '../learn/course.js';
import { activeMistakes, gradeMistake, pickPractice, toItems, weakRules, mistakeFromItem } from '../learn/mistakes.js';
import { learnContext, startExercises } from './lesson.js';

const SOURCE = { write: 'Writing', chat: 'Chat' };
const PRACTICE_COUNT = 10;
const dateText = at => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function startPractice(app) {
  const list = store.write.mistakes;
  const run = () => {
    const picked = pickPractice(list, PRACTICE_COUNT);
    startExercises(app, {
      title: 'My mistakes',
      questions: questionsFor(toItems(picked), learnContext(app)),
      restart: run,
      onAnswer: (q, ok) => {
        const m = mistakeFromItem(list, q.id);
        if (m) gradeMistake(list, m.id, ok);
        store.save('write');
      },
    });
  };
  run();
}

export function mistakesView(app, { view = 'active' }) {
  const list = (store.write.mistakes ??= []);
  const active = activeMistakes(list);
  const learned = list.filter(m => m.done);
  const shown = view === 'learned' ? learned : active;
  const g = app.grammar[app.lang];
  const weak = weakRules(list).slice(0, 5);
  const ruleTitle = id => g?.byId.get(id)?.title || id;

  const body = list.length ? html`
    <section class="card unit-head">
      <div class="eyebrow">Notebook</div>
      <h2 class="topic-title">My mistakes</h2>
      <p class="muted">Every real mistake from your checked texts and chats lands here. Correct one twice in a row and it counts as learned.</p>
      <div class="deck-stats">
        <div><strong>${active.length}</strong><span>to review</span></div>
        <div><strong>${learned.length}</strong><span>learned</span></div>
        <div><strong>${list.reduce((n, m) => n + m.seen, 0)}</strong><span>times made</span></div>
      </div>
      <button class="btn btn-primary btn-block btn-lg" data-practice ${active.length ? '' : 'disabled'}>${icon('play')}${active.length ? `Practice ${Math.min(active.length, PRACTICE_COUNT)} mistakes` : 'Nothing to review'}</button>
      ${weak.length ? html`<div class="g-see w-weak"><span>Weak spots</span>${weak.map(w => html`<a class="g-link" href="${ruleHref(w.rule)}">${ruleTitle(w.rule)} · ${w.count}</a>`)}</div>` : ''}
    </section>
    ${segmented('view', [{ value: 'active', label: `To review · ${active.length}` }, { value: 'learned', label: `Learned · ${learned.length}` }], view === 'learned' ? 'learned' : 'active')}
    ${shown.length ? html`<section class="card"><div class="w-items">${shown.map(m => html`<div class="w-item" data-id="${m.id}">
      <div class="w-change" lang="fr"><s>${m.wrong}</s><span class="w-arrow">${icon('chevronRight')}</span><strong>${m.right}</strong></div>
      ${m.why ? html`<p>${m.why}</p>` : ''}
      <div class="w-item-meta"><span class="muted small">${SOURCE[m.source] || 'Writing'}${m.topic ? ` · ${m.topic}` : ''} · made ${m.seen === 1 ? 'once' : `${m.seen} times`} · ${dateText(m.last)}</span>
        <span class="w-item-actions">
          ${m.rule ? html`<a class="g-link" href="${ruleHref(m.rule)}">${ruleTitle(m.rule)}</a>` : ''}
          <button class="btn btn-secondary btn-sm" data-toggle="${m.id}">${m.done ? 'Review again' : 'I know this'}</button>
          <button class="icon-btn" data-remove="${m.id}" aria-label="Remove">${icon('trash')}</button>
        </span></div>
    </div>`)}</div></section>`
      : html`<div class="notice notice-good">${icon('check')}<span>${view === 'learned' ? 'Nothing learned yet. Practice your mistakes to move them here.' : 'No mistakes waiting. Nice.'}</span></div>`}`
    : emptyState({ iconName: 'check', title: 'No mistakes saved yet', text: 'Write a text or chat in the Write tab. The real mistakes the AI finds are saved here, so you can practice exactly what you get wrong.', action: html`<a class="btn btn-primary" href="#/write">${icon('write')}Go to Write</a>` });

  return {
    title: 'My mistakes',
    back: 'write',
    tab: 'write',
    hideLang: true,
    body,
    mount(root) {
      onSegmented(root, (_, value) => app.go(`mistakes?view=${value}`, { replace: true }));
      root.querySelector('[data-practice]')?.addEventListener('click', () => startPractice(app));
      root.addEventListener('click', async e => {
        const toggle = e.target.closest('[data-toggle]');
        const remove = e.target.closest('[data-remove]');
        const target = toggle?.dataset.toggle || remove?.dataset.remove;
        if (!target) return;
        const m = list.find(x => x.id === target);
        if (!m) return;
        if (toggle) {
          m.done = !m.done;
          m.streak = 0;
        } else {
          if (!await app.confirm({ title: 'Remove this mistake?', text: `${m.wrong} → ${m.right}`, confirmLabel: 'Remove', danger: true })) return;
          list.splice(list.indexOf(m), 1);
        }
        store.save('write');
        app.render();
      });
    },
  };
}
