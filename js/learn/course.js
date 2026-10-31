import { normalize } from '../check.js';
import { shuffle } from '../srs.js';
import { collectUnits } from '../units.js';
import { toQuestions } from './exercises/index.js';

export const PASS = 0.7;
const TEST_COUNT = 20;
const TEST_WORDS = 6;

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// words.json "courses": {"fr": "courses/fr/course.json"}. A unit is either split into "parts" (2.1, 2.2)
// or is a single part itself; a part with a "file" has lessons and a test. A level can have a final test.
export async function loadCourses(paths) {
  const courses = {};
  const errors = [];
  await Promise.all(Object.entries(paths).map(async ([lang, path]) => {
    const dir = path.replace(/[^/]*$/, '');
    const withFile = async meta => {
      if (!meta.file) return meta;
      try {
        return { ...meta, ...(await fetchJson(`./${dir}${meta.file}`)), id: meta.id };
      } catch (e) {
        errors.push(`${dir}${meta.file}: ${e.message}`);
        return meta;
      }
    };
    try {
      const course = await fetchJson(`./${path}`);
      course.units = await Promise.all((course.units || []).map(async meta => {
        const unit = { ...meta, id: String(meta.id) };
        const parts = meta.parts?.length ? meta.parts : [{ ...meta, parts: undefined }];
        unit.parts = await Promise.all(parts.map(p => withFile({ ...p, id: String(p.id), unitId: unit.id, level: p.level || unit.level })));
        return unit;
      }));
      const levels = await Promise.all(Object.entries(course.levels || {}).map(async ([key, level]) => [key, await withFile({ ...level, id: key })]));
      course.levels = Object.fromEntries(levels);
      courses[lang] = course;
    } catch (e) {
      errors.push(`${path}: ${e.message}`);
    }
  }));
  return { courses, errors };
}

const coursePartsOf = course => course.units.flatMap(u => u.parts);

// Course parts become unit details, so the Add form and word tags show their titles.
export function courseUnitMeta(courses) {
  const meta = {};
  for (const [lang, course] of Object.entries(courses)) {
    meta[lang] = Object.fromEntries(coursePartsOf(course).map(p => [p.id, { title: p.title, tenses: p.tenses || [] }]));
  }
  return meta;
}

// "greetings#dobrý den" -> the word with id "fr/greetings#dobrý den".
export const wordRef = (lang, ref) => {
  const [deck, ...prompt] = ref.split('#');
  return `${lang}/${deck}#${normalize(prompt.join('#'))}`;
};

// Every part in course order, plus any unit only words name. A part holds the lessons, the test and its words.
export function learnParts(app, lang = app.lang) {
  const course = app.courses[lang];
  const byId = new Map(collectUnits(app, lang).map(u => [u.id, u]));
  const declared = course ? coursePartsOf(course) : [];
  const known = new Set(declared.map(p => p.id));
  const extra = [...byId.keys()].filter(id => !known.has(id)).map(id => ({ id, unitId: id }));
  const words = new Map(app.wordsOf(app.decksFor(lang)).map(w => [w.id, w]));
  return [...declared, ...extra].map(meta => {
    const base = byId.get(meta.id) || { id: meta.id, title: '', tenses: [], words: [], verbs: [] };
    const lessons = (meta.lessons || []).map((lesson, i) => {
      const own = (lesson.words || []).map(ref => words.get(wordRef(lang, ref))).filter(Boolean);
      return { ...lesson, index: i, unitId: meta.id, words: own, items: (lesson.practice || []).map(item => ({ ...item, lesson: lesson.id })) };
    });
    return { ...meta, ...base, title: meta.title || base.title, lessons };
  });
}

// The units shown on the path: parts grouped under their unit (2.1 and 2.2 under 2).
export function learnGroups(app, lang = app.lang, parts = learnParts(app, lang)) {
  const course = app.courses[lang];
  const groups = new Map();
  for (const part of parts) {
    if (!groups.has(part.unitId)) {
      const meta = course?.units.find(u => u.id === part.unitId) || { id: part.unitId, title: part.title };
      groups.set(part.unitId, { id: meta.id, title: meta.title, subtitle: meta.subtitle, level: meta.level || part.level, parts: [] });
    }
    groups.get(part.unitId).parts.push(part);
  }
  return [...groups.values()];
}

export const hasTest = part => !!(part.lessons?.length && part.test?.pool?.length);
const practiced = (learn, lesson) => !!learn.lessons[lesson.id]?.practiced;

