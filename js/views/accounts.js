import { store } from '../store.js';
import { html, icon, segmented, onSegmented } from '../ui.js';
import { BASES, guessBase } from '../data.js';
import { pickBackupFile, restoreButton, bindFolder } from './backup-ui.js';
import { folderSupported, folderStatus } from '../folder.js';

export const avatar = (name, cls = '') => html`<span class="avatar ${cls}" aria-hidden="true">${[...name][0].toUpperCase()}</span>`;

function nameForm(submitLabel, { cancel = false } = {}) {
  return html`<form class="account-form" novalidate>
    <label class="field-label" for="account-name">Your name</label>
    <input class="input input-lg" id="account-name" name="name" maxlength="24" autocomplete="off" placeholder="e.g. User" required>
    <p class="form-error" hidden></p>
    <label class="field-label">I speak</label>
    <div data-no-tr>${segmented('base', Object.entries(BASES).map(([value, b]) => ({ value, label: b.name })), guessBase())}</div>
    <button class="btn btn-primary btn-block btn-lg" type="submit">${submitLabel}</button>
    ${cancel ? html`<button class="btn btn-text btn-block" type="button" data-cancel>Cancel</button>` : ''}
  </form>`;
}

// After site data was cleared, opening the save folder brings every profile back.
function folderPrompt() {
  const { state, name } = folderStatus();
  if (state === 'locked') {
    return html`<div class="notice notice-warn account-folder">${icon('alert')}<span>Allow the browser to keep saving profiles into "${name}".</span>
      <button class="btn btn-primary btn-sm" data-folder="allow">Allow</button></div>`;
  }
  if (state === 'off' && folderSupported() && !store.accounts.length) {
    return html`<button type="button" class="btn btn-text btn-block" data-folder="choose">Load profiles from a save folder</button>`;
  }
  return '';
}

function welcome() {
  return html`
    <h1>Welcome to Vocab</h1>
    <p class="accounts-sub">Set up your profile to start learning.</p>
    <ol class="steps">
      <li><span><strong>Create your profile</strong>Just a name. Your progress is saved under it on this device.</span></li>
      <li><span><strong>Practice a few words a day</strong>Sessions take about 3 minutes.</span></li>
      <li><span><strong>Watch words level up</strong>Five correct answers in a row and a word is mastered.</span></li>
    </ol>
    ${nameForm(html`Create profile${icon('chevronRight')}`)}
    ${restoreButton()}
    ${folderPrompt()}`;
}

function picker() {
  return html`
    <h1>Who's learning?</h1>
    <p class="accounts-sub">Choose your profile</p>
    <div class="account-list">${store.accounts.map(a => html`
      <button class="account" data-id="${a.id}">${avatar(a.name)}<span class="account-name">${a.name}</span>${icon('chevronRight', 'chevron')}</button>`)}
    </div>
    <button class="btn btn-secondary btn-block account-add" data-add>${icon('plus')}Add profile</button>
    <div class="account-new" hidden>${nameForm('Create profile', { cancel: true })}</div>
    ${restoreButton()}
    ${folderPrompt()}`;
}

export function accountsView(app) {
  const body = html`<div class="accounts">
    <div class="accounts-mark">${icon('repeat')}</div>
    ${store.accounts.length ? picker() : welcome()}
    <footer class="version-footer">Vocab v${app.version}</footer>
  </div>`;

  return {
    focus: true,
    body,
    mount(root) {
      root.querySelector('[data-restore]').addEventListener('click', () => pickBackupFile(app));
      bindFolder(root, app);
      root.querySelectorAll('[data-id]').forEach(btn => btn.addEventListener('click', () => app.signIn(btn.dataset.id)));

      const form = root.querySelector('.account-form');
      const input = form.querySelector('input');
      const error = form.querySelector('.form-error');
      const showError = text => {
        error.textContent = text;
        error.hidden = false;
        input.focus();
      };
      input.addEventListener('input', () => { error.hidden = true; });
      onSegmented(form, () => {});
      form.addEventListener('submit', e => {
        e.preventDefault();
        const name = input.value.trim().replace(/\s+/g, ' ');
        if (!name) return showError('Enter a name to continue.');
        if (store.nameTaken(name)) return showError(`There is already a profile called ${name}.`);
        app.signIn(store.createAccount(name, form.querySelector('[data-name="base"] .active').dataset.value).id);
      });

      const add = root.querySelector('[data-add]');
      const panel = root.querySelector('.account-new');
      add?.addEventListener('click', () => {
        add.hidden = true;
        panel.hidden = false;
        input.focus();
      });
      root.querySelector('[data-cancel]')?.addEventListener('click', () => {
        panel.hidden = true;
        add.hidden = false;
        input.value = '';
        error.hidden = true;
      });
      if (!store.accounts.length) input.focus({ preventScroll: true });
    },
  };
}
