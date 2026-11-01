import { normalize } from './check.js';

const FLAGS = {
  cs: '🇨🇿', sk: '🇸🇰', fr: '🇫🇷', de: '🇩🇪', es: '🇪🇸', it: '🇮🇹', en: '🇬🇧', pt: '🇵🇹', ru: '🇷🇺',
  pl: '🇵🇱', uk: '🇺🇦', nl: '🇳🇱', sv: '🇸🇪', ja: '🇯🇵', zh: '🇨🇳', ko: '🇰🇷',
};
export const COMMON_LANGS = ['fr', 'de', 'es', 'it', 'en', 'pt', 'ru', 'pl', 'nl', 'sv', 'uk', 'ja', 'zh', 'ko', 'cs', 'sk'];

export const ACCENTS = {
  fr: 'é è ê ë à â ç î ï ô ù û œ',
  de: 'ä ö ü ß',
  es: 'á é í ó ú ñ ü ¿ ¡',
  it: 'à è é ì ò ù',
  pt: 'á â ã à ç é ê í ó ô õ ú',
  cs: 'á č ď é ě í ň ó ř š ť ú ů ý ž',
  sk: 'á ä č ď é í ľ ĺ ň ó ô ŕ š ť ú ý ž',
  pl: 'ą ć ę ł ń ó ś ź ż',
};

export const TYPES = [
  { key: 'verbs', label: 'Verbs' },
  { key: 'adjectives', label: 'Adjectives' },
  { key: 'nouns', label: 'Nouns' },
  { key: 'phrases', label: 'Phrases' },
  { key: 'topics', label: 'Topics' },
  { key: 'other', label: 'Other' },
];

export const DIFFICULTIES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

// Item types the "Add a word" form can create. A new kind of item (e.g. grammar) is one more entry here.
export const ITEM_TYPES = [
  {
    key: 'word',
    label: 'Word',
    icon: 'words',
    hint: 'Vocabulary: a word or phrase and its translations',
    prompt: { label: 'Word in', placeholder: 'e.g. pes' },
    answers: { label: 'Correct answers in', placeholder: 'e.g. le chien' },
    fitsDeck: deck => deck.type !== 'verbs',
    newDeck: { type: 'topics', title: 'My words' },
  },
  {
    key: 'verb',
    label: 'Verb',
    icon: 'tenses',
    hint: 'An infinitive and its meaning. Also used in Tenses practice',
    prompt: { label: 'Meaning in', placeholder: 'e.g. mluvit' },
    answers: { label: 'Infinitive in', placeholder: 'e.g. parler' },
    fitsDeck: deck => deck.type === 'verbs',
    newDeck: { type: 'verbs', title: 'My verbs' },
  },
];

const NO_UNIT = new Set(['', '0', 'none', 'no', 'null']);
export function unitKey(value) {
  if (value == null) return null;
  const key = String(value).trim();
  return NO_UNIT.has(key.toLowerCase()) ? null : key;
}

export function levelKey(value) {
  const key = String(value ?? '').trim().toUpperCase();
  return DIFFICULTIES.includes(key) ? key : null;
}

// The language the learner already speaks: word prompts, lessons and drills come in it. Menus stay English.
export const BASES = {
  cs: { name: 'Čeština', manifest: 'words.json' },
  en: { name: 'English', manifest: 'en/words.json' },
};
export const guessBase = () => (/^(cs|sk)\b/i.test(navigator.language || '') ? 'cs' : 'en');
let base = 'cs';
let promptDir = 'prompts/';
export const baseLang = () => base;
export const promptUrl = name => `./${promptDir}${name}.md`;
export const feedbackOptions = () => [
  { value: 'en', label: 'English' },
  ...(base === 'cs' ? [{ value: 'cs', label: 'Czech' }] : []),
  { value: 'fr', label: 'French' },
];

let languageMeta = {};
const displayNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;

