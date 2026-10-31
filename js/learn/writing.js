import { searchKey } from './grammar.js';

export const LENGTHS = [
  { value: 'short', label: 'Short', min: 30, max: 60 },
  { value: 'medium', label: 'Medium', min: 60, max: 110 },
  { value: 'long', label: 'Long', min: 110, max: 180 },
];
export const lengthOf = value => LENGTHS.find(l => l.value === value) || LENGTHS[1];

// Pronouns the student can choose to practise in a text; each one picked becomes one more requirement.
export const PRONOUN_GROUPS = [
  { id: 'join', label: 'Join two sentences into one' },
  { id: 'replace', label: 'Avoid repeating a word' },
];
export const PRONOUNS = [
  { id: 'qui', label: 'qui', group: 'join', must: 'Join two sentences with qui', rule: 'relative-qui-que' },
  { id: 'que', label: 'que', group: 'join', must: 'Join two sentences with que', rule: 'relative-qui-que' },
  { id: 'ou', label: 'où', group: 'join', must: 'Join two sentences with où', rule: 'relative-ou-dont' },
  { id: 'dont', label: 'dont', group: 'join', must: 'Join two sentences with dont', rule: 'relative-ou-dont' },
  { id: 'ce-qui', label: 'ce qui, ce que', group: 'join', must: 'Use ce qui or ce que', rule: 'relative-ce' },
  { id: 'lequel', label: 'lequel, auquel', group: 'join', must: 'Join two sentences with a preposition + lequel (auquel, duquel ...)', rule: 'relative-compound' },
  { id: 'le', label: 'le, la, les', group: 'replace', must: 'Replace a repeated noun with le, la or les', rule: 'direct-object' },
  { id: 'lui', label: 'lui, leur', group: 'replace', must: 'Replace à + a person with lui or leur', rule: 'indirect-object' },
  { id: 'y', label: 'y', group: 'replace', must: 'Use y instead of repeating a place or à + a thing', rule: 'y' },
  { id: 'en', label: 'en', group: 'replace', must: 'Use en instead of repeating de + a thing or a quantity', rule: 'en' },
];
export const pickedPronouns = opts => PRONOUNS.filter(p => opts?.pronouns?.includes(p.id));
export const requirementsOf = (topic, opts) => [...topic.must, ...pickedPronouns(opts).map(p => p.must)];

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// words.json "writing": {"fr": "courses/fr/writing.json"}
export async function loadWriting(paths) {
  const writing = {};
  const errors = [];
  await Promise.all(Object.entries(paths).map(async ([lang, path]) => {
    try {
      writing[lang] = buildWriting(await fetchJson(`./${path}`));
    } catch (e) {
      errors.push(`${path}: ${e.message}`);
    }
  }));
  return { writing, errors };
}

export function buildWriting(raw) {
  const topics = raw.topics.map((t, index) => ({ ...t, index, search: searchKey([t.title, t.task, t.kind, t.level].join(' ')) }));
  return { ...raw, topics, byId: new Map(topics.map(t => [t.id, t])) };
}

export const kindLabel = (w, kind) => w.kinds?.[kind] || kind;

// Every set filter has to match; "free" is the topics that belong to no unit.
export function filterTopics(w, { level = 'all', unit = 'all', kind = 'all', query = '' } = {}) {
  const terms = searchKey(query).split(' ').filter(Boolean);
  return w.topics.filter(t => (level === 'all' || t.level === level)
    && (kind === 'all' || t.kind === kind)
    && (unit === 'all' || (unit === 'free' ? !t.unit : String(t.unit) === unit || String(t.unit).split('.')[0] === unit))
    && terms.every(term => t.search.includes(term)));
}

export const topicsForParts = (w, partIds) => (w ? w.topics.filter(t => t.unit && partIds.includes(String(t.unit))) : []);
export const topicsForRule = (w, ruleId) => (w ? w.topics.filter(t => t.grammar?.includes(ruleId)) : []);

export function pickRandom(list, rand = Math.random) {
  return list.length ? list[Math.floor(rand() * list.length)] : null;
}
