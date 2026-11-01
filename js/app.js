import { store } from './store.js';
import { loadLibrary, buildLibrary, langName, langFlag, baseLang, guessBase } from './data.js';
import { summarize, pickSession } from './srs.js';
import { html, icon, plural, pct, applyTheme } from './ui.js';
import { homeView } from './views/home.js';
import { decksView, deckView } from './views/decks.js';
import { wordsView } from './views/words.js';
import { statsView } from './views/stats.js';
import { settingsView } from './views/settings.js';
import { importView } from './views/import.js';
import { practiceView } from './views/practice.js';
import { accountsView } from './views/accounts.js';
import { tensesView, verbView } from './views/tenses.js';
import { drillView } from './views/drill.js';
import { learnView, unitView, topicView } from './views/learn.js';
import { lessonView, exerciseView } from './views/lesson.js';
import { grammarView, chapterView, ruleView } from './views/grammar.js';
import { loadConjugations } from './conj.js';
import { loadCourses, courseUnitMeta, migrateLearn, repackWords } from './learn/course.js';
import { loadGrammar } from './learn/grammar.js';
import { loadWriting } from './learn/writing.js';
import { loadDrills, loadTranslate } from './learn/drills.js';
import { writingView } from './views/write.js';
import { writeView } from './views/write-tab.js';
import { speakView } from './views/speak.js';
import { chatView } from './views/free.js';
import { mistakesView } from './views/mistakes.js';
import { startTranslating, applyLanguage } from './i18n.js';
import { initFolder } from './folder.js';

const ROUTES = {
  home: homeView,
  decks: decksView,
  deck: deckView,
  words: wordsView,
  stats: statsView,
  settings: settingsView,
  import: importView,
  practice: practiceView,
  accounts: accountsView,
  tenses: tensesView,
  verb: verbView,
  drill: drillView,
  learn: learnView,
  units: () => ({ redirect: 'learn' }),
  unit: unitView,
  topic: topicView,
  lesson: lessonView,
  exercise: exerciseView,
  grammar: grammarView,
  chapter: chapterView,
  rule: ruleView,
  write: writeView,
  writing: writingView,
  speak: speakView,
  chat: chatView,
  mistakes: mistakesView,
};
const TABS = [
  { route: 'home', label: 'Home', icon: 'home' },
  { route: 'decks', label: 'Decks', icon: 'decks' },
  { route: 'words', label: 'Words', icon: 'words' },
  { route: 'grammar', label: 'Grammar', icon: 'grammar' },
  { route: 'learn', label: 'Learn', icon: 'learn' },
  { route: 'write', label: 'Write', icon: 'write' },
  { route: 'speak', label: 'Speak', icon: 'speak' },
  { route: 'stats', label: 'Stats', icon: 'stats' },
  { route: 'settings', label: 'Settings', icon: 'settings' },
];

const $ = sel => document.querySelector(sel);

