import { checkSentence, expandAll, splitMarks } from '../answers.js';

// Rewrite a French sentence: {"task_cs": "Převeď do záporu", "fr": "Je suis là.", "a": ["Je ne suis pas là."]}
// Words in [brackets] are shown underlined: {"task_en": "Replace with a pronoun", "fr": "J'allais [à Paris].", "a": ["J'y allais."]}
export default {
  type: 'transform',
  questions(item, ctx) {
    const answers = [...expandAll(item.a), ...ctx.acceptedFor(item.id)];
    const { text, parts } = splitMarks(item.fr);
    return [{
      id: item.id,
      label: item.task_en ?? item.task_cs,
      prompt: text,
      segments: parts,
      promptLang: 'fr',
      sentence: true,
      sub: item.hint,
      answers,
      why: item.why,
      check: value => checkSentence(value, answers, ctx.settings),
    }];
  },
};
