import { store } from '../store.js';
import { html, icon, segmented, onSegmented } from '../ui.js';
import { buildSpeakPrompt, MINUTES, FIX_STYLES, FREE_MODES } from '../learn/speakprompt.js';
import { pickerView } from './write.js';
import { openGenerate } from './generate.js';

const LEVELS = ['A1', 'A2', 'B1'];
const FEEDBACK = [{ value: 'en', label: 'English' }, { value: 'cs', label: 'Czech' }, { value: 'fr', label: 'French' }];
const SPEEDS = [{ value: 'slow', label: 'Slow' }, { value: 'natural', label: 'Natural' }];
const DEFAULT_SPEAK = { level: 'A1', minutes: 10, fix: 'end', feedback: 'en', speed: 'slow', free: 'talk' };

export const speakOptions = () => ({ ...DEFAULT_SPEAK, ...store.settings.speak });

const STEPS = [
  'Tap Copy prompt.',
  'Open ChatGPT (or Gemini, Claude or any other voice AI), start a new chat, paste the prompt and send it.',
  'Switch that chat to voice mode and say "Prêt".',
  'When you are done, say "terminé" to get your feedback.',
];

// topic null is free speech. The prompt itself needs no AI key: you paste it into the voice AI you already use.
export function openSpeakSetup(app, topic) {
  const saved = speakOptions();
  let opts = { ...saved, level: topic ? topic.level : saved.level };
  const rules = (app.grammar[app.lang]?.articles || []).map(a => ({ id: a.id, title: a.title }));
  const prompt = () => buildSpeakPrompt(topic, opts, { rules });

  app.sheet({
    title: topic ? topic.title : 'Free speech',
    body: html`
      ${topic ? html`<p class="sheet-text">${topic.task}</p>
        <div class="field-label">You should manage to</div>
        <ul class="unit-goals w-must">${topic.must.map(m => html`<li>${icon('check')}${m}</li>`)}</ul>`
        : html`<p class="sheet-text">Talk about anything you like. Choose whether the AI only listens and corrects, or talks with you.</p>
          <div class="field-label">The AI should</div>
          ${segmented('free', FREE_MODES, opts.free)}`}
      <div class="field-label">Your level</div>
      ${segmented('level', LEVELS.map(l => ({ value: l, label: l })), opts.level)}
      <div class="field-label">How long</div>
      ${segmented('minutes', MINUTES.map(m => ({ value: String(m.value), label: m.label })), String(opts.minutes))}
      <div class="field-label">Corrections</div>
      ${segmented('fix', FIX_STYLES, opts.fix)}
      <div class="field-label">Feedback language</div>
      ${segmented('feedback', FEEDBACK, opts.feedback)}
      <div class="field-label">The AI's speech</div>
      ${segmented('speed', SPEEDS, opts.speed)}
      <button class="btn btn-primary btn-block btn-lg" data-copy>${icon('copy')}<span>Copy prompt</span></button>
      <a class="btn btn-secondary btn-block" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">Open ChatGPT</a>
      <ol class="w-steps">${STEPS.map(s => html`<li>${s}</li>`)}</ol>
      <details class="word-details w-prompt-box"><summary>Show the prompt${icon('chevronDown')}</summary><pre class="w-prompt" data-prompt></pre></details>`,
    onMount(body) {
      const pre = body.querySelector('[data-prompt]');
      const refresh = () => { pre.textContent = prompt(); };
      refresh();
      onSegmented(body, (name, value) => {
        opts = { ...opts, [name]: name === 'minutes' ? Number(value) : value };
        if (name !== 'level' || !topic) {
          store.settings.speak = { ...speakOptions(), [name]: opts[name] };
          store.save('settings');
        }
        refresh();
      });
      body.querySelector('[data-copy]').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(prompt());
          (store.write.spoken ??= []).push({ at: Date.now(), topic: topic?.id || 'free' });
          store.save('write');
          app.toast('Prompt copied. Paste it into your voice AI.', { kind: 'success' });
        } catch {
          body.querySelector('details').open = true;
          app.toast('Could not copy. Select the prompt below and copy it by hand.', { kind: 'error' });
        }
      });
    },
  });
}

export function speakView(app, params) {
  return pickerView(app, params, {
    mode: 'speak',
    title: 'Speak',
    noun: 'speaking',
    open: openSpeakSetup,
    banner: 'Generating new topics needs an AI key. The ready-made topics work without one.',
    actions: [
      { label: 'Free speech', icon: 'speak', run: a => openSpeakSetup(a, null) },
      { label: 'Generate new topic', icon: 'bulb', run: a => openGenerate(a, 'speak', t => openSpeakSetup(a, t)) },
    ],
  });
}

