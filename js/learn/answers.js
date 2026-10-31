import { check, normalize, distance, stripAccents } from '../check.js';
import { html } from '../ui.js';

const MAX_VARIANTS = 200;

// "{Je m'appelle|Mon nom est} Hugo." -> both sentences. "{|très }bien" makes a part optional.
export function expand(pattern) {
  let out = [''];
  for (const part of String(pattern).split(/(\{[^{}]*\})/)) {
    const options = /^\{.*\}$/.test(part) ? part.slice(1, -1).split('|') : [part];
    out = out.flatMap(prefix => options.map(o => prefix + o)).slice(0, MAX_VARIANTS);
  }
  return out.map(s => s.replace(/\s+/g, ' ').trim());
}

// "J'allais [à Paris]." -> plain text for logic and parts for showing the marked words underlined.
export function splitMarks(text) {
  const parts = String(text).split(/(\[[^\]]*\])/).filter(Boolean).map(t => (t.startsWith('[') && t.endsWith(']') ? { t: t.slice(1, -1), mark: true } : { t }));
  return { text: parts.map(p => p.t).join(''), parts: parts.some(p => p.mark) ? parts : null };
}

export const expandAll = patterns => [...new Set(patterns.flatMap(expand))];

// Capitals, commas and end punctuation don't count, and "ça va?" equals "ça va ?".
export function sentenceKey(text) {
  return normalize(text)
    .replace(/[«»"“”]/g, '')
    .replace(/\s*[,;:!?.…]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function closest(given, answers) {
  const g = stripAccents(sentenceKey(given));
  let best = answers[0];
  let bestDistance = Infinity;
  for (const a of answers) {
    const d = distance(g, stripAccents(sentenceKey(a)));
    if (d < bestDistance) [best, bestDistance] = [a, d];
  }
  return best;
}

export function checkSentence(input, answers, settings) {
  const keys = answers.map(sentenceKey);
  const result = check(sentenceKey(input), keys, settings);
  const expected = result.kind === 'wrong' ? closest(input, answers) : answers[keys.indexOf(result.expected)] ?? answers[0];
  return { ...result, expected };
}

const words = text => text.split(/\s+/).filter(Boolean);
const wordKey = w => sentenceKey(w);

// The expected sentence with every word you didn't write highlighted.
export function markedWords(given, expected) {
  const a = words(given).map(wordKey);
  const b = words(expected);
  const bk = b.map(wordKey);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === bk[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched = new Array(b.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === bk[j]) {
      matched[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return html`${b.map((w, j) => html`${j ? ' ' : ''}${matched[j] || !bk[j] ? w : html`<mark>${w}</mark>`}`)}`;
}
