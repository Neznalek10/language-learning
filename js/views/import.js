import { store } from '../store.js';
import { parseImport, saveImport, COMMON_LANGS, TYPES, DIFFICULTIES, langName, langFlag, unitKey, levelKey, baseLang } from '../data.js';
import { html, icon, plural, answersText, segmented, onSegmented } from '../ui.js';
import { deckHref } from './decks.js';
import { addForm, unitOptions } from './add.js';

const EXAMPLES = {
  cs: { lines: 'pes; chien | le chien\nkočka; chat\njíst; manger', verb: 'jíst' },
  en: { lines: 'dog; chien | le chien\ncat; chat\nto eat; manger', verb: 'to eat' },
};

function langOptions(codes, selected) {
  return codes.map(c => html`<option value="${c}" ${c === selected ? 'selected' : ''}>${langFlag(c)} ${langName(c)}</option>`);
}

function listForm(app) {
  const known = [...new Set([...app.languages(), ...COMMON_LANGS])];
  const base = baseLang();
  const example = EXAMPLES[base];
  const targets = known.filter(c => c !== base).concat(base);

  const body = html`<div class="list-form">
    <section class="card">
      <header class="card-head"><h2>1. Add your words</h2></header>
      ${segmented('source', [{ value: 'paste', label: 'Paste text' }, { value: 'file', label: 'Upload file' }], 'paste')}
      <div class="source source-paste">
        <textarea class="input textarea" rows="8" placeholder="${example.lines}" spellcheck="false" aria-label="Words to import"></textarea>
      </div>
      <div class="source source-file" hidden>
        <label class="dropzone">
          ${icon('upload')}
          <strong>Choose a file</strong>
          <span>.json, .csv, .tsv or .txt</span>
          <input type="file" accept=".json,.csv,.tsv,.txt,application/json,text/plain,text/csv" hidden>
        </label>
        <div class="file-name muted small"></div>
      </div>
      <details class="help">
        <summary>${icon('info')}Accepted formats</summary>
        <ul>
          <li><strong>Text or CSV:</strong> one word per line, prompt and answer separated by <code>;</code> <code>,</code> <code>=</code> <code> - </code> or a tab. Separate several correct answers with <code>|</code>.</li>
          <li><strong>JSON deck:</strong> <code>{"lang": "fr", "type": "verbs", "title": "Verbs", "words": [{"q": "${example.verb}", "a": "manger"}]}</code></li>
          <li><strong>Old app files:</strong> the v1 <code>dictionaries/*.json</code> files work as they are.</li>
        </ul>
      </details>
    </section>

    <section class="card">
      <header class="card-head"><h2>2. Describe the deck</h2></header>
      <div class="form-grid">
        <label class="field"><span class="field-label">Language you're learning</span>
          <select class="input" name="lang">${langOptions(targets, app.lang || 'fr')}<option value="other">Other…</option></select>
        </label>
        <label class="field field-other" hidden><span class="field-label">Language code</span>
          <input class="input" name="langCode" placeholder="e.g. hu, el, fi" maxlength="8" autocapitalize="off">
        </label>
        <label class="field"><span class="field-label">Translating from</span>
          <select class="input" name="from">${langOptions(known, base)}</select>
        </label>
        <label class="field"><span class="field-label">Word type</span>
          <select class="input" name="type">${TYPES.map(t => html`<option value="${t.key}" ${t.key === 'topics' ? 'selected' : ''}>${t.label}</option>`)}</select>
        </label>
        <label class="field field-wide"><span class="field-label">Deck name</span>
          <input class="input" name="title" placeholder="e.g. Unit 3 verbs" maxlength="60">
        </label>
        <label class="field"><span class="field-label">Unit for all words</span>
          <input class="input" name="unit" list="unit-options" placeholder="No unit" autocomplete="off" maxlength="40">
        </label>
        <label class="field"><span class="field-label">Difficulty level</span>
          <select class="input" name="level"><option value="">None</option>${DIFFICULTIES.map(l => html`<option value="${l}">${l}</option>`)}</select>
        </label>
      </div>
      ${unitOptions(app)}
    </section>

    <section class="card preview">
      <header class="card-head"><h2>3. Check and import</h2><span class="card-meta preview-status">Nothing to import yet</span></header>
      <div class="preview-list"></div>
      <button class="btn btn-primary btn-block btn-lg" data-import disabled>${icon('check')}Import deck</button>
      <p class="muted small">Imported decks are saved on this device only. To get a deck on every device, open it, tap Download JSON, and add the file to <code>words/</code> in your repository.</p>
    </section></div>`;

  return {
    body,
    mount(root) {
      const $ = sel => root.querySelector(sel);
      const field = name => root.querySelector(`[name=${name}]`);
      const textarea = $('textarea');
      let text = '';
      let filename = '';
      let parsed = parseImport('');
      let timer;

      const langValue = () => (field('lang').value === 'other' ? field('langCode').value.trim().toLowerCase() : field('lang').value);

      const applyMeta = meta => {
        if (meta.lang) {
          const code = String(meta.lang).toLowerCase();
          if (![...field('lang').options].some(o => o.value === code)) field('lang').add(new Option(`${langFlag(code)} ${langName(code)}`, code), 0);
          field('lang').value = code;
        }
        if (meta.from && [...field('from').options].some(o => o.value === meta.from)) field('from').value = meta.from;
        if (meta.type && [...field('type').options].some(o => o.value === meta.type)) field('type').value = meta.type;
        if (meta.title && !field('title').value) field('title').value = meta.title;
        if (meta.unit != null && !field('unit').value) field('unit').value = unitKey(meta.unit) || '';
        if (meta.level && levelKey(meta.level)) field('level').value = levelKey(meta.level);
        root.querySelector('.field-other').hidden = field('lang').value !== 'other';
      };

      const update = () => {
        parsed = parseImport(text, filename);
        applyMeta(parsed.meta);
        const status = $('.preview-status');
        const list = $('.preview-list');
        if (parsed.error) {
          status.textContent = 'Could not read this';
          list.innerHTML = html`<div class="notice notice-bad">${icon('alert')}<span>${parsed.error}</span></div>`.s;
        } else if (!parsed.words.length) {
          status.textContent = text.trim() ? 'No words found' : 'Nothing to import yet';
          list.innerHTML = text.trim() ? html`<div class="notice notice-warn">${icon('alert')}<span>No lines with a prompt and an answer were found. Check the accepted formats above.</span></div>`.s : '';
        } else {
          const extra = [parsed.duplicates && `${plural(parsed.duplicates, 'duplicate')} merged`, parsed.skipped && `${plural(parsed.skipped, 'line')} skipped`].filter(Boolean);
          status.textContent = [plural(parsed.words.length, 'word'), ...extra].join(' · ');
          list.innerHTML = html`<div class="word-list">${parsed.words.slice(0, 5).map(w => html`<div class="word-row">
            <div class="word-main"><div class="word-q">${w.q}</div><div class="word-a">${answersText(w.a)}</div></div></div>`)}</div>
            ${parsed.words.length > 5 ? html`<p class="muted small">…and ${parsed.words.length - 5} more</p>` : ''}`.s;
        }
        validate();
      };

      const validate = () => {
        const ok = parsed.words.length > 0 && field('title').value.trim() && /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(langValue());
        $('[data-import]').disabled = !ok;
      };

      onSegmented(root.querySelector('.list-form'), (name, value) => {
        if (name !== 'source') return;
        $('.source-paste').hidden = value !== 'paste';
        $('.source-file').hidden = value !== 'file';
      });

      textarea.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          text = textarea.value;
          filename = '';
          update();
        }, 150);
      });

      $('input[type=file]').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        text = await file.text();
        filename = file.name;
        textarea.value = text;
        $('.file-name').textContent = `Loaded ${file.name}`;
        update();
      });

      field('lang').addEventListener('change', () => {
        root.querySelector('.field-other').hidden = field('lang').value !== 'other';
        validate();
      });
      root.querySelectorAll('[name=langCode], [name=title]').forEach(el => el.addEventListener('input', validate));

      $('[data-import]').addEventListener('click', async () => {
        const lang = langValue();
        const result = saveImport(store.imports, {
          lang,
          from: field('from').value,
          type: field('type').value,
          title: field('title').value.trim(),
          unit: unitKey(field('unit').value),
          level: levelKey(field('level').value),
          words: parsed.words,
        });
        store.save('imports');
        await app.reload();
        store.lang = lang;
        store.save('lang');
        const note = result.merged ? ` (${result.merged} already there, answers merged)` : '';
        app.toast(`Added ${plural(result.added, 'word')} to "${field('title').value.trim()}"${note}`, { kind: 'success' });
        location.hash = deckHref({ id: result.id });
      });
    },
  };
}

export function importView(app, { mode = 'add' }) {
  const form = mode === 'list' ? listForm(app) : addForm(app);
  const body = html`
    ${segmented('mode', [{ value: 'add', label: 'Add one word' }, { value: 'list', label: 'Import a list' }], mode === 'list' ? 'list' : 'add')}
    ${form.body}`;
  return {
    title: mode === 'list' ? 'Import' : 'Add',
    back: 'decks',
    tab: 'decks',
    hideLang: true,
    body,
    mount(root) {
      root.querySelector('[data-name=mode]').addEventListener('click', e => {
        const btn = e.target.closest('[data-value]');
        if (btn) app.go(`import?mode=${btn.dataset.value}`, { replace: true });
      });
      form.mount(root);
    },
  };
}
