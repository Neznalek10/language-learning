import { chat, extractJson, loadPrompt, AiError } from '../ai.js';

const MAX_HISTORY = 24;
const FEEDBACK = { en: 'English', cs: 'Czech', fr: 'very simple French' };
export const OPENER = 'Bonjour ! De quoi as-tu envie de parler aujourd\'hui ?';

const str = v => (typeof v === 'string' ? v.trim() : '');

export function chatMessages(system, { opts, messages }) {
  const settings = `\n\nSettings: level ${opts.level}; strictness ${opts.strict}; feedback language ${FEEDBACK[opts.feedback] || 'English'}.`;
  const history = messages.slice(-MAX_HISTORY).map(m => (m.role === 'me'
    ? { role: 'user', content: m.text }
    : { role: 'assistant', content: JSON.stringify({ reply: m.text, corrections: [] }) }));
  return [{ role: 'system', content: system + settings }, ...history];
}

// A model that forgets the JSON still gives a usable reply; only an empty answer is an error.
export function parseTurn(raw, userText) {
  let data = null;
  try {
    data = extractJson(raw);
  } catch {
    data = null;
  }
  if (!data) {
    const reply = raw.replace(/```[a-z]*/gi, '').trim();
    if (!reply) throw new AiError('format', 'The AI sent back an empty answer.');
    return { reply, corrections: [] };
  }
  const reply = str(data.reply);
  if (!reply) throw new AiError('format', 'The AI sent back an empty answer.');
  const inText = piece => !!piece && userText.toLowerCase().includes(piece.toLowerCase());
  const corrections = (Array.isArray(data.corrections) ? data.corrections : [])
    .map(c => ({ wrong: str(c?.wrong), right: str(c?.right), why: str(c?.why) }))
    .filter(c => c.wrong && c.right && c.wrong !== c.right && inText(c.wrong))
    .slice(0, 3);
  return { reply, corrections };
}

export async function chatTurn(ai, { opts, messages }, { fetcher } = {}) {
  const system = await loadPrompt('free-chat');
  const userText = messages.filter(m => m.role === 'me').at(-1)?.text || '';
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(ai, chatMessages(system, { opts, messages }), { fetcher });
    try {
      return parseTurn(raw, userText);
    } catch (e) {
      if (!(e instanceof AiError) || e.kind !== 'format') throw e;
      last = e;
    }
  }
  throw last;
}
