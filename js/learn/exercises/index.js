import word from './word.js';
import cloze from './cloze.js';
import form from './form.js';
import order from './order.js';
import build from './build.js';
import transform from './transform.js';

// A new exercise type is one file in this folder plus one entry here.
export const EXERCISES = Object.fromEntries([word, cloze, form, order, build, transform].map(e => [e.type, e]));

export function toQuestions(item, ctx) {
  const exercise = EXERCISES[item.type];
  if (!exercise) return [];
  return exercise.questions(item, ctx).map(q => ({ input: 'text', answerLang: ctx.lang, ...q, type: item.type, lesson: item.lesson }));
}
