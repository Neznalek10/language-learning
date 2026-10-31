import { store } from './store.js';
import { requirementsOf } from './learn/writing.js';

export const DEFAULT_AI = { url: 'https://openrouter.ai/api/v1', key: '', model: 'openrouter/free' };
export const aiSettings = () => ({ ...DEFAULT_AI, ...store.settings.ai });

const TIMEOUT_MS = 90000;
const WEIGHTS = { task: 0.3, grammar: 0.3, vocabulary: 0.2, naturalness: 0.2 };
export const CRITERIA = [
  { key: 'task', label: 'Task' },
  { key: 'grammar', label: 'Grammar' },
  { key: 'vocabulary', label: 'Vocabulary' },
  { key: 'naturalness', label: 'Natural French' },
];
export const BANDS = [
  { min: 85, label: 'Excellent', tone: 'good' },
  { min: 70, label: 'Good', tone: 'good' },
  { min: 50, label: 'Getting there', tone: 'warn' },
  { min: 0, label: 'Needs work', tone: 'bad' },
];

export class AiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// OpenRouter needs a key; a local server such as Ollama does not.
export const aiReady = ai => !!(ai?.url && ai?.model && (ai.key || !/openrouter\.ai/i.test(ai.url)));

export const wordCount = text => (String(text).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;

const prompts = {};
export async function loadPrompt(name = 'check-write') {
  if (prompts[name]) return prompts[name];
  const res = await fetch(`./prompts/${name}.md`, { cache: 'no-cache' });
  if (!res.ok) throw new AiError('format', `Could not load the AI instructions (HTTP ${res.status}).`);
  prompts[name] = await res.text();
  return prompts[name];
}

// One OpenAI-compatible call: works with OpenRouter, Ollama and LM Studio.
export async function chat(ai, messages, { timeout = TIMEOUT_MS, fetcher = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetcher(`${ai.url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ai.key ? { Authorization: `Bearer ${ai.key}` } : {}) },
      body: JSON.stringify({ model: ai.model, messages, temperature: 0.2 }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new AiError('network', e.name === 'AbortError' ? 'The AI took too long to answer.' : 'Could not reach the AI. Check your connection and the address in Settings.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''));
  const data = await res.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new AiError('format', data?.error?.message || 'The AI sent back an empty answer.');
  return text;
}

export function httpError(status, body = '') {
  if (status === 401 || status === 403) return new AiError('auth', 'The AI refused the key. Check it in Settings.');
  if (status === 402) return new AiError('limit', 'This model needs credit on your OpenRouter account. Pick a free model in Settings.');
  if (status === 404) return new AiError('http', 'The AI could not find this model. Check the model name in Settings.');
  if (status === 429) return new AiError('limit', 'The AI is busy or your free checks for today are used up. Try again in a minute, or change the model in Settings.');
  const detail = String(body).replace(/\s+/g, ' ').slice(0, 140);
  return new AiError('http', `The AI answered with an error (${status}).${detail ? ` ${detail}` : ''}`);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const str = v => (typeof v === 'string' ? v.trim() : '');

// Models wrap JSON in fences or chatter; take the outermost braces.
export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('format', 'The AI did not answer in the expected form.');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AiError('format', 'The AI did not answer in the expected form.');
  }
}

// Turns the AI's JSON into a result the views can trust: clamped scores, known rule ids, quotes that really occur in the text.
export function parseCheck(raw, { text, requirements, ruleIds }) {
  const data = typeof raw === 'string' ? extractJson(raw) : raw;
  const c = data?.criteria;
  if (!c || typeof c !== 'object') throw new AiError('format', 'The AI answer had no scores.');
  const criteria = {};
  for (const { key } of CRITERIA) {
    const n = Number(c[key]);
    if (!Number.isFinite(n)) throw new AiError('format', `The AI answer had no score for ${key}.`);
    criteria[key] = Math.round(clamp(n, 0, 10) * 10) / 10;
  }
  const known = new Set(ruleIds);
  const inText = piece => !!piece && text.toLowerCase().includes(piece.toLowerCase());
  const given = new Map((Array.isArray(data.requirements) ? data.requirements : []).map(r => [Number(r?.n), r]));
  const checked = requirements.map((item, i) => {
    const r = given.get(i + 1);
    return { item, met: r ? r.met === true : false, note: str(r?.note) };
  });
  const errors = (Array.isArray(data.errors) ? data.errors : [])
    .map(e => ({ wrong: str(e?.wrong), right: str(e?.right), why: str(e?.why), rule: known.has(e?.rule) ? e.rule : '' }))
    .filter(e => e.wrong && e.right && e.wrong !== e.right && inText(e.wrong))
    .slice(0, 8);
  const better = (Array.isArray(data.better) ? data.better : [])
    .map(b => ({ original: str(b?.original), suggestion: str(b?.suggestion), why: str(b?.why) }))
    .filter(b => b.original && b.suggestion && b.original !== b.suggestion && inText(b.original))
    .slice(0, 5);
  const rules = [...new Set([...(Array.isArray(data.rules) ? data.rules : []), ...errors.map(e => e.rule)])].filter(id => known.has(id)).slice(0, 4);
  return {
    criteria, requirements: checked, errors, better, rules,
    corrected: str(data.corrected) || text,
    verdict: str(data.verdict),
  };
}

export function scoreOf(criteria) {
  const total = CRITERIA.reduce((sum, { key }) => sum + (criteria[key] / 10) * WEIGHTS[key], 0);
  return Math.round(total * 100);
}

export const bandOf = score => BANDS.find(b => score >= b.min);

export function buildMessages(system, { topic, text, opts, range, rules }) {
  const request = {
    level: opts.level,
    strictness: opts.strict,
    feedbackLanguage: { en: 'English', cs: 'Czech', fr: 'French' }[opts.feedback] || 'English',
    task: topic.task,
    requirements: requirementsOf(topic, opts).map((item, i) => `${i + 1}. ${item}`),
    targetWords: range,
    wordCount: wordCount(text),
    text,
    grammarRules: rules,
  };
  return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(request) }];
}

// Free models fail now and then with broken JSON, so a bad answer gets one more try.
export async function checkWriting(ai, input, { fetcher } = {}) {
  const system = await loadPrompt();
  const messages = buildMessages(system, input);
  const ruleIds = input.rules.map(r => r.id);
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(ai, messages, { fetcher });
    try {
      return parseCheck(raw, { text: input.text, requirements: requirementsOf(input.topic, input.opts), ruleIds });
    } catch (e) {
      if (!(e instanceof AiError) || e.kind !== 'format') throw e;
      last = e;
    }
  }
  throw last;
}

// One JSON answer with a retry on broken output: used by everything that is not the essay check.
export async function askJson(ai, messages, validate, { fetcher } = {}) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(ai, messages, { fetcher });
    try {
      return validate(extractJson(raw));
    } catch (e) {
      if (!(e instanceof AiError) || e.kind !== 'format') throw e;
      last = e;
    }
  }
  throw last;
}
