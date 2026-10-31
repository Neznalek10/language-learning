import { shuffle } from '../srs.js';
import { searchKey } from './grammar.js';

export const LEVELS = ['A1', 'A2', 'B1'];
const rank = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
export const DRILL_COUNTS = [10, 20, 30];
export const DRILL_MODES = [
  { value: 'smart', label: 'Smart mix' },
  { value: 'mistakes', label: 'My mistakes' },
  { value: 'random', label: 'Random' },
];

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// words.json "drills": {"fr": "courses/fr/drills.json"}; the index lists one file per set of sentences.
export async function loadDrills(paths) {
  const drills = {};
  const errors = [];
  await Promise.all(Object.entries(paths).map(async ([lang, path]) => {
    const dir = path.replace(/[^/]*$/, '');
    try {
      const index = await fetchJson(`./${path}`);
      const sets = (await Promise.all(index.sets.map(async meta => {
        try {
          return buildSet({ ...meta, ...(await fetchJson(`./${dir}${meta.file}`)), id: meta.id });
        } catch (e) {
          errors.push(`${dir}${meta.file}: ${e.message}`);
          return null;
        }
      }))).filter(Boolean);
      drills[lang] = { ...index, sets, byId: new Map(sets.map(s => [s.id, s])) };
    } catch (e) {
      errors.push(`${path}: ${e.message}`);
    }
  }));
  return { drills, errors };
}

// words.json "translate": {"fr": "courses/fr/translate.json"}: Czech sentences to put into French.
export async function loadTranslate(paths) {
  const translate = {};
  const errors = [];
  await Promise.all(Object.entries(paths).map(async ([lang, path]) => {
    try {
      const raw = await fetchJson(`./${path}`);
      translate[lang] = raw.items.map(item => ({ ...item, type: 'build', source: 'bank' }));
    } catch (e) {
      errors.push(`${path}: ${e.message}`);
    }
  }));
  return { translate, errors };
}

export function buildSet(raw) {
  const type = raw.type || 'transform';
  const items = raw.items.map(item => ({ type, ...item, why: item.why ?? raw.why?.[item.tag], set: raw.id }));
  return { ...raw, type, items };
}

const topUnit = unit => (unit ? String(unit).split('.')[0] : '');

// Every sentence you can translate: the new bank plus the translating exercises that sit in the unit lessons.
export function translateBank(bank, parts) {
  const fromUnits = parts.flatMap(part => part.lessons.flatMap(lesson => (lesson.practice || [])
    .filter(item => item.type === 'build')
    .map(item => ({
      ...item, level: part.level || 'A1', unit: part.id, tags: [], topics: lesson.topics || [], source: 'unit',
    }))));
  const seen = new Set();
  return [...fromUnits, ...(bank || [])].filter(item => !seen.has(item.id) && seen.add(item.id));
}

export const levelWithin = (item, level) => level === 'all' || !level || rank[item.level] <= rank[level];

// Level is "up to": A2 includes A1. Unit is the unit number ("none" for sentences with no unit). Tag is a pronoun type, a grammar article...
export function filterDrill(items, { level = 'all', unit = 'all', tag = 'all', query = '' } = {}) {
  const terms = searchKey(query).split(' ').filter(Boolean);
  return items.filter(item => levelWithin(item, level)
    && (unit === 'all' || (unit === 'none' ? !item.unit : topUnit(item.unit) === String(unit)))
    && (tag === 'all' || item.tag === tag || item.tags?.includes(tag))
    && (!terms.length || terms.every(t => searchKey(`${item.cs || ''} ${item.fr || ''} ${(item.a || [])[0] || ''}`).includes(t))));
}

export function recordDrill(progress, id, ok, now = Date.now()) {
  const p = (progress[id] ??= { r: 0, w: 0 });
  if (ok) p.r += 1;
  else p.w += 1;
  p.ok = ok;
  p.last = now;
}

export function drillStats(items, progress) {
  let seen = 0;
  let right = 0;
  let wrong = 0;
  let mistakes = 0;
  for (const item of items) {
    const p = progress[item.id];
    if (!p) continue;
    seen++;
    right += p.r;
    wrong += p.w;
    if (p.ok === false) mistakes++;
  }
  return { total: items.length, seen, right, wrong, mistakes };
}

const accuracy = p => (p.r + p.w ? p.r / (p.r + p.w) : 0);

// "smart": mostly sentences you never saw, with your recent mistakes mixed in, then the ones you know least.
export function pickDrill(items, progress, { mode = 'smart', count = 10, rand = Math.random } = {}) {
  const n = Number(count) || items.length;
  if (mode === 'random') return shuffle(items, rand).slice(0, n);
  if (mode === 'mistakes') return shuffle(items.filter(i => progress[i.id]?.ok === false), rand).slice(0, n);
  const unseen = shuffle(items.filter(i => !progress[i.id]), rand);
  const wrong = items.filter(i => progress[i.id]?.ok === false).sort((a, b) => progress[a.id].last - progress[b.id].last);
  const known = items.filter(i => progress[i.id] && progress[i.id].ok !== false)
    .sort((a, b) => accuracy(progress[a.id]) - accuracy(progress[b.id]) || progress[a.id].last - progress[b.id].last);
  const picked = wrong.slice(0, Math.ceil(n * 0.4));
  for (const pool of [unseen, known, wrong.slice(picked.length)]) {
    for (const item of pool) {
      if (picked.length >= n) break;
      picked.push(item);
    }
  }
  return shuffle(picked, rand);
}

// The exercise items for a session. With hints on, an item shows its own hint or its type ("y: places and à + thing").
export function sessionItems(items, set, { hint = false } = {}) {
  return items.map(item => ({ ...item, hint: hint ? item.hint || (item.tag && set?.tags?.[item.tag]) || undefined : undefined }));
}
