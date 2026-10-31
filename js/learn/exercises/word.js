import { check } from '../../check.js';

// A deck word, Czech to French. Answers count toward the word's level, like the normal practice.
export default {
  type: 'word',
  questions(item, ctx) {
    const word = item.word || ctx.word(item.ref);
    if (!word) return [];
    const answers = [...word.a, ...ctx.acceptedFor(word.id)];
    return [{
      id: word.id,
      label: `Translate to ${ctx.langName(word.deck.lang)}`,
      prompt: word.note ? `${word.q} (${word.note})` : word.q,
      promptLang: word.deck.from,
      answers,
      word,
      why: word.why,
      check: value => check(value, answers, ctx.settings),
      explain: (result, given) => ctx.explainWord({ given, expected: result.expected, kind: result.kind, word }),
    }];
  },
};
