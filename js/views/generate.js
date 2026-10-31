import { store } from '../store.js';
import { html, icon, segmented, onSegmented } from '../ui.js';
import { shuffle } from '../srs.js';
import { aiReady, AiError } from '../ai.js';
import { generateTopic } from '../learn/topicgen.js';
import { aiSettings, catalogOf, customOf } from './write.js';

const LEVELS = ['A1', 'A2', 'B1'];
const COPY = {
  write: { title: 'New writing topic', placeholder: 'For example: a message to my cousin about our trip to Berlin', verb: 'write about' },
  speak: { title: 'New speaking topic', placeholder: 'For example: arguing with a friend about the best video game', verb: 'talk about' },
};

// Asks the AI for one topic, saves it under "My topics" and hands it to onDone.
export function openGenerate(app, mode, onDone) {
  const copy = COPY[mode];
  if (!aiReady(aiSettings())) {
    app.toast('Add an AI key in Settings to generate topics.', { kind: 'error' });
    return;
  }
  let level = LEVELS.includes(store.settings.genLevel) ? store.settings.genLevel : 'A1';
  app.sheet({
    title: copy.title,
    body: html`
      <p class="sheet-text">Describe what you want to ${copy.verb}, or leave it empty and the AI will come up with something.</p>
      <textarea class="input textarea w-brief" rows="3" maxlength="300" placeholder="${copy.placeholder}" aria-label="Topic idea" data-brief></textarea>
      <div class="field-label">Level</div>
      ${segmented('level', LEVELS.map(l => ({ value: l, label: l })), level)}
      <button class="btn btn-primary btn-block btn-lg" data-go>${icon('bulb')}<span>Generate topic</span></button>`,
    onMount(body, close) {
      onSegmented(body, (_, value) => {
        level = value;
        store.settings.genLevel = value;
        store.save('settings');
      });
      const go = body.querySelector('[data-go]');
      go.addEventListener('click', async () => {
        go.disabled = true;
        go.querySelector('span').textContent = 'Thinking up a topic...';
        try {
          await app.grammarReady;
          const catalog = catalogOf(app, mode);
          const g = app.grammar[app.lang];
          const rules = (g?.articles || []).map(a => ({ id: a.id, title: a.title }));
          const avoid = [...customOf(mode).map(t => t.title), ...shuffle(catalog.topics.map(t => t.title)).slice(0, 30)];
          const topic = await generateTopic(aiSettings(), {
            type: mode, brief: body.querySelector('[data-brief]').value, level, kinds: Object.keys(catalog.kinds), avoid, rules,
          });
          customOf(mode).unshift(topic);
          store.save('write');
          close();
          app.render();
          onDone(topic);
        } catch (e) {
          app.toast(e instanceof AiError ? e.message : 'Could not generate a topic.', { kind: 'error', duration: 7000 });
          go.disabled = false;
          go.querySelector('span').textContent = 'Generate topic';
        }
      });
    },
  });
}