export const app = {
  version: self.APP_VERSION || 'dev',
  sources: [],
  unitMeta: {},
  courses: {},
  grammar: {},
  grammarLangs: [],
  grammarPending: false,
  grammarReady: null,
  writing: {},
  speaking: {},
  drills: {},
  translate: {},
  writeSession: null,
  chatSession: null,
  learnSession: null,
  decks: [],
  conj: {},
  conjSession: null,
  errors: [],
  session: null,
  ui: { deckType: 'all' },

  languages() {
    const codes = [...new Set(this.decks.map(d => d.lang))];
    return codes.sort((a, b) => langName(a).localeCompare(langName(b)));
  },
  get lang() {
    return store.lang;
  },
  setLang(code) {
    store.lang = code;
    store.save('lang');
    this.render();
  },
  decksFor(lang = this.lang) {
    return this.decks.filter(d => d.lang === lang);
  },
  wordsOf(decks) {
    return decks.flatMap(d => d.words);
  },
  deck(id) {
    return this.decks.find(d => d.id === id);
  },

  go(path, { replace = false } = {}) {
    const hash = `#/${path}`;
    if (location.hash === hash) return this.render();
    if (!replace) return void (location.hash = hash);
    history.replaceState(null, '', hash);
    this.render();
  },

  reload() {
    const { decks, errors } = buildLibrary(this.sources, store.imports, store.additions);
    this.decks = decks;
    if (errors.length) this.toast(errors.join('; '), { kind: 'error', duration: 8000 });
    const langs = this.languages();
    if (!langs.includes(store.lang)) {
      store.lang = langs[0] || null;
      store.save('lang');
    }
  },

  async signIn(id) {
    store.useAccount(id);
    if (store.settings.base !== baseLang()) {
      if (!await loadContent(store.settings.base)) return;
      renderTabs();
      applyLanguage();
    }
    const schema = store.learn.schema || 1;
    if (migrateLearn(store.learn)) store.save('learn');
    if (repackWords(store.additions, store.imports, schema)) {
      store.save('additions');
      store.save('imports');
    }
    applyTheme();
    this.reload();
    this.go('home', { replace: true });
  },

  clearSessions() {
    this.session = null;
    this.conjSession = null;
    this.learnSession = null;
    this.writeSession = null;
    this.chatSession = null;
  },

  switchAccount() {
    store.signOut();
    this.clearSessions();
    applyTheme();
    this.go('accounts');
  },

  async setBase(code) {
    store.settings.base = code;
    store.save('settings');
    this.clearSessions();
    if (!await loadContent(code)) return;
    renderTabs();
    applyLanguage();
    this.reload();
    this.go('settings', { replace: true });
  },

  startSession({ decks, pool, mode = 'smart', count = store.settings.sessionLength, title, words, next }) {
    const picked = words || pickSession(pool || this.wordsOf(decks), store.progress, { mode, count });
    if (!picked.length) {
      this.toast('No words match this selection yet.');
      return;
    }
    const dir = store.settings.direction;
    this.session = {
      title,
      items: picked.map(word => ({ word, reverse: dir === 'reverse' || (dir === 'mixed' && Math.random() < 0.5) })),
      index: 0,
      results: [],
      restart: { decks, pool, mode, count, title, next },
      next,
      returnTo: location.hash.startsWith('#/practice') ? this.session?.returnTo : location.hash,
    };
    this.go('practice');
  },

  toast(message, { kind = 'info', duration = 3200 } = {}) {
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.setAttribute('role', 'status');
    el.innerHTML = html`${icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info')}<span>${message}</span>`.s;
    root.append(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, duration);
  },

  sheet({ title, body, onMount, onClose }) {
    const root = $('#overlay-root');
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = html`<div class="sheet-backdrop" data-close></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="sheet-handle"></div>
        <header class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
        <div class="sheet-body">${body}</div>
      </div>`.s;
    root.append(wrap);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      onClose?.();
      wrap.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => wrap.remove(), 250);
    };
    const onKey = e => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', e => e.target.closest('[data-close]') && close());
    requestAnimationFrame(() => wrap.classList.add('open'));
    onMount?.(wrap.querySelector('.sheet-body'), close);
    return close;
  },

  confirm({ title, text, confirmLabel, danger = false }) {
    return new Promise(resolve => {
      let answer = false;
      this.sheet({
        title,
        body: html`<p class="sheet-text">${text}</p>
          <div class="sheet-actions">
            <button class="btn btn-secondary" data-close>Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${confirmLabel}</button>
          </div>`,
        onMount: (body, close) => body.querySelector('[data-yes]').addEventListener('click', () => {
          answer = true;
          close();
        }),
        onClose: () => resolve(answer),
      });
    });
  },

  languageSheet() {
    const rows = this.languages().map(code => {
      const s = summarize(this.wordsOf(this.decksFor(code)), store.progress);
      return html`<button class="lang-row ${code === this.lang ? 'active' : ''}" data-lang="${code}">
        <span class="flag">${langFlag(code)}</span>
        <span class="lang-row-main"><strong>${langName(code)}</strong><small>${plural(s.total, 'word')} · ${pct(s.levels.mastered, s.total)}% mastered</small></span>
        ${code === this.lang ? icon('check', 'accent') : ''}
      </button>`;
    });
    this.sheet({
      title: 'Language',
      body: html`<div class="lang-list">${rows}</div>
        <a class="btn btn-secondary btn-block" href="#/import?mode=list" data-close>${icon('plus')}Add a language or deck</a>`,
      onMount: (body, close) => body.addEventListener('click', e => {
        const row = e.target.closest('[data-lang]');
        if (!row) return;
        close();
        this.setLang(row.dataset.lang);
      }),
    });
  },

  render() {
    const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const [name, ...rest] = path.split('/');
    let route = ROUTES[name] ? name : 'home';
    if (!store.account && route !== 'accounts') {
      route = 'accounts';
      history.replaceState(null, '', '#/accounts');
    }
    const params = Object.fromEntries(new URLSearchParams(query));
    if (rest.length) params.id = decodeURIComponent(rest.join('/'));

    const view = ROUTES[route](this, params);
    if (view.redirect) return this.go(view.redirect);

    document.body.classList.toggle('is-focus', !!view.focus);
    $('#topbar').innerHTML = this.renderTopbar(view).s;
    const container = document.createElement('div');
    container.className = `view view-${route}`;
    container.innerHTML = view.body.s;
    $('#view').replaceChildren(container);
    view.mount?.(container);

    const tab = view.tab || route;
    $('.tab[data-route=write]').hidden = !this.writing[this.lang];
    $('.tab[data-route=speak]').hidden = !this.speaking[this.lang];
    $('.tab[data-route=grammar]').hidden = !this.conj[this.lang] && !this.grammarLangs.includes(this.lang);
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.route === tab));
    if (this.lastRoute !== location.hash) window.scrollTo(0, 0);
    this.lastRoute = location.hash;
  },

  renderTopbar(view) {
    if (view.focus) return html``;
    const lang = this.lang;
    return html`
      ${view.back ? html`<a class="icon-btn back" href="#/${view.back}" aria-label="Back">${icon('back')}</a>` : ''}
      <h1 class="topbar-title">${view.title}</h1>
      ${lang && !view.hideLang ? html`<button class="lang-pill" data-action="language" aria-label="Change language">
        <span class="flag">${langFlag(lang)}</span><span class="lang-pill-name">${langName(lang)}</span>${icon('chevronDown')}
      </button>` : ''}`;
  },
};

