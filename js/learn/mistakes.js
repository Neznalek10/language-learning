import { sentenceKey } from './answers.js';

// A mistake counts as learned after this many correct corrections in a row.
export const LEARNED_AFTER = 2;

const keyOf = (wrong, right) => `${sentenceKey(wrong)}>${sentenceKey(right)}`;

function hash(text) {
  let h = 5381;
  for (const ch of text) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(36);
}

export const idOf = (wrong, right) => `m${hash(keyOf(wrong, right))}`;
export const itemId = mistake => `mistake-${mistake.id}`;
export const mistakeFromItem = (list, id) => list.find(m => itemId(m) === id);
export const activeMistakes = list => list.filter(m => !m.done);

// Errors from an AI check or chat reply. Seeing the same mistake again reopens it.
// bump false is for a final check of a chat whose corrections were already saved one by one.
export function addMistakes(list, errors, { source, topic = '', now = Date.now(), bump = true }) {
  let added = 0;
  for (const e of errors) {
    if (!e.wrong || !e.right || keyOf(e.wrong, e.right).startsWith('>') || sentenceKey(e.wrong) === sentenceKey(e.right)) continue;
    const id = idOf(e.wrong, e.right);
    const existing = list.find(m => m.id === id);
    if (existing) {
      if (!bump) continue;
      existing.seen += 1;
      existing.last = now;
      existing.done = false;
      existing.streak = 0;
      existing.why = existing.why || e.why || '';
      existing.rule = existing.rule || e.rule || '';
      continue;
    }
    list.unshift({
      id, wrong: e.wrong, right: e.right, why: e.why || '', rule: e.rule || '',
      source, topic, first: now, last: now, seen: 1, streak: 0, done: false,
    });
    added++;
  }
  return added;
}

export function gradeMistake(list, id, ok, now = Date.now()) {
  const m = list.find(x => x.id === id);
  if (!m) return;
  m.last = now;
  m.streak = ok ? m.streak + 1 : 0;
  if (m.streak >= LEARNED_AFTER) m.done = true;
}

// The ones you keep making come first, then the most recent.
export function pickPractice(list, count = 10) {
  return activeMistakes(list).slice().sort((a, b) => b.seen - a.seen || b.last - a.last).slice(0, count);
}

// Rewrite the wrong phrase correctly: an ordinary "transform" exercise.
export const toItems = mistakes => mistakes.map(m => ({
  id: itemId(m), type: 'transform', task_en: 'Correct the mistake', fr: m.wrong, a: [m.right.replace(/[{}|]/g, '')], why: m.why,
}));

// Which grammar rules your mistakes point to most.
export function weakRules(list) {
  const counts = new Map();
  for (const m of activeMistakes(list)) if (m.rule) counts.set(m.rule, (counts.get(m.rule) || 0) + m.seen);
  return [...counts].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count);
}
