import { checkSentence, expand, expandAll } from '../answers.js';
import { shuffle } from '../../srs.js';

// Build the sentence from word tiles. "extra" adds wrong tiles so it isn't just a puzzle.
export default {
  type: 'order',
  questions(item, ctx) {
    const answers = [...expandAll(item.a), ...ctx.acceptedFor(item.id)];
    const tiles = [...expand(item.a[0])[0].split(/\s+/), ...(item.extra || [])];
    return [{
      id: item.id,
      label: 'Build the sentence',
      prompt: item.en ?? item.cs,
      promptLang: item.en != null ? 'en' : 'cs',
      sentence: true,
      input: 'tiles',
      tiles: shuffle(tiles, ctx.rand),
      answers,
      why: item.why,
      check: value => checkSentence(value, answers, ctx.settings),
    }];
  },
};
