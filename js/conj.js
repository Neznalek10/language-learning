import { check, normalize } from './check.js';

const VOWEL = /^[aeiouyhâàäéèêëîïôöûùüœ]/i;
const SUBJECT = /^(?:que\s+|qu')?(?:je\s+|j'|tu\s+|il\s+|elle\s+|on\s+|nous\s+|vous\s+|ils\s+|elles\s+)/;
const RANK = { exact: 3, accent: 2, typo: 1, wrong: 0 };

export const stripSubject = text => normalize(text).replace(SUBJECT, '');

export async function loadConjugations(paths) {
  const out = {};
  await Promise.all(Object.entries(paths).map(async ([lang, path]) => {
    try {
      const res = await fetch(`./${path}`, { cache: 'no-cache' });
      if (res.ok) out[lang] = await res.json();
    } catch { /* tenses stay unavailable for this language */ }
  }));
  return out;
}

// Every verb from the language's verb decks that has conjugation tables; its deck is its category.
export function conjVerbs(app, lang = app.lang) {
  const data = app.conj[lang];
  if (!data) return [];
  const seen = new Set();
  const verbs = [];
  for (const deck of app.decksFor(lang).filter(d => d.type === 'verbs')) {
    for (const word of deck.words) {
      const inf = word.a[0];
      if (!data.verbs[inf] || seen.has(inf)) continue;
      seen.add(inf);
      verbs.push({ inf, meaning: word.q, deck, data: data.verbs[inf] });
    }
  }
  return verbs;
}

export const comboKey = (lang, inf, tense) => `${lang}:${inf}:${tense}`;

export function persons(verb, tense) {
  const cells = verb.data.t[tense] || [];
  return cells.flatMap((c, i) => (c ? [i] : []));
}

export function combos(lang, verbs, tenses) {
  return verbs.flatMap(verb => tenses
    .filter(t => verb.data.t[t])
    .map(tense => ({ id: comboKey(lang, verb.inf, tense), verb, tense })));
}

export function personLabel(data, tense, i) {
  const p = data.persons[i];
  if (tense.startsWith('imperatif')) return `(${p})`;
  if (tense.startsWith('subjonctif')) return /^[aeiouy]/.test(p) ? `qu'${p}` : `que ${p}`;
  return p;
}

// "suis allé" + "suis allée" -> "suis allé(e)"
export function compact(forms) {
  if (forms.length === 2) {
    const [m, f] = forms;
    if (f === `${m}e`) return `${m}(e)`;
    if (m.endsWith('s') && f === `${m.slice(0, -1)}es`) return `${m.slice(0, -1)}(e)s`;
  }
  return forms.join(' / ');
}

export function subjectPrefix(data, tense, i, form) {
  if (tense.startsWith('imperatif')) return '';
  const pronoun = data.persons[i].split('/')[0];
  let prefix = pronoun === 'je' && VOWEL.test(form) ? "j'" : `${pronoun} `;
  if (tense.startsWith('subjonctif')) prefix = /^[aeiouy]/.test(prefix) ? `qu'${prefix}` : `que ${prefix}`;
  return prefix;
}

// Accepts the form with or without its subject ("parlons", "nous parlons", "que nous parlions").
export function checkForm(input, forms, settings) {
  const raw = normalize(input);
  const stripped = raw.replace(SUBJECT, '');
  const plain = check(raw, forms, settings);
  if (stripped === raw || !stripped) return plain;
  const bare = check(stripped, forms, settings);
  return RANK[bare.kind] > RANK[plain.kind] ? bare : plain;
}

export function tenseInfo(data, key) {
  return data.tenses.find(t => t.key === key);
}