export function langName(code) {
  if (languageMeta[code]?.name) return languageMeta[code].name;
  try {
    return displayNames?.of(code) || code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export const langFlag = code => languageMeta[code]?.flag || FLAGS[code] || '🌐';

export function typeLabel(key) {
  return TYPES.find(t => t.key === key)?.label || key.charAt(0).toUpperCase() + key.slice(1);
}

export const slug = text => normalize(text).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck';

const langCode = value => String(value).trim().toLowerCase();
const toList = value => (Array.isArray(value) ? value : [value]).map(v => String(v ?? '').trim()).filter(Boolean);

// Accepts {q, a}, the v1 {question, answer} shape, or {prompt, answers}; merges duplicate prompts.
export function cleanWords(list) {
  const byKey = new Map();
  let duplicates = 0;
  let skipped = 0;
  for (const entry of list) {
    const q = String(entry?.q ?? entry?.question ?? entry?.prompt ?? '').trim();
    const a = toList(entry?.a ?? entry?.answer ?? entry?.answers);
    if (!q || !a.length) {
      skipped++;
      continue;
    }
    const key = normalize(q);
    const existing = byKey.get(key);
    if (existing) {
      duplicates++;
      for (const ans of a) if (!existing.a.includes(ans)) existing.a.push(ans);
    } else {
      byKey.set(key, {
        q,
        a,
        ...(entry.note ? { note: String(entry.note) } : {}),
        ...(entry.why ? { why: String(entry.why) } : {}),
        ...('unit' in entry ? { unit: unitKey(entry.unit) } : {}),
        ...('level' in entry ? { level: levelKey(entry.level) } : {}),
      });
    }
  }
  return { words: [...byKey.values()], duplicates, skipped };
}

// "words/fr/food.json" and "en/words/fr/food.json" are both "fr/food", so the course finds its words in either.
export function deckIdFromPath(path) {
  return path.replace(/^(\.\/)?([a-z]{2}\/(?=words\/))?(words\/)?/, '').replace(/\.json$/i, '');
}

export function buildDeck(raw, id, local, additions = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected a deck object');
  if (!raw.lang) throw new Error('missing "lang"');
  const deck = {
    id,
    local,
    lang: langCode(raw.lang),
    from: langCode(raw.from || base),
    type: langCode(raw.type || 'other'),
    title: String(raw.title || id),
    unit: unitKey(raw.unit),
    level: levelKey(raw.level),
  };
  deck.words = cleanWords([...(raw.words || []), ...additions]).words.map(w => ({
    ...w,
    unit: 'unit' in w ? w.unit : deck.unit,
    level: 'level' in w ? w.level : deck.level,
    id: `${id}#${normalize(w.q)}`,
    deck,
  }));
  return deck;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function loadLibrary(code) {
  const index = await fetchJson(`./${BASES[code].manifest}`);
  base = code;
  promptDir = index.prompts || 'prompts/';
  languageMeta = index.languages || {};
  const paths = [...new Set(index.decks || [])];
  const settled = await Promise.allSettled(paths.map(p => fetchJson(`./${p}`)));
  const sources = [];
  const errors = [];
  settled.forEach((r, i) => {
    try {
      if (r.status === 'rejected') throw r.reason;
      const id = deckIdFromPath(paths[i]);
      buildDeck(r.value, id, false);
      sources.push({ raw: r.value, id });
    } catch (e) {
      errors.push(`${paths[i]}: ${e.message}`);
    }
  });
  return {
    sources, errors, conjugations: index.conjugations || {}, units: index.units || {}, courses: index.courses || {}, grammar: index.grammar || {}, writing: index.writing || {}, speaking: index.speaking || {}, drills: index.drills || {}, translate: index.translate || {},
  };
}

// Repo decks plus this profile's imported decks, each with the words added on this device.
export function buildLibrary(sources, imports, additions) {
  const decks = sources.map(s => buildDeck(s.raw, s.id, false, additions[s.id]));
  const errors = [];
  for (const raw of imports) {
    try {
      decks.push(buildDeck(raw, raw.id, true, additions[raw.id]));
    } catch (e) {
      errors.push(`Imported "${raw.title}": ${e.message}`);
    }
  }
  return { decks, errors };
}

function guessLang(list) {
  const name = String(list.find(w => w?.language)?.language || '').toLowerCase();
  if (!name) return undefined;
  return COMMON_LANGS.find(code => langName(code).toLowerCase() === name) || undefined;
}

const titleFromFile = name => {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : undefined;
};

const SEPARATORS = ['\t', ';', ' = ', ' – ', ' — ', ' - ', ','];
const HEADER = /^(q|question|prompt|word|front|term)$/i;

function splitLine(line) {
  for (const sep of SEPARATORS) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    const q = line.slice(0, i).trim();
    const a = line.slice(i + sep.length).trim();
    if (q && a) return { q, a: a.split('|') };
  }
  return null;
}

export function parseImport(text, filename = '') {
  const empty = { meta: {}, words: [], duplicates: 0, skipped: 0 };
  const trimmed = text.trim();
  if (!trimmed) return empty;
  const fileTitle = filename ? titleFromFile(filename) : undefined;

  if (/^[[{]/.test(trimmed)) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      return { ...empty, error: `This looks like JSON but it can't be read: ${e.message}` };
    }
    const list = Array.isArray(data) ? data : data?.words;
    if (!Array.isArray(list)) return { ...empty, error: 'JSON must be a list of words, or an object with a "words" list.' };
    const meta = Array.isArray(data) ? {} : { lang: data.lang, from: data.from, type: data.type, title: data.title, unit: data.unit, level: data.level };
    meta.lang ??= guessLang(list);
    meta.title ??= fileTitle;
    return { meta, ...cleanWords(list) };
  }

  const rows = [];
  let skipped = 0;
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const row = splitLine(line);
    if (row) rows.push(row);
    else skipped++;
  }
  if (rows.length && HEADER.test(rows[0].q)) rows.shift();
  const result = cleanWords(rows);
  return { meta: { title: fileTitle }, ...result, skipped: result.skipped + skipped };
}

// Merges into an existing imported deck with the same language and title instead of creating a twin.
export function saveImport(imports, { lang, from, type, title, unit = null, level = null, words }) {
  const id = `local/${lang}/${slug(title)}`;
  const existing = imports.find(d => d.id === id);
  if (!existing) {
    imports.push({ id, lang, from, type, title, unit, level, words });
    return { id, added: words.length, merged: 0 };
  }
  const before = existing.words.length;
  const stamped = words.map(w => ({ unit, level, ...w }));
  const merged = cleanWords([...existing.words, ...stamped]);
  existing.words = merged.words;
  Object.assign(existing, { from, type });
  return { id, added: existing.words.length - before, merged: merged.duplicates };
}
