import { store, streak, activityOn, dayKey } from '../store.js';
import { summarize } from '../srs.js';
import { langName } from '../data.js';
import { html, icon, fmt, pct, plural, masteryBar, masteryLegend } from '../ui.js';
import { deckRow, noDecks } from './decks.js';
import { homeContinue, resume } from './resume.js';
import { drillSets, openDrillSheet } from './drills.js';

function tile(iconName, label, value, sub) {
  return html`<div class="tile">
    <div class="tile-label">${icon(iconName)}${label}</div>
    <div class="tile-value">${value}</div>
    <div class="tile-sub">${sub}</div>
  </div>`;
}

const row = it => html`<span class="home-continue-icon">${icon(it.icon)}</span>
  <span class="lesson-main"><strong>${it.title}</strong><small>${it.sub}</small></span>${icon('chevronRight', 'chevron')}`;

export function homeView(app) {
  const decks = app.decksFor();
  const title = `Hi, ${store.account.name}`;
  if (!decks.length) return { title, body: noDecks() };

  const s = summarize(app.wordsOf(decks), store.progress);
  const fresh = s.levels.new;
  const today = activityOn(dayKey(), app.lang);
  const days = streak();
  const answered = s.right + s.wrong;
  const items = homeContinue(app);
  const sets = drillSets(app);
  const translate = sets.find(x => x.id === 'translate');
  const drillTotal = sets.reduce((n, x) => n + x.items.length, 0);

  const hero = s.due
    ? { value: s.due, label: s.due === 1 ? 'word ready for review' : 'words ready for review', sub: fresh ? `plus ${plural(fresh, 'new word')} waiting` : 'Keep your streak going' }
    : fresh
      ? { value: fresh, label: fresh === 1 ? 'new word to learn' : 'new words to learn', sub: 'Nothing due right now' }
      : { value: s.levels.mastered, label: 'words mastered', sub: 'All caught up. Practice ahead to stay sharp.' };

  const recent = decks
    .map(d => ({ d, last: Math.max(0, ...d.words.map(w => store.progress[w.id]?.last || 0)) }))
    .sort((a, b) => b.last - a.last)
    .slice(0, 3);

  const body = html`
    <section class="hero">
      <div class="hero-eyebrow">${langName(app.lang)} · ${plural(decks.length, 'deck')}</div>
      <div class="hero-figure">${fmt(hero.value)}</div>
      <div class="hero-label">${hero.label}</div>
      <div class="hero-sub">${hero.sub}</div>
      <button class="btn btn-on-accent" data-start="smart">${icon('play')}Start session</button>
    </section>

    ${items.length ? html`<section class="card home-continue">
      <header class="card-head"><h2>Continue</h2></header>
      <div class="lesson-list">${items.map((it, i) => (it.href
        ? html`<a class="lesson-row" href="${it.href}">${row(it)}</a>`
        : html`<button type="button" class="lesson-row w-row" data-resume="${i}">${row(it)}</button>`))}</div>
    </section>` : ''}

    <div class="quick">
      <button class="quick-btn" data-start="mistakes" ${s.mistakes ? '' : 'disabled'}>
        <span class="quick-label">${icon('repeat')}Fix mistakes</span><span class="quick-count">${fmt(s.mistakes)}</span>
      </button>
      <button class="quick-btn" data-start="new" ${fresh ? '' : 'disabled'}>
        <span class="quick-label">${icon('plus')}Learn new</span><span class="quick-count">${fmt(fresh)}</span>
      </button>
    </div>

    ${translate ? html`<div class="quick">
      <button class="quick-btn" data-translate><span class="quick-label">${icon('units')}Translate</span><span class="quick-count">${fmt(translate.items.length)}</span></button>
      <a class="quick-btn" href="#/learn?view=drills"><span class="quick-label">${icon('repeat')}Sentence drills</span><span class="quick-count">${fmt(drillTotal)}</span></a>
    </div>` : ''}

    <section class="card">
      <header class="card-head"><h2>Mastery</h2><span class="card-meta">${plural(s.total, 'word')}</span></header>
      ${masteryBar(s.levels)}
      ${masteryLegend(s.levels, { links: true })}
    </section>

    <section class="tiles">
      ${tile('flame', 'Streak', plural(days, 'day'), days ? 'Practice daily to keep it' : 'Start one today')}
      ${tile('bolt', 'Today', fmt(today.answers), today.answers ? `${pct(today.correct, today.answers)}% correct` : 'No answers yet')}
      ${tile('target', 'Accuracy', answered ? `${pct(s.right, answered)}%` : '–', `${plural(answered, 'answer')} total`)}
    </section>

    <section class="card">
      <header class="card-head"><h2>Continue</h2><a class="card-link" href="#/decks">All decks${icon('chevronRight')}</a></header>
      <div class="deck-list">${recent.map(({ d }) => deckRow(d))}</div>
    </section>

    <footer class="version-footer">Vocab v${app.version}</footer>`;

  return {
    title,
    body,
    mount(root) {
      root.querySelector('[data-translate]')?.addEventListener('click', () => openDrillSheet(app, translate));
      root.querySelectorAll('[data-resume]').forEach(btn => btn.addEventListener('click', () => resume(app, items[btn.dataset.resume])));
      root.querySelectorAll('[data-start]').forEach(btn => btn.addEventListener('click', () => {
        const mode = btn.dataset.start;
        const titles = { smart: 'Daily session', mistakes: 'Fix mistakes', new: 'New words' };
        app.startSession({ decks, mode, title: titles[mode] });
      }));
    },
  };
}