// Strict order: a lesson opens when the previous one is practiced, the test when every lesson is,
// and the next part when this part's test is passed. Passing a level's final test opens all of that level.
export function partStates(parts, learn) {
  const states = new Map();
  let previousDone = true;
  for (const part of parts) {
    if (!hasTest(part)) {
      states.set(part.id, { status: 'soon', lessons: [], test: false });
      continue;
    }
    const passed = !!learn.passed[part.id];
    const skipped = !passed && !!learn.passed[part.level];
    const free = passed || skipped;
    const open = free || previousDone;
    const lessons = part.lessons.map((l, i) => open && (free || i === 0 || practiced(learn, part.lessons[i - 1]) || practiced(learn, l)));
    const test = open && (free || part.lessons.every(l => practiced(learn, l)));
    states.set(part.id, { status: passed ? 'passed' : skipped ? 'skipped' : open ? 'open' : 'locked', lessons, test });
    previousDone = free;
  }
  return states;
}

export function groupStatus(group, states) {
  const all = group.parts.map(p => states.get(p.id).status).filter(s => s !== 'soon');
  if (!all.length) return 'soon';
  if (all.every(s => s === 'passed')) return 'passed';
  if (all.every(s => s === 'passed' || s === 'skipped')) return 'skipped';
  return all.some(s => s !== 'locked') ? 'open' : 'locked';
}

export function nextStep(parts, states, learn) {
  const part = parts.find(p => states.get(p.id).status === 'open');
  if (!part) return null;
  return { part, lesson: part.lessons.find(l => !practiced(learn, l)) || null };
}

// Topics only offer lessons you have reached.
export function topicsOf(app, learn, lang = app.lang) {
  const course = app.courses[lang];
  if (!course) return [];
  const parts = learnParts(app, lang);
  const states = partStates(parts, learn);
  return Object.entries(course.topics || {}).map(([id, t]) => {
    const lessons = parts.flatMap(part => part.lessons
      .filter(l => (l.topics || []).includes(id))
      .map(l => ({ unit: part, lesson: l, available: !!states.get(part.id).lessons[l.index] })));
    const open = lessons.filter(x => x.available);
    return {
      id, ...t, lessons, available: open.length > 0,
      items: open.flatMap(x => x.lesson.items), words: open.flatMap(x => x.lesson.words),
    };
  }).filter(t => t.lessons.length);
}

// A level's final test covers every part of the level; its score is broken down by part.
export function levelTest(app, key, lang = app.lang, parts = learnParts(app, lang)) {
  const level = app.courses[lang]?.levels?.[key];
  if (!level?.test?.pool?.length) return null;
  const own = parts.filter(p => p.level === key && hasTest(p));
  return {
    id: key, level: key, isLevel: true, title: level.title || `${key} final test`, subtitle: level.subtitle,
    test: level.test, lessons: [], words: [...new Set(own.flatMap(p => p.words))],
    labels: Object.fromEntries(own.map(p => [p.id, `${p.id} ${p.title}`])), order: own.map(p => p.id),
  };
}

export const questionsFor = (items, ctx) => items.flatMap(item => toQuestions(item, ctx));
export const wordItems = words => words.map(word => ({ type: 'word', word }));

// Lesson practice: its words first, then the exercises in the order they were written.
export function lessonQuestions(lesson, ctx) {
  return questionsFor([...wordItems(lesson.words), ...lesson.items], ctx);
}

// A mixed round from any topics: shuffled, capped, words and exercises together.
export function topicQuestions(topics, ctx, count = 20) {
  const items = [...new Set(topics.flatMap(t => t.items))];
  const words = [...new Set(topics.flatMap(t => t.words))];
  const questions = questionsFor([...wordItems(words), ...items], ctx);
  return shuffle(questions, ctx.rand).slice(0, count);
}

// Test questions come from the test pool, which practice never shows, plus the unit's words.
export function testQuestions(unit, ctx) {
  const rand = ctx.rand || Math.random;
  const count = unit.test.count || TEST_COUNT;
  const unitWords = [...new Set([...unit.lessons.flatMap(l => l.words), ...unit.words])];
  const words = shuffle(unitWords, rand).slice(0, Math.min(unit.test.words ?? TEST_WORDS, count));
  const pool = shuffle(unit.test.pool, rand).map(item => (item.type === 'form' && item.person == null ? { ...item, person: randomPerson(item, ctx, rand) } : item));
  const fromPool = questionsFor(pool, ctx).slice(0, count - words.length);
  return shuffle([...questionsFor(wordItems(words), ctx), ...fromPool], rand);
}

