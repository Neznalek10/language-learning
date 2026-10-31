import { conjVerbs } from './conj.js';

export const unitLabel = id => (/^\d+(\.\d+)?$/.test(id) ? `Unit ${id}` : id);

// Units come from the words (and verbs) that name them, plus optional unit details in words.json.
export function collectUnits(app, lang = app.lang) {
  const meta = app.unitMeta[lang] || {};
  const tenseKeys = new Set((app.conj[lang]?.tenses || []).map(t => t.key));
  const units = new Map();
  const unit = id => {
    if (!units.has(id)) {
      const info = meta[id] || {};
      units.set(id, { id, title: info.title || '', tenses: (info.tenses || []).filter(t => tenseKeys.has(t)), words: [], verbs: [] });
    }
    return units.get(id);
  };
  Object.keys(meta).forEach(id => unit(String(id)));
  for (const deck of app.decksFor(lang)) {
    for (const word of deck.words) {
      if (word.unit) (deck.type === 'verbs' ? unit(word.unit).verbs : unit(word.unit).words).push(word);
    }
  }
  return [...units.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

// Tenses are drilled with the unit's own verbs, or with every verb when the unit has none.
export function unitConjVerbs(app, unit) {
  const all = conjVerbs(app);
  const own = new Set(unit.verbs.map(w => w.a[0]));
  const mine = all.filter(v => own.has(v.inf));
  return mine.length ? mine : all;
}
