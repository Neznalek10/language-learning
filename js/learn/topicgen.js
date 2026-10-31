import { askJson, loadPrompt, AiError } from '../ai.js';
import { searchKey } from './grammar.js';

const DEFAULT_KIND = { write: 'description', speak: 'roleplay' };
const str = v => (typeof v === 'string' ? v.trim() : '');
const strings = (v, max, cap) => (Array.isArray(v) ? v.map(str).filter(Boolean).map(s => s.slice(0, cap)).slice(0, max) : []);

// A topic the AI made, checked and shaped like the catalogue's topics so every view can use it.
export function parseTopic(data, { type, level, kinds, ruleIds, now = Date.now() }) {
  const title = str(data?.title).slice(0, 70);
  const task = str(data?.task).slice(0, 400);
  const must = strings(data?.must, 6, 180);
  if (!title || !task || must.length < 2) throw new AiError('format', 'The AI sent back an incomplete topic.');
  const known = new Set(ruleIds);
  const topic = {
    id: `my-${now.toString(36)}`,
    custom: true,
    title, task, must, level,
    kind: kinds.includes(data.kind) ? data.kind : DEFAULT_KIND[type],
    phrases: strings(data.phrases, 6, 120),
    grammar: strings(data.grammar, 3, 60).filter(id => known.has(id)),
  };
  if (type === 'speak') {
    topic.partner = str(data.partner).slice(0, 200) || 'a friendly French speaker my age';
    topic.starter = str(data.starter).slice(0, 200) || 'Bonjour ! Comment ça va ?';
  }
  topic.search = searchKey([topic.title, topic.task, topic.kind, topic.level].join(' '));
  return topic;
}

export async function generateTopic(ai, { type, brief, level, kinds, avoid, rules }, { fetcher, now } = {}) {
  const system = await loadPrompt('make-topic');
  const request = { type, level, brief: brief.trim().slice(0, 300), kinds, avoid, grammarRules: rules };
  return askJson(
    ai,
    [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(request) }],
    data => parseTopic(data, { type, level, kinds, ruleIds: rules.map(r => r.id), now }),
    { fetcher },
  );
}
