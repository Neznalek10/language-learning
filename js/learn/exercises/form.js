import { checkForm, compact, persons, personLabel, subjectPrefix, tenseInfo } from '../../conj.js';
import { explainForm } from '../../explain.js';

// One conjugated form from the Tenses tables. Without "person" it asks every person of the table.
export default {
  type: 'form',
  questions(item, ctx) {
    const data = ctx.conj;
    const verbData = data?.verbs[item.verb];
    if (!verbData?.t[item.tense]) return [];
    const verb = { inf: item.verb, data: verbData };
    const info = tenseInfo(data, item.tense);
    const list = item.person != null ? [item.person] : persons(verb, item.tense);
    return list.map(person => {
      const forms = verbData.t[item.tense][person];
      return {
        id: `${item.id || `form:${item.verb}:${item.tense}`}:${person}`,
        label: `${info.label} · ${item.verb}`,
        prompt: personLabel(data, item.tense, person),
        promptLang: 'fr',
        answers: forms,
        why: item.why,
        check: value => checkForm(value, forms, ctx.settings),
        explain: (result, given) => explainForm({
          given, expected: result.expected, kind: result.kind, verb, tense: item.tense, person, data, strict: ctx.settings.strictAccents,
        }),
        full: expected => `${subjectPrefix(data, item.tense, person, expected)}${expected}`,
        shownAnswer: compact(forms),
      };
    });
  },
};
