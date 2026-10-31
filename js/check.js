const LIGATURES = { 'œ': 'oe', 'æ': 'ae', 'ß': 'ss' };
const UMLAUTS = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue' };

export function normalize(text) {
  return String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?…]+$/, '')
    .trim();
}

export function stripAccents(text) {
  return text
    .replace(/[œæß]/g, c => LIGATURES[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC');
}

export function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = saved;
    }
  }
  return row[b.length];
}

// "jít, jet" or "kdo (který)" as an expected answer also accepts "jít", "jet", "kdo".
export function variants(text) {
  const bare = text.replace(/\s*\([^)]*\)/g, '').trim();
  const parts = bare.split(/\s*[,/]\s*/).filter(Boolean);
  return [...new Set([text, bare, ...parts])];
}

// kind: exact | accent (only diacritics differ) | typo (one letter off) | wrong
export function check(input, answers, { strictAccents = false } = {}) {
  const given = normalize(input);
  const targets = answers.map(normalize);
  const result = (kind, i, ok) => ({ kind, ok, expected: answers[i] });

  const exact = targets.indexOf(given);
  if (given && exact >= 0) return result('exact', exact, true);

  // Typing "gruen" for "grün" is the usual German fallback, so it counts like a missing accent.
  const bare = stripAccents(given);
  const accent = targets.findIndex(t => stripAccents(t) === bare || stripAccents(t.replace(/[äöü]/g, c => UMLAUTS[c])) === bare);
  if (given && accent >= 0) return result('accent', accent, !strictAccents);

  const typo = targets.findIndex(t => t.length >= 5 && distance(stripAccents(t), bare) === 1);
  if (given && typo >= 0) return result('typo', typo, false);

  return result('wrong', 0, false);
}
