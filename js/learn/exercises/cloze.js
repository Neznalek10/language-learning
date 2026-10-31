import { checkSentence, expandAll } from '../answers.js';

export const GAP = '___';

// A French sentence with one gap: {"fr": "Je ___ tchèque.", "a": ["suis"], "hint": "être", "cs": "Jsem Čech."}
export default {
  type: 'cloze',
  questions(item, ctx) {
    const answers = [...expandAll(item.a), ...ctx.acceptedFor(item.id)];
    return [{
      id: item.id,
      label: 'Fill the gap',
      prompt: item.fr,
      gap: true,
      promptLang: 'fr',
      sub: [item.hint && `(${item.hint})`, item.en ?? item.cs].filter(Boolean).join(' · '),
      answers,
      why: item.why,
      check: value => checkSentence(value, answers, ctx.settings),
      full: expected => item.fr.replace(GAP, expected),
    }];
  },
};
