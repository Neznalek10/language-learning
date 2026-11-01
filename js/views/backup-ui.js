import { store } from '../store.js';
import { BACKUP_KEYS, MAX_BACKUP_BYTES, buildBackup, backupFileName, parseBackup, backupSummary, restoredName } from '../backup.js';
import { html, icon, plural } from '../ui.js';
import { locale } from '../i18n.js';
import { folderSupported, folderStatus, chooseFolder, reconnectFolder, stopFolder } from '../folder.js';

export function downloadBackup(app, now = new Date()) {
  const source = Object.fromEntries(BACKUP_KEYS.map(key => [key, store[key]]));
  const file = buildBackup(source, { name: store.account.name, version: app.version, now });
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = backupFileName(store.account.name, now);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  store.settings.lastBackup = now.getTime();
  store.save('settings');
  app.toast('Backup saved to your downloads.', { kind: 'success' });
}

// Turns the text of a backup file into a new profile, after showing what is in it.
export async function restoreFromText(app, text) {
  let backup;
  try {
    backup = parseBackup(text);
  } catch (e) {
    app.toast(e.message, { kind: 'error', duration: 7000 });
    return false;
  }
  const name = restoredName(backup.name, n => store.nameTaken(n));
  const s = backupSummary(backup.data);
  const sentence = [plural(s.words, 'word'), plural(s.lessons, 'lesson'), plural(s.texts, 'checked text')].join(', ');
  const ok = await app.confirm({
    title: 'Restore this backup?',
    text: `It becomes a new profile called "${name}" with ${sentence}. Your other profiles stay as they are.`,
    confirmLabel: 'Restore',
  });
  if (!ok) return false;
  if (store.account && !backup.data.settings?.ai?.key && store.settings.ai?.key) {
    backup.data.settings = { ...backup.data.settings, ai: store.settings.ai };
  }
  const account = store.restoreAccount(name, backup.data);
  app.toast(`Restored as ${name}.`, { kind: 'success' });
  app.signIn(account.id);
  return true;
}

export function pickBackupFile(app) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      app.toast('That file is too large to be a backup.', { kind: 'error' });
      return;
    }
    restoreFromText(app, await file.text());
  });
  input.click();
}

export const restoreButton = (cls = 'btn btn-text btn-block') => html`<button type="button" class="${cls}" data-restore>Restore from a backup file</button>`;

function folderHint({ state, name, lastSaved }) {
  if (!folderSupported()) return 'Needs Chrome or Edge on a computer. Use Back up below instead.';
  if (state === 'locked') return `The browser needs your permission again to save into "${name}".`;
  if (state === 'off') return 'Pick a folder once and every profile is saved there automatically after each change.';
  const when = lastSaved ? new Date(lastSaved).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '';
  return when ? `Every profile is saved to "${name}" automatically. Last saved at ${when}.` : `Every profile is saved to "${name}" automatically.`;
}

export function folderRow() {
  const status = folderStatus();
  const buttons = !folderSupported() ? ''
    : status.state === 'off' ? html`<button class="btn btn-primary btn-sm" data-folder="choose">${icon('download')}Choose folder</button>`
    : status.state === 'locked' ? html`<button class="btn btn-primary btn-sm" data-folder="allow">${icon('check')}Allow</button>`
    : html`<button class="btn btn-secondary btn-sm" data-folder="choose">Change</button><button class="btn btn-secondary btn-sm" data-folder="stop">Stop</button>`;
  return { hint: folderHint(status), buttons: buttons && html`<div class="setting-buttons">${buttons}</div>` };
}

function foundToast(app, found) {
  if (found) app.toast(`Found ${plural(found, 'profile')} in the folder.`, { kind: 'success' });
}

export function bindFolder(root, app) {
  root.querySelectorAll('[data-folder]').forEach(btn => btn.addEventListener('click', async () => {
    const action = btn.dataset.folder;
    if (action === 'stop') {
      await stopFolder();
      app.toast('Stopped saving to the folder. The files there stay.');
    } else {
      const found = await (action === 'allow' ? reconnectFolder() : chooseFolder());
      if (found === null) return;
      foundToast(app, found);
      if (!found) app.toast('Saving to the folder.', { kind: 'success' });
    }
    app.render();
  }));
}
