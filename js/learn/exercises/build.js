import { checkSentence, expandAll } from '../answers.js';

// The main active exercise: write the French sentence for a Czech one.
export default {
  type: 'build',
  questions(item, ctx) {
    const answers = [...expandAll(item.a), ...ctx.acceptedFor(item.id)];
    return [{
      id: item.id,
      label: `Translate to ${ctx.langName(ctx.lang)}`,
      prompt: item.en ?? item.cs,
      promptLang: item.en != null ? 'en' : 'cs',
      sentence: true,
      sub: item.hint,
      answers,
      why: item.why,
      check: value => checkSentence(value, answers, ctx.settings),
    }];
  },
};
