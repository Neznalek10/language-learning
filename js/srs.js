// A word's level is its streak of correct answers in a row (0-5). A wrong answer resets it.
export const MAX_STREAK = 5;
const DAY = 864e5;
const INTERVAL_DAYS = [0, 1, 2, 4, 7, 14];

export const LEVELS = [
  { key: 'new', label: 'New', hint: 'Not practiced yet' },
  { key: 'learning', label: 'Learning', hint: '0–2 correct in a row' },
  { key: 'familiar', label: 'Familiar', hint: '3–4 correct in a row' },
  { key: 'mastered', label: 'Mastered', hint: '5 correct in a row' },
];

export const MODES = [
  { key: 'smart', label: 'Smart', hint: 'Due words first, then new ones' },
  { key: 'new', label: 'New' },
  { key: 'learning', label: 'Learning' },
  { key: 'familiar', label: 'Familiar' },
  { key: 'mastered', label: 'Mastered' },
  { key: 'mistakes', label: 'Mistakes', hint: 'Wrong last time' },
  { key: 'all', label: 'All words' },
];

export function levelOf(p) {
  if (!p) return 'new';
  if (p.streak >= MAX_STREAK) return 'mastered';
  if (p.streak >= 3) return 'familiar';
  return 'learning';
}

export function record(p, ok, now = Date.now()) {
  const prev = p || { streak: 0, right: 0, wrong: 0 };
  const streak = ok ? Math.min(prev.streak + 1, MAX_STREAK) : 0;
  return {
    streak,
    right: prev.right + (ok ? 1 : 0),
    wrong: prev.wrong + (ok ? 0 : 1),
    lastOk: ok,
    last: now,
    due: now + INTERVAL_DAYS[streak] * DAY,
  };
}

export function summarize(words, progress, now = Date.now()) {
  const s = { total: words.length, due: 0, mistakes: 0, right: 0, wrong: 0, levels: { new: 0, learning: 0, familiar: 0, mastered: 0 } };
  for (const w of words) {
    const p = progress[w.id];
    s.levels[levelOf(p)]++;
    if (!p) continue;
    if (p.due <= now) s.due++;
    if (!p.lastOk) s.mistakes++;
    s.right += p.right;
    s.wrong += p.wrong;
  }
  return s;
}

export function countFor(mode, summary) {
  if (mode === 'smart' || mode === 'all') return summary.total;
  if (mode === 'mistakes') return summary.mistakes;
  return summary.levels[mode];
}

export function shuffle(list, rand = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pickSession(words, progress, { mode = 'smart', count = 10, now = Date.now(), rand = Math.random } = {}) {
  const entries = words.map(w => ({ w, p: progress[w.id] }));
  let chosen;
  if (mode === 'smart') {
    const due = entries.filter(e => e.p && e.p.due <= now).sort((a, b) => a.p.streak - b.p.streak || a.p.due - b.p.due);
    const fresh = entries.filter(e => !e.p);
    const ahead = entries.filter(e => e.p && e.p.due > now).sort((a, b) => a.p.due - b.p.due);
    chosen = [...due, ...fresh, ...ahead].slice(0, count);
  } else if (mode === 'mistakes') {
    chosen = entries.filter(e => e.p && !e.p.lastOk).sort((a, b) => b.p.wrong - a.p.wrong).slice(0, count);
  } else if (mode === 'all') {
    chosen = shuffle(entries, rand).slice(0, count);
  } else {
    chosen = shuffle(entries.filter(e => levelOf(e.p) === mode), rand).slice(0, count);
  }
  return shuffle(chosen, rand).map(e => e.w);
}
