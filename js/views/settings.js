import { store } from '../store.js';
import { langName, baseLang, BASES } from '../data.js';
import { html, icon, plural, segmented, onSegmented, applyTheme } from '../ui.js';
import { locale } from '../i18n.js';
import { avatar } from './accounts.js';
import { DEFAULT_AI, chat, aiReady, aiSettings, AiError } from '../ai.js';
import { downloadBackup, pickBackupFile, folderRow, bindFolder } from './backup-ui.js';
import { folderActive } from '../folder.js';
import { syncState, onSyncChange, syncNow, forgetKey } from '../sync/engine.js';

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
  if (folderActive() || syncState.mode === 'file') return 'Your progress is already saved in a file. A backup file is for moving a profile to another device.';
  if (!last) return 'Never backed up. Your progress lives only in this browser, so clearing site data or changing phones loses it.';
  const days = Math.floor((Date.now() - last) / 86400000);
  return `Last backup ${days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}. Restoring always creates a new profile.`;
}

function storageStatus(state) {
  if (state.mode === 'file') {
    if (state.error) return { tone: 'is-bad', text: html`${state.error}`, alert: true };
    return { tone: 'is-good', text: html`Saved to ${state.dataFile || 'data/language-data.json'} on this computer` };
  }
  if (state.mode === 'browser') {
    return { tone: 'is-warn', text: html`Saved in this browser only. Start the app with <code data-no-tr>python serve.py</code> or the desktop shortcut to keep it in a file.` };
  }
  return { tone: '', text: html`Checking where your data is saved…` };
}

function storageCardBody(state) {
  const { tone, text, alert } = storageStatus(state);
  const savedAt = state.savedAt ? new Date(state.savedAt).toLocaleString(locale()) : 'not yet';
  return html`
    <div class="storage-status ${tone}" role="${alert ? 'alert' : 'status'}">${icon(tone === 'is-good' ? 'check' : tone ? 'alert' : 'refresh')}<span>${text}</span></div>
    ${state.mode === 'file' ? html`
      <div class="storage-row"><span>Last saved</span><span>${savedAt} <small class="muted">(save #${state.revision})</small></span></div>
      <div class="setting-buttons"><button class="btn btn-secondary btn-sm" data-sync-now ${state.saving ? 'disabled' : ''}>${icon('refresh')}Save now</button></div>` : ''}`;
}

function keyNote(state) {
  if (state.mode !== 'file' || !state.hasAiKey) return html``;
  return html`<p class="muted small">Saved in .env on this computer
    <button class="btn btn-secondary btn-sm" data-forget-key>Forget key</button></p>`;
}

export function settingsView(app) {
  const s = store.settings;
  const lang = app.lang;
  const decks = app.decks;
  const wordCount = decks.reduce((n, d) => n + d.words.length, 0);
  const from = app.decksFor()[0]?.from || baseLang();
  const ai = aiSettings();
  const folder = folderRow();

  const body = html`
    <h3 class="group-title">Profile</h3>
    <section class="card settings">
      <div class="setting setting-profile">
        ${avatar(store.account.name, 'sm')}
        <div class="setting-text"><div class="setting-label">${store.account.name}</div><div class="setting-hint">Progress, imports and settings are saved on this device${folderActive() ? ' and in your folder' : ''}</div></div>
        <button class="btn btn-secondary btn-sm" data-switch>Switch profile</button>
      </div>
      ${row('I speak', 'Words, lessons and drills come in this language. Course progress carries over', html`<div data-no-tr>${segmented('base',
        Object.entries(BASES).map(([value, b]) => ({ value, label: b.name })), baseLang())}</div>`)}
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
      <div data-key-note>${keyNote(syncState)}</div>
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

    <h3 class="group-title">Storage</h3>
    <section class="card settings storage-card" data-storage aria-live="polite">${storageCardBody(syncState)}</section>

    <h3 class="group-title">Data</h3>
    <section class="card settings">
      ${row('Word library', `${plural(app.languages().length, 'language')} · ${plural(decks.length, 'deck')} · ${plural(wordCount, 'word')}`,
        html`<div class="setting-buttons"><a class="btn btn-secondary btn-sm" href="#/import?mode=add">${icon('plus')}Add word</a><a class="btn btn-secondary btn-sm" href="#/import?mode=list">${icon('upload')}Import</a></div>`)}
      ${row('Save to a folder', folder.hint, folder.buttons)}
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
        if (name === 'base') return app.setBase(value);
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
      bindFolder(root, app);
      const card = root.querySelector('[data-storage]');
      const note = root.querySelector('[data-key-note]');
      // The view has no unmount hook, so the listener removes itself once the card is gone.
      const stop = onSyncChange(() => {
        if (!card.isConnected) return stop();
        card.innerHTML = storageCardBody(syncState).s;
        note.innerHTML = keyNote(syncState).s;
      });
      card.addEventListener('click', e => {
        if (e.target.closest('[data-sync-now]')) syncNow();
      });
      note.addEventListener('click', async e => {
        if (!e.target.closest('[data-forget-key]')) return;
        const ok = await app.confirm({ title: 'Forget the AI key?', text: 'It is removed from .env on this computer and from this browser. You can add it again later.', confirmLabel: 'Forget key', danger: true });
        if (!ok) return;
        try {
          await forgetKey();
          location.reload();
        } catch (err) {
          app.toast(err.message || 'The key could not be removed.', { kind: 'error' });
        }
      });
      root.querySelector('[data-update]').addEventListener('click', () => checkForUpdates(app));
      root.querySelector('[data-switch]').addEventListener('click', () => app.switchAccount());
    },
  };
}
