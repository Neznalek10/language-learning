import { store } from '../store.js';
import { ITEM_TYPES, DIFFICULTIES, langName, langFlag, saveImport } from '../data.js';
import { normalize } from '../check.js';
import { collectUnits, unitLabel } from '../units.js';
import { html, icon, segmented, onSegmented } from '../ui.js';

const NEW_DECK = '__new';

// Exactly what one word looks like inside a deck file's "words" list.
function wordJson({ q, answers, note, why, unit, level }) {
  const entry = { q, a: answers.length === 1 ? answers[0] : answers };
  if (note) entry.note = note;
  if (why) entry.why = why;
  entry.unit = unit || null;
  entry.level = level || null;
  return JSON.stringify(entry).replace(/":/g, '": ').replace(/,"/g, ', "');
}

export function unitOptions(app) {
  return html`<datalist id="unit-options">${collectUnits(app).map(u => html`<option value="${u.id}">${unitLabel(u.id)}${u.title ? ` · ${u.title}` : ''}</option>`)}</datalist>`;
}

export function addForm(app) {
  const memory = (app.ui.add ??= { type: 'word', lang: app.lang, deck: null, unit: '', level: '' });
  const type = ITEM_TYPES.find(t => t.key === memory.type) || ITEM_TYPES[0];
  const langs = app.languages();
  const lang = langs.includes(memory.lang) ? memory.lang : app.lang;
  const decks = app.decksFor(lang).filter(type.fitsDeck);
  const deckId = memory.deck === NEW_DECK || decks.some(d => d.id === memory.deck) ? memory.deck : decks[0]?.id || NEW_DECK;
  const from = decks.find(d => d.id === deckId)?.from || 'cs';

  const body = html`
    <section class="card">
      <header class="card-head"><h2>What are you adding?</h2></header>
      <div class="type-grid">${ITEM_TYPES.map(t => html`
        <button class="type-card ${t === type ? 'active' : ''}" data-type="${t.key}" aria-pressed="${String(t === type)}">
          <span class="type-icon">${icon(t.icon)}</span><strong>${t.label}</strong><small>${t.hint}</small>
        </button>`)}
      </div>
    </section>

    <section class="card">
      <header class="card-head"><h2>${type.label} details</h2></header>
      <div class="form-grid">
        <label class="field"><span class="field-label">Language</span>
          <select class="input" name="lang">${langs.map(c => html`<option value="${c}" ${c === lang ? 'selected' : ''}>${langFlag(c)} ${langName(c)}</option>`)}</select>
        </label>
        <label class="field"><span class="field-label">Deck</span>
          <select class="input" name="deck">
            ${decks.map(d => html`<option value="${d.id}" ${d.id === deckId ? 'selected' : ''}>${d.title}</option>`)}
            <option value="${NEW_DECK}" ${deckId === NEW_DECK ? 'selected' : ''}>New deck…</option>
          </select>
        </label>
        <label class="field field-wide field-new-deck" ${deckId === NEW_DECK ? '' : 'hidden'}><span class="field-label">New deck name</span>
          <input class="input" name="deckTitle" value="${type.newDeck.title}" maxlength="60">
        </label>
        <label class="field field-wide"><span class="field-label">${type.prompt.label} ${langName(from)}</span>
          <input class="input" name="q" placeholder="${type.prompt.placeholder}" autocomplete="off" maxlength="120">
        </label>
        <div class="field field-wide"><span class="field-label">${type.answers.label} ${langName(lang)}</span>
          <div class="answer-list"><input class="input" name="a" placeholder="${type.answers.placeholder}" autocomplete="off" lang="${lang}" maxlength="120"></div>
          <button class="btn btn-text btn-sm add-answer" type="button" data-more>${icon('plus')}Another correct answer</button>
        </div>
        <label class="field field-wide"><span class="field-label">Note <span class="muted">(optional)</span></span>
          <input class="input" name="note" placeholder="e.g. masculine, informal" autocomplete="off" maxlength="80">
        </label>
        <label class="field field-wide"><span class="field-label">Explanation <span class="muted">(optional, shown when you get it wrong)</span></span>
          <input class="input" name="why" placeholder="e.g. False friend: it doesn't mean..." autocomplete="off" maxlength="200">
        </label>
        <label class="field"><span class="field-label">Unit</span>
          <input class="input" name="unit" list="unit-options" placeholder="No unit" value="${memory.unit}" autocomplete="off" maxlength="40">
        </label>
        <div class="field field-wide"><span class="field-label">Difficulty level</span>
          ${segmented('level', [{ value: '', label: 'None' }, ...DIFFICULTIES.map(l => ({ value: l, label: l }))], memory.level)}
        </div>
      </div>
      ${unitOptions(app)}
      ${type.key === 'verb' ? html`<div class="notice conj-status" hidden></div>` : ''}
    </section>

    <section class="card">
      <header class="card-head"><h2>Format</h2><span class="card-meta">${deckId === NEW_DECK ? 'new deck' : `words/${deckId}.json`}</span></header>
      <pre class="json-preview"><code></code></pre>
      <div class="format-actions"><button class="btn btn-secondary btn-sm" data-copy>${icon('copy')}Copy</button></div>
      <p class="muted small">This is the line for the deck's "words" list in the repository. Leave out "unit" or set it to null when the ${type.label.toLowerCase()} isn't in a unit.</p>
      <p class="form-error" hidden></p>
      <button class="btn btn-primary btn-block btn-lg" data-add>${icon('plus')}Add ${type.label.toLowerCase()}</button>
      <p class="muted small">Saved on this device. Words can't be edited after they're added.</p>
    </section>`;

  function mount(root) {
    const field = name => root.querySelector(`[name=${name}]`);
    const error = root.querySelector('.form-error');
    let level = memory.level;

    const values = () => ({
      q: field('q').value.trim(),
      answers: [...root.querySelectorAll('[name=a]')].map(i => i.value.trim()).filter(Boolean),
      note: field('note').value.trim(),
      why: field('why').value.trim(),
      unit: field('unit').value.trim(),
      level,
    });

    const refresh = () => {
      const v = values();
      root.querySelector('.json-preview code').textContent = wordJson({
        ...v,
        q: v.q || type.prompt.placeholder.replace('e.g. ', ''),
        answers: v.answers.length ? v.answers : [type.answers.placeholder.replace('e.g. ', '')],
      });
      root.querySelector('.json-preview').classList.toggle('is-sample', !v.q && !v.answers.length);
      error.hidden = true;
      const status = root.querySelector('.conj-status');
      if (status) {
        const inf = v.answers[0];
        const known = inf && app.conj[lang]?.verbs[inf];
        status.hidden = !inf || !app.conj[lang];
        status.className = `notice conj-status ${known ? 'notice-good' : 'notice-warn'}`;
        status.innerHTML = known
          ? html`${icon('check')}<span>${inf} has conjugation tables, so it will show up in Tenses practice.</span>`.s
          : html`${icon('info')}<span>${inf} has no conjugation tables yet. Add it to a verb deck in the repository and run tools/conjugate.py.</span>`.s;
      }
    };

    const remember = () => Object.assign(memory, { lang: field('lang').value, deck: field('deck').value, unit: field('unit').value.trim(), level });

    root.querySelectorAll('[data-type]').forEach(btn => btn.addEventListener('click', () => {
      memory.type = btn.dataset.type;
      memory.deck = null;
      app.render();
    }));
    field('lang').addEventListener('change', () => {
      remember();
      memory.deck = null;
      app.render();
    });
    field('deck').addEventListener('change', () => {
      remember();
      app.render();
    });
    onSegmented(root, (name, value) => {
      if (name === 'level') level = value;
      refresh();
    });
    root.querySelector('[data-more]').addEventListener('click', () => {
      const input = Object.assign(document.createElement('input'), { className: 'input', name: 'a', autocomplete: 'off', maxLength: 120, lang });
      input.placeholder = 'Another correct answer';
      root.querySelector('.answer-list').append(input);
      input.focus();
    });
    root.addEventListener('input', refresh);

    root.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(root.querySelector('.json-preview code').textContent);
        app.toast('Copied', { kind: 'success' });
      } catch {
        app.toast('Copying is blocked here. Select the text instead.', { kind: 'error' });
      }
    });

    root.querySelector('[data-add]').addEventListener('click', async () => {
      const v = values();
      const fail = text => {
        error.textContent = text;
        error.hidden = false;
      };
      if (!v.q) return fail(`Enter the ${type.prompt.label.toLowerCase()} ${langName(from)}.`);
      if (!v.answers.length) return fail('Enter at least one correct answer.');
      const word = {
        q: v.q,
        a: v.answers.length === 1 ? v.answers[0] : v.answers,
        ...(v.note ? { note: v.note } : {}),
        ...(v.why ? { why: v.why } : {}),
        unit: v.unit || null,
        level: v.level || null,
      };
      const target = field('deck').value;
      remember();
      let deckTitle;
      if (target === NEW_DECK) {
        deckTitle = field('deckTitle').value.trim();
        if (!deckTitle) return fail('Name the new deck.');
        const existing = app.decksFor(lang).find(d => d.title.toLowerCase() === deckTitle.toLowerCase());
        if (existing && !existing.local) return fail(`A deck called ${existing.title} already exists. Pick it from the list.`);
        if (existing?.words.some(w => normalize(w.q) === normalize(v.q))) return fail(`"${v.q}" is already in ${existing.title}. Existing words can't be changed here.`);
        memory.deck = saveImport(store.imports, { lang, from, type: type.newDeck.type, title: deckTitle, words: [word] }).id;
        store.save('imports');
      } else {
        const deck = app.deck(target);
        deckTitle = deck.title;
        if (deck.words.some(w => normalize(w.q) === normalize(v.q))) return fail(`"${v.q}" is already in ${deck.title}. Existing words can't be changed here.`);
        (store.additions[target] ??= []).push(word);
        store.save('additions');
      }
      await app.reload();
      app.toast(`Added "${v.q}" to ${deckTitle}`, { kind: 'success' });
      app.render();
      document.querySelector('[name=q]')?.focus();
    });

    refresh();
  }

  return { body, mount };
}
