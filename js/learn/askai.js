import { askJson, loadPrompt, AiError } from '../ai.js';

const str = v => (typeof v === 'string' ? v.trim() : '');

export function buildAnswerRequest(q, given) {
  return {
    instruction: q.label,
    prompt: q.prompt,
    promptLanguage: q.promptLang,
    given,
    ...(q.gap && q.full ? { completed: q.full(given) } : {}),
    expected: q.answers.slice(0, 6),
  };
}

export function parseVerdict(data) {
  if (typeof data?.correct !== 'boolean') throw new AiError('format', 'The AI did not answer in the expected form.');
  return { correct: data.correct, why: str(data.why).slice(0, 400) };
}

// Asked when the app marked an answer wrong but you think it is fine.
export async function askAnswer(ai, q, given, { fetcher } = {}) {
  const system = await loadPrompt('check-answer');
  return askJson(ai, [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(buildAnswerRequest(q, given)) }], parseVerdict, { fetcher });
}