function randomPerson(item, ctx, rand) {
  const cells = ctx.conj?.verbs[item.verb]?.t[item.tense] || [];
  const options = cells.flatMap((c, i) => (c ? [i] : []));
  return options[Math.floor(rand() * options.length)] ?? 0;
}

export function grade(results, unit, pass = unit?.test?.pass ?? PASS) {
  const total = results.length;
  const correct = results.filter(r => r.ok).length;
  const score = total ? correct / total : 0;
  const parts = new Map();
  for (const r of results) {
    const key = r.question.lesson || 'words';
    const part = parts.get(key) || { key, total: 0, correct: 0 };
    part.total++;
    part.correct += r.ok ? 1 : 0;
    parts.set(key, part);
  }
  return { total, correct, score, passed: total > 0 && score >= pass, pass, parts: [...parts.values()] };
}

export function saveTest(learn, unit, result, now = Date.now()) {
  const attempts = (learn.tests[unit.id] ??= []);
  attempts.push({ at: now, correct: result.correct, total: result.total });
  if (result.passed && !learn.passed[unit.id]) learn.passed[unit.id] = now;
}

export function bestTest(learn, unitId) {
  const attempts = learn.tests[unitId] || [];
  return attempts.reduce((best, a) => Math.max(best, a.total ? a.correct / a.total : 0), attempts.length ? 0 : null);
}

export function saveLesson(learn, lessonId, change, now = Date.now()) {
  const entry = (learn.lessons[lessonId] ??= {});
  if (change.learned) entry.learned ??= now;
  if (change.score != null) {
    entry.practiced = now;
    entry.best = Math.max(entry.best ?? 0, change.score);
  }
}

// v1.7 numbered the French units 1 to 19; v1.8 gave A1 8 units, some split into parts.
const RENUMBER = {
  1: '1.1', 2: '1.2', 3: '2.1', 4: '2.2', 5: '3', 6: '4.1', 7: '4.2', 8: '5.1', 9: '5.2', 10: '6',
  11: '7', 12: '8', 13: '9', 14: '10', 15: '11', 16: '12', 17: '13', 18: '14', 19: '15',
};

// v1.14 packs the course into 9 units: A1 is units 1 to 5, A2 is units 6 to 8, and Mon avenir is unit 9 on its own.
const REPACK = {
  3: '2.3', 4.1: '3.1', 4.2: '3.2', 5.1: '4.1', 5.2: '4.2', 6: '4.3', 7: '5.1', 8: '5.2',
  9: '6.1', 10: '6.2', 11: '7.1', 12: '7.2', 13: '8.1', 14: '8.2', 15: '9',
};
const STEPS = [RENUMBER, REPACK];
export const LEARN_SCHEMA = STEPS.length + 1;
const moved = (id, from) => STEPS.slice(from - 1).reduce((x, map) => map[x] || x, String(id));

// Moves test attempts and passes to the current unit numbers once; nothing is dropped.
export function migrateLearn(learn) {
  const from = learn.schema || 1;
  if (from >= LEARN_SCHEMA) return false;
  for (const key of ['tests', 'passed']) {
    learn[key] = Object.fromEntries(Object.entries(learn[key] || {}).map(([id, value]) => [moved(id, from), value]));
  }
  learn.schema = LEARN_SCHEMA;
  return true;
}

// Words you added or imported carry a unit too; French ones follow the 1.14 repack. Run it with the learn schema read before migrateLearn.
export function repackWords(additions, imports, fromSchema) {
  if (fromSchema >= 3) return false;
  const fix = w => (w.unit != null && REPACK[w.unit] ? { ...w, unit: REPACK[w.unit] } : w);
  let changed = false;
  for (const [deckId, words] of Object.entries(additions || {})) {
    if (!deckId.startsWith('fr/')) continue;
    additions[deckId] = words.map(w => {
      const next = fix(w);
      changed ||= next !== w;
      return next;
    });
  }
  for (const deck of imports || []) {
    if (deck.lang !== 'fr') continue;
    const unit = fix(deck);
    if (unit !== deck) {
      deck.unit = unit.unit;
      changed = true;
    }
    deck.words = (deck.words || []).map(w => {
      const next = fix(w);
      changed ||= next !== w;
      return next;
    });
  }
  return changed;
}
