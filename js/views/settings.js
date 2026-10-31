import { store } from '../store.js';
import { langName } from '../data.js';
import { html, icon, plural, segmented, onSegmented, applyTheme } from '../ui.js';
import { avatar } from './accounts.js';
import { DEFAULT_AI, chat, aiReady, aiSettings, AiError } from '../ai.js';
import { downloadBackup, pickBackupFile } from './backup-ui.js';

function row(label, hint, control) {
  return html`<div class="setting">
    <div class="setting-text"><div class="setting-label">${label}</div>${hint ? html`<div class="setting-hint">${hint}</div>` : ''}</div>
    ${control}
  </div>`;
}

async function checkForUpdates(app) {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) await reg.update().catch(() => {});
  app.toast('Reloading the latest version…');
  setTimeout(() => location.reload(), 600);
}

function backupHint(last) {
  if (!last) return 'Never backed up. Your progress lives only in this browser, so clearing site data or changing phones loses it.';
  const days = Math.floor((Date.now() - last) / 86400000);
  return `Last backup ${days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}. Restoring always creates a new profile.`;
}

export function settingsView(app) {
  const s = store.settings;
  const lang = app.lang;
  const decks = app.decks;
  const wordCount = decks.reduce((n, d) => n + d.words.length, 0);
  const from = app.decksFor()[0]?.from || 'cs';
  const ai = aiSettings();

  const body = html`
    <h3 class="group-title">Profile</h3>
    <section class="card settings">
      <div class="setting setting-profile">
        ${avatar(store.account.name, 'sm')}
        <div class="setting-text"><div class="setting-label">${store.account.name}</div><div class="setting-hint">Progress, imports and settings are saved on this device</div></div>
        <button class="btn btn-secondary btn-sm" data-switch>Switch profile</button>
      </div>
    </section>

    <h3 class="group-title">Practice</h3>
    <section class="card settings">
      ${row('Direction', 'Which side you see first', segmented('direction', [
        { value: 'forward', label: `${langName(from)} first` },
        { value: 'reverse', label: lang ? `${langName(lang)} first` : 'Target first' },
        { value: 'mixed', label: 'Mixed' },
      ], s.direction))}
      ${row('Accents', s.strictAccents ? 'A missing accent counts as wrong' : 'A missing accent still counts, with a reminder', segmented('accents', [
        { value: 'lenient', label: 'Lenient' },
        { value: 'strict', label: 'Strict' },
      ], s.strictAccents ? 'strict' : 'lenient'))}
      ${row('Session length', 'Words per daily session', segmented('length', [
        { value: '10', label: '10' },
        { value: '20', label: '20' },
        { value: '30', label: '30' },
      ], String(s.sessionLength)))}
    </section>

    <h3 class="group-title">AI checking</h3>
    <section class="card settings ai-settings">
      <p class="muted small">Used to check what you write in the Write tab. Your key stays on this device. Get a free key at openrouter.ai.</p>
      <label class="field-label" for="ai-url">Address</label>
      <input id="ai-url" class="input" data-ai="url" value="${ai.url}" autocomplete="off" spellcheck="false" autocapitalize="off">
      <label class="field-label" for="ai-key">Key</label>
      <input id="ai-key" class="input" type="password" data-ai="key" value="${ai.key}" placeholder="sk-or-..." autocomplete="off" spellcheck="false">
      <label class="field-label" for="ai-model">Model</label>
      <input id="ai-model" class="input" data-ai="model" value="${ai.model}" autocomplete="off" spellcheck="false" autocapitalize="off">
      <p class="muted small">"openrouter/free" picks a free model for you and quality varies. A fixed model gives steadier feedback.</p>
      <div class="setting-buttons">
        <button class="btn btn-secondary btn-sm" data-ai-preset="openrouter">OpenRouter</button>
        <button class="btn btn-secondary btn-sm" data-ai-preset="ollama">Ollama on this PC</button>
        <button class="btn btn-primary btn-sm" data-ai-test>${icon('check')}Test</button>
      </div>
    </section>

    <h3 class="group-title">Appearance</h3>
    <section class="card settings">
      ${row('Theme', null, segmented('theme', [
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ], s.theme))}
    </section>

    <h3 class="group-title">Data</h3>
    <section class="card settings">
      ${row('Word library', `${plural(app.languages().length, 'language')} · ${plural(decks.length, 'deck')} · ${plural(wordCount, 'word')}`,
        html`<div class="setting-buttons"><a class="btn btn-secondary btn-sm" href="#/import?mode=add">${icon('plus')}Add word</a><a class="btn btn-secondary btn-sm" href="#/import?mode=list">${icon('upload')}Import</a></div>`)}
      ${row('Back up progress', backupHint(s.lastBackup), html`<div class="setting-buttons"><button class="btn btn-primary btn-sm" data-backup>${icon('download')}Back up</button><button class="btn btn-secondary btn-sm" data-restore>${icon('upload')}Restore</button></div>`)}
    </section>

    <h3 class="group-title">About</h3>
    <section class="card settings">
      ${row(`Version ${app.version}`, 'If this is older than your latest push, check for updates', html`<button class="btn btn-secondary btn-sm" data-update>${icon('refresh')}Check for updates</button>`)}
    </section>`;

  return {
    title: 'Settings',
    body,
    mount(root) {
      onSegmented(root, (name, value) => {
        if (name === 'direction') s.direction = value;
        if (name === 'accents') s.strictAccents = value === 'strict';
        if (name === 'length') s.sessionLength = Number(value);
        if (name === 'theme') s.theme = value;
        store.save('settings');
        if (name === 'theme') applyTheme();
        if (name === 'accents') app.render();
      });
      const field = name => root.querySelector(`[data-ai="${name}"]`);
      const saveAi = () => {
        s.ai = Object.fromEntries(['url', 'key', 'model'].map(k => [k, field(k).value.trim()]));
        store.save('settings');
      };
      root.querySelectorAll('[data-ai]').forEach(input => input.addEventListener('change', saveAi));
      root.querySelectorAll('[data-ai-preset]').forEach(btn => btn.addEventListener('click', () => {
        const ollama = btn.dataset.aiPreset === 'ollama';
        field('url').value = ollama ? 'http://localhost:11434/v1' : DEFAULT_AI.url;
        field('model').value = ollama ? 'llama3.1:8b' : DEFAULT_AI.model;
        saveAi();
      }));
      root.querySelector('[data-ai-test]').addEventListener('click', async e => {
        saveAi();
        const config = aiSettings();
        if (!aiReady(config)) return app.toast('Add a key first.', { kind: 'error' });
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await chat(config, [{ role: 'user', content: 'Reply with the single word OK.' }], { timeout: 30000 });
          app.toast('The AI answered. Checking is ready.', { kind: 'success' });
        } catch (err) {
          app.toast(err instanceof AiError ? err.message : 'The test failed.', { kind: 'error', duration: 7000 });
        } finally {
          btn.disabled = false;
        }
      });
      root.querySelector('[data-backup]').addEventListener('click', () => {
        downloadBackup(app);
        app.render();
      });
      root.querySelector('[data-restore]').addEventListener('click', () => pickBackupFile(app));
      root.querySelector('[data-update]').addEventListener('click', () => checkForUpdates(app));
      root.querySelector('[data-switch]').addEventListener('click', () => app.switchAccount());
    },
  };
}
