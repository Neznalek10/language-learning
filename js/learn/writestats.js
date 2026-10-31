import { activeMistakes } from './mistakes.js';

const RECENT = 10;
const CHART_BARS = 20;

// Every checked text across all topics, oldest first.
export function attemptsOf(write) {
  return Object.values(write?.topics || {})
    .flatMap(t => t.attempts || [])
    .sort((a, b) => a.at - b.at);
}

export function writingStats(write) {
  const attempts = attemptsOf(write);
  const recent = attempts.slice(-RECENT);
  return {
    texts: attempts.length,
    words: attempts.reduce((n, a) => n + (a.words || 0), 0),
    average: recent.length ? Math.round(recent.reduce((n, a) => n + a.score, 0) / recent.length) : null,
    best: attempts.length ? Math.max(...attempts.map(a => a.score)) : null,
    chart: attempts.slice(-CHART_BARS),
    openMistakes: activeMistakes(write?.mistakes || []).length,
    learnedMistakes: (write?.mistakes || []).filter(m => m.done).length,
    spoken: (write?.spoken || []).length,
  };
}
