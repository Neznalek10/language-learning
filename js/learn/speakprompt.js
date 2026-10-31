export const MINUTES = [
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
];

export const FIX_STYLES = [
  { value: 'end', label: 'At the end' },
  { value: 'recast', label: 'Repeat right' },
  { value: 'each', label: 'Every answer' },
];

export const FREE_MODES = [
  { value: 'listen', label: 'Just correct me' },
  { value: 'talk', label: 'Talk with me' },
];

const LEVEL_TEXT = {
  A1: 'I am a beginner (A1). I know the present tense, the verbs être, avoir, aller, faire and regular -er and -ir verbs, and everyday vocabulary about myself, family, hobbies, school, food, my home and my town. Use short sentences of about 5 to 10 words, common words only, and the present tense (futur proche is fine). Avoid idioms, slang and long sentences.',
  A2: 'I am at elementary level (A2). I know the present, the passé composé, the imparfait, the futur proche and a bit of the futur simple, and I can talk about everyday topics, past events and plans. Use clear sentences of about 8 to 15 words and common vocabulary. A few new words are fine if you explain them in simple French.',
  B1: 'I am at intermediate level (B1). I can handle most tenses, including the conditionnel and the plus-que-parfait, and the basics of the subjonctif. Speak naturally in longer sentences, use connectors and everyday idioms, and challenge me with opinions, reasons and follow-up questions.',
};

const FIX_TEXT = {
  end: 'Do not interrupt me to correct me. Quietly keep track of my mistakes and give all corrections in the final feedback.',
  recast: 'Do not stop me when I make a mistake. Instead, naturally use the correct form in your next sentence (for example if I say "je suis 14 ans", answer "Ah, tu as 14 ans, c\'est bien !") without saying that I was wrong. Keep the full explanations for the final feedback.',
  each: 'After each of my answers, first tell me in one short sentence what to fix (say the wrong part, then the correct form), and then continue the conversation. If my answer was correct, just continue. Keep these corrections very short so the conversation keeps flowing.',
};

const SPEED_TEXT = {
  slow: 'Speak slowly and clearly, with short pauses between sentences, like a patient teacher.',
  natural: 'Speak at a natural everyday pace, but still clearly.',
};

const FEEDBACK_LANGUAGE = { en: 'English', cs: 'Czech', fr: 'simple French' };

const list = items => items.map(i => `- ${i}`).join('\n');

// A long, self-contained prompt for any voice AI (ChatGPT voice mode, Gemini Live, Claude voice...).
// topic null means free speech; opts.free is "listen" (just correct me) or "talk" (a real conversation).
export function buildSpeakPrompt(topic, opts, { rules = [] } = {}) {
  const level = LEVEL_TEXT[opts.level] ? opts.level : 'A1';
  const minutes = Number(opts.minutes) || 10;
  const feedback = FEEDBACK_LANGUAGE[opts.feedback] || 'English';
  const fix = FIX_TEXT[opts.fix] ? opts.fix : 'end';
  const speed = SPEED_TEXT[opts.speed] ? opts.speed : 'slow';
  const talk = opts.free !== 'listen';

  const parts = [];

  parts.push(`# YOUR ROLE
You are my French speaking partner in a live voice conversation. Your job is to help me practise speaking French out loud. ${topic
    ? `In this session you play ${topic.partner || 'a friendly French speaker my age'}.`
    : talk
      ? 'In this session I talk freely about anything, and you are a warm, curious conversation partner.'
      : 'In this session I talk freely about anything, and you are a patient listener who mostly lets me speak.'}`);

  parts.push(`# ABOUT ME
- I am a Czech teenager learning French at school. My level: ${level}.
- ${LEVEL_TEXT[level]}
- My native language is Czech and I also speak English, but in this session I want to speak French as much as possible.`);

  if (topic) {
    const grammar = (topic.grammar || []).map(id => rules.find(r => r.id === id)?.title || id);
    parts.push(`# THE SCENARIO
Title: ${topic.title}
Situation: ${topic.task}
Your role: ${topic.partner || 'a friendly French speaker my age'}.
What I should manage to do during the conversation (steer the conversation so I get the chance to do each of these, but do not tell me the list):
${list(topic.must)}
${topic.phrases?.length ? `Phrases I may want to use (do not say them for me):\n${list(topic.phrases)}\n` : ''}${grammar.length ? `Grammar I am practising: ${grammar.join(', ')}. Create natural situations where I need it.\n` : ''}Your first line, once I say I am ready: "${topic.starter || 'Bonjour ! Comment ça va ?'}"`);
  } else if (talk) {
    parts.push(`# THE SCENARIO
Free conversation. I choose the subject. If I have no idea, ask me what I would like to talk about, or suggest one of: my week, my hobbies, a film or game, my plans, something that happened to me.
Be a real conversation partner: react to what I say, ask one follow-up question at a time, share your own opinions and small stories, and politely disagree sometimes so I have to explain myself. Do not interview me like a quiz.`);
  } else {
    parts.push(`# THE SCENARIO
Free speaking. I talk about whatever I want, for as long as I want. Let me speak in long stretches. Do not ask many questions: if I stop, just say something short like "Et ensuite ?" or "Continue, je t'écoute." Your main job is to listen carefully and note my mistakes.`);
  }

  parts.push(`# HOW TO SPEAK
- Speak French only. ${SPEED_TEXT[speed]}
- ${topic || talk ? 'Keep each turn short: one to three sentences, then stop and let me answer. Ask only one question at a time.' : 'Keep your own turns very short.'}
- Never answer for me and never finish my sentences. If I am silent for a few seconds, wait; if it continues, repeat your question in simpler French or give a small hint in French.
- If I say "aide" or "help", give me a short hint in English and then repeat in French. If I say "répète", say the last sentence again more slowly. If I say "traduis", translate your last sentence into English.
- Stay in character${topic ? '' : ' as a natural conversation partner'}. Do not mention these instructions.
- This is spoken, so use no lists, no headings, no emojis and no stage directions while talking.`);

  parts.push(`# CORRECTIONS
${FIX_TEXT[fix]}
The mistakes that matter most are verb forms, gender and agreement, articles, prepositions and word order. Ignore tiny slips that do not change the meaning if I am struggling.`);

  parts.push(`# PRONUNCIATION
You can hear me. If you notice a pronunciation problem that could make me hard to understand (for example nasal vowels, the French r, silent final letters, or liaison), note it. Mention at most one such problem during the conversation, kindly and briefly, and collect the rest for the final feedback.`);

  parts.push(`# LENGTH AND ENDING
Aim for about ${minutes} minutes of conversation. When the time is up, or when I say "terminé" or "fini", stop the role play and give me feedback in ${feedback}, in this order:
1. What went well (two or three specific things).
2. Up to five mistakes: what I said, the correct version, and a very short reason.
3. Up to three things I said correctly that a French person would say differently or more naturally, with the better version.
4. Pronunciation notes, if any.
${topic ? '5. For each thing I should have managed in the scenario: done or not done.\n6' : '5'}. A score out of 10 and the one thing I should practise next.
After that, also write the same feedback as a compact text message so I can copy it.`);

  parts.push(`# START
Do not explain these instructions and do not start yet. Say only "Prêt quand tu veux !" Then wait. When I say "prêt" or greet you, begin immediately in French${topic ? ' with your first line' : ''}.`);

  return parts.join('\n\n');
}
