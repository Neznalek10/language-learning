const PREFIX = 'vocab.';
const memory = {};

const DEFAULT_SETTINGS = {
  direction: 'forward',
  strictAccents: false,
  sessionLength: 10,
  theme: 'system',
  conjTenses: ['present', 'passe-compose', 'imparfait', 'futur-simple'],
  conjDecks: null,
  conjVerbs: null,
  conjMode: 'single',
  conjLength: 10,
  grammarLevel: 'all',
  genLevel: 'A1',
  lastBackup: null,
  drill: { level: 'all', count: 10, mode: 'smart', hint: false },
  ai: { url: 'https://openrouter.ai/api/v1', key: '', model: 'openrouter/free' },
  write: { length: 'medium', strict: 'normal', feedback: 'en', hints: true },
  speak: { level: 'A1', minutes: 10, fix: 'end', feedback: 'en', speed: 'slow', free: 'talk' },
};

// Storage can be unavailable (private mode, blocked site data); the app then keeps state in memory.
function read(key, fallback) {
  try {
    const value = localStorage.getItem(PREFIX + key);
    if (value !== null) return JSON.parse(value);
  } catch { /* fall through to memory */ }
  return memory[key] ?? fallback;
}

function write(key, value) {
  memory[key] = value;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* memory copy still holds it */ }
}

function remove(key) {
  delete memory[key];
  try {
    localStorage.removeItem(PREFIX + key);
  } catch { /* nothing to remove */ }
}

const ACCOUNT_KEYS = ['progress', 'conj', 'learn', 'write', 'activity', 'imports', 'additions', 'settings', 'lang'];

// Lesson marks, test attempts, passed units, answers accepted with "I was right" and how each drill sentence went.
const emptyLearn = () => ({ lessons: {}, tests: {}, passed: {}, accepted: {}, drills: {} });

// Data saved before profiles existed moves into the first profile created on this device.
function adoptUnownedData(id) {
  for (const key of ACCOUNT_KEYS) {
    const value = read(key, undefined);
    if (value === undefined) continue;
    write(`${id}.${key}`, value);
    remove(key);
  }
}

// Per topic: the unsent draft, every score, and the latest text with its result. Plus the topics the AI made and the free chat in progress.
const emptyWrite = () => ({ topics: {}, custom: { write: [], speak: [] }, chat: null, mistakes: [], spoken: [] });

export const store = {
  accounts: read('accounts', []),
  account: null,
  progress: {},
  conj: {},
  learn: emptyLearn(),
  write: emptyWrite(),
  activity: {},
  imports: [],
  additions: {},
  settings: { ...DEFAULT_SETTINGS },
  lang: null,

  createAccount(name) {
    const account = { id: `a${Date.now().toString(36)}`, name, created: Date.now() };
    if (!this.accounts.length) adoptUnownedData(account.id);
    this.accounts.push(account);
    write('accounts', this.accounts);
    return account;
  },
  nameTaken(name) {
    return this.accounts.some(a => a.name.toLowerCase() === name.toLowerCase());
  },
  useAccount(id) {
    this.account = this.accounts.find(a => a.id === id);
    const key = k => `${id}.${k}`;
    this.progress = read(key('progress'), {});
    this.conj = read(key('conj'), {});
    this.learn = { ...emptyLearn(), ...read(key('learn'), {}) };
    this.write = { ...emptyWrite(), ...read(key('write'), {}) };
    this.activity = read(key('activity'), {});
    this.imports = read(key('imports'), []);
    this.additions = read(key('additions'), {});
    this.settings = { ...DEFAULT_SETTINGS, ...read(key('settings'), {}) };
    this.lang = read(key('lang'), null);
  },
  // A backup always becomes a new profile, so nothing that already exists is overwritten.
  restoreAccount(name, data) {
    const account = this.createAccount(name);
    for (const key of ACCOUNT_KEYS) {
      if (data[key] !== undefined) write(`${account.id}.${key}`, data[key]);
    }
    return account;
  },
  signOut() {
    this.account = null;
    this.settings = { ...DEFAULT_SETTINGS };
  },
  save(key) {
    write(`${this.account.id}.${key}`, this[key]);
  },
};

export function dayKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function logAnswer(lang, ok, delta = 1) {
  const day = (store.activity[dayKey()] ??= {});
  const entry = (day[lang] ??= [0, 0]);
  entry[0] += delta;
  entry[1] += ok ? 1 : 0;
  store.save('activity');
}

export function activityOn(key, lang) {
  const day = store.activity[key] || {};
  const langs = lang ? [lang] : Object.keys(day);
  return langs.reduce((sum, l) => {
    const [n, c] = day[l] || [0, 0];
    return { answers: sum.answers + n, correct: sum.correct + c };
  }, { answers: 0, correct: 0 });
}

export function lastDays(n, lang) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    days.push({ date, ...activityOn(dayKey(date), lang) });
  }
  return days;
}

export function streak() {
  const date = new Date();
  if (!activityOn(dayKey(date)).answers) date.setDate(date.getDate() - 1);
  let count = 0;
  while (activityOn(dayKey(date)).answers) {
    count++;
    date.setDate(date.getDate() - 1);
  }
  return count;
}
