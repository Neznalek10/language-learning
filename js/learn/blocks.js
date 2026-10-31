import { compact, subjectPrefix, tenseInfo } from '../conj.js';
import { html, raw, esc, icon, answersText } from '../ui.js';

// **bold** and *French* inside lesson text; everything else is escaped.
export function rich(text) {
  return raw(esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em lang="fr">$1</em>'));
}

function conjTable(block, ctx) {
  const data = ctx.conj;
  const cells = data?.verbs[block.verb]?.t[block.tense];
  if (!cells) return html`<p class="muted small">No table for ${block.verb}.</p>`;
  return html`<div class="learn-table conj">
    <div class="learn-table-title" lang="fr">${block.verb} · ${tenseInfo(data, block.tense).label}</div>
    ${cells.map((forms, i) => (forms ? html`<div class="learn-row" lang="fr">
      <span class="learn-subject">${subjectPrefix(data, block.tense, i, forms[0])}</span><strong>${compact(forms)}</strong>
    </div>` : ''))}
  </div>`;
}

// Explanations are "cs" (Learn) or "en" (Grammar); a block uses whichever it has.
const say = o => o.en ?? o.cs;

// "textCols" lists the columns written in the explanation language, the rest are French.
// "csCols" and "firstCs" are the older names.
function grid(block) {
  const czech = new Set(block.textCols || block.csCols || (block.firstCs ? [0] : []));
  return html`<div class="learn-table">
    ${block.title ? html`<div class="learn-table-title">${block.title}</div>` : ''}
    <table>
      ${block.head ? html`<thead><tr>${block.head.map(h => html`<th>${h}</th>`)}</tr></thead>` : ''}
      <tbody>${block.rows.map(row => html`<tr>${row.map((cell, i) => html`<td ${czech.has(i) ? '' : raw('lang="fr"')}>${rich(cell)}</td>`)}</tr>`)}</tbody>
    </table>
  </div>`;
}

export const ruleHref = id => `#/rule/${encodeURIComponent(id)}`;

// Slots of a sentence diagram. The group decides the colour, the label is printed under the word.
export const SLOTS = {
  S: ['subject', 'subject'],
  V: ['verb', 'verb'],
  aux: ['verb', 'auxiliary'],
  part: ['verb', 'participle'],
  inf: ['verb', 'infinitive'],
  neg: ['neg', 'negation'],
  pron: ['pron', 'pronoun'],
  obj: ['noun', 'object'],
  noun: ['noun', 'noun'],
  art: ['noun', 'article'],
  adj: ['mod', 'adjective'],
  adv: ['mod', 'adverb'],
  time: ['circ', 'time'],
  place: ['circ', 'place'],
  prep: ['circ', 'preposition'],
  q: ['link', 'question word'],
  conj: ['link', 'conjunction'],
  x: ['plain', ''],
};

const slot = (type, text, label) => {
  const [group, name] = SLOTS[type] || SLOTS.x;
  return html`<span class="g-slot is-${group}"><span class="g-word">${text}</span><span class="g-label">${label ?? name}</span></span>`;
};

// {"formula": ["S", "neg?", ["V", "verb"]], "rows": [{"parts": [["S", "Je"], ["V", "suis"]], "en": "I am."}]}
function pattern(block) {
  const formula = (block.formula || []).map(f => {
    const [type, label] = Array.isArray(f) ? f : [f];
    const optional = type.endsWith('?');
    const key = type.replace(/\?$/, '');
    const [group, name] = SLOTS[key] || SLOTS.x;
    return html`<span class="g-chip is-${group} ${optional ? 'is-optional' : ''}">${label || name}</span>`;
  });
  return html`<div class="g-pattern">
    ${formula.length ? html`<div class="g-formula">${formula.map((f, i) => html`${i ? html`<span class="g-plus">+</span>` : ''}${f}`)}</div>` : ''}
    ${block.rows.map(row => html`<div class="g-sentence">
      <div class="g-slots" lang="fr">${row.parts.map(([type, text, label]) => slot(type, text, label))}</div>
      ${say(row) ? html`<div class="g-cs">${say(row)}</div>` : ''}
    </div>`)}
  </div>`;
}

// [[...]] marks the part that differs from Czech.
const marked = text => raw(esc(text).replace(/\[\[(.+?)\]\]/g, '<mark>$1</mark>'));

function compare(block) {
  return html`<div class="g-compare">${block.items.map(item => html`<div class="g-cmp">
    <div class="g-cmp-cs"><span class="g-cmp-tag">${item.en != null ? 'EN' : 'CZ'}</span>${say(item)}</div>
    ${item.wrong ? html`<div class="g-cmp-wrong" lang="fr">${icon('x')}<s>${item.wrong}</s></div>` : ''}
    <div class="g-cmp-fr" lang="fr">${icon('check')}<span>${marked(item.fr)}</span></div>
    ${item.note ? html`<div class="g-cmp-note">${rich(item.note)}</div>` : ''}
  </div>`)}</div>`;
}

function treeList(items, ctx) {
  return html`<ul>${items.map(item => {
    const target = item.see && ctx.grammar?.byId.get(item.see);
    return html`<li>
      <div class="g-node">${target ? html`<a href="${ruleHref(item.see)}">${rich(item.label)}</a>` : html`<strong>${rich(item.label)}</strong>`}${say(item) ? html`<span>${rich(say(item))}</span>` : ''}</div>
      ${item.children?.length ? treeList(item.children, ctx) : ''}
    </li>`;
  })}</ul>`;
}

const tree = (block, ctx) => html`<div class="g-tree">${block.title ? html`<div class="learn-table-title">${block.title}</div>` : ''}${treeList(block.items, ctx)}</div>`;

function see(block, ctx) {
  const rules = (block.rules || []).map(id => ctx.grammar?.byId.get(id)).filter(Boolean);
  const verbs = (block.verbs || []).filter(v => ctx.conj?.verbs[v]);
  if (!rules.length && !verbs.length) return html``;
  return html`<div class="g-see"><span>${block.label || 'See also'}</span>
    ${rules.map(a => html`<a class="g-link" href="${ruleHref(a.id)}">${a.title}</a>`)}
    ${verbs.map(v => html`<a class="g-link" href="#/verb/${encodeURIComponent(v)}" lang="fr">${v}</a>`)}
  </div>`;
}

// One renderer per Learn card type. A new card type is one more entry.
export const BLOCKS = {
  text: block => html`<p class="learn-p">${rich(say(block))}</p>`,
  table: (block, ctx) => (block.verb ? conjTable(block, ctx) : grid(block)),
  examples: block => html`<ul class="learn-examples">${block.items.map(ex => html`<li>
    <span class="learn-fr" lang="fr">${ex.fr}</span><span class="learn-cs">${say(ex)}</span>
  </li>`)}</ul>`,
  tip: block => html`<div class="learn-tip">${icon('bulb')}<div><strong>${block.title || (block.en != null ? 'Watch out' : 'Pozor')}</strong><p>${rich(say(block))}</p></div></div>`,
  vocab: (block, ctx) => html`<div class="word-list learn-vocab">${ctx.lesson.words.map(w => html`<div class="word-row">
    <div class="word-main"><div class="word-q">${w.q}</div><div class="word-a" lang="fr">${answersText(w.a)}</div></div>
  </div>`)}</div>`,
  check: () => html`<div class="learn-check" data-check></div>`,
  pattern,
  compare,
  tree,
  see,
};

export function renderBlock(block, ctx) {
  const render = BLOCKS[block.type];
  return render ? render(block, ctx) : html``;
}

// A lesson's "learn" is a list of cards: {"title": "...", "blocks": [...]}.
export function renderCard(card, ctx) {
  return html`${card.title ? html`<h2 class="learn-title">${card.title}</h2>` : ''}${card.blocks.map(b => renderBlock(b, ctx))}`;
}