function renderTabs() {
  $('#tabbar').innerHTML = html`
    <div class="brand"><span class="brand-mark">${icon('repeat')}</span><span>Vocab</span></div>
    ${TABS.map(t => html`<a class="tab" href="#/${t.route}" data-route="${t.route}">${icon(t.icon)}<span>${t.label}</span></a>`)}
    <div class="brand-version">v${app.version}</div>`.s;
}

function renderShell() {
  renderTabs();
  $('#topbar').addEventListener('click', e => {
    if (e.target.closest('[data-action="language"]')) app.languageSheet();
  });
}

// Grammar isn't needed to start, so it loads after the first screen and views wait for it if they have to.
function loadGrammarLater(paths) {
  app.grammar = {};
  app.grammarLangs = Object.keys(paths);
  if (!app.grammarLangs.length) return;
  app.grammarPending = true;
  const ready = loadGrammar(paths).then(({ grammar, errors }) => {
    if (app.grammarReady !== ready) return;
    app.grammar = grammar;
    app.grammarPending = false;
    if (errors.length) app.toast(`Some grammar files failed to load: ${errors.join('; ')}`, { kind: 'error', duration: 8000 });
  });
  app.grammarReady = ready;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
}

// Loads every word, lesson and drill for one learner language. Returns false after showing the error screen.
async function loadContent(base) {
  try {
    const { sources, errors, conjugations, units, courses, grammar, writing, speaking, drills, translate } = await loadLibrary(base);
    loadGrammarLater(grammar);
    const written = await loadWriting(writing);
    app.writing = written.writing;
    const spoken = await loadWriting(speaking);
    app.speaking = spoken.writing;
    const drilled = await loadDrills(drills);
    const translated = await loadTranslate(translate);
    app.drills = drilled.drills;
    app.translate = translated.translate;
    app.sources = sources;
    app.conj = await loadConjugations(conjugations);
    const learn = await loadCourses(courses);
    app.courses = learn.courses;
    app.errors = [...errors, ...learn.errors, ...written.errors, ...spoken.errors, ...drilled.errors, ...translated.errors];
    // A course's unit titles and tenses win over the older "units" details in words.json.
    const fromCourses = courseUnitMeta(learn.courses);
    app.unitMeta = Object.fromEntries([...new Set([...Object.keys(units), ...Object.keys(fromCourses)])]
      .map(lang => [lang, { ...units[lang], ...fromCourses[lang] }]));
  } catch (e) {
    $('#view').innerHTML = html`<div class="empty">
      <div class="empty-icon">${icon('alert')}</div>
      <h3>Couldn't load your words</h3>
      <p>Open the app once while online so it can save the word list for offline use. (${e.message})</p>
      <button class="btn btn-primary" onclick="location.reload()">${icon('refresh')}Try again</button>
    </div>`.s;
    return false;
  }
  if (app.errors.length) app.toast(`Some decks failed to load: ${app.errors.join('; ')}`, { kind: 'error', duration: 8000 });
  return true;
}

// Most devices have one profile, so its language is loaded up front; another profile's loads when it signs in.
function startBase() {
  const bases = new Set(store.accounts.map(a => store.baseOf(a.id)));
  return bases.size === 1 ? [...bases][0] : bases.size ? 'cs' : guessBase();
}

async function start() {
  applyTheme();
  renderShell();
  registerServiceWorker();
  navigator.storage?.persist?.().catch(() => {});
  await initFolder().catch(() => {});
  if (!await loadContent(startBase())) return;
  startTranslating();
  window.addEventListener('hashchange', () => app.render());
  app.go('accounts', { replace: true });
}

start();
