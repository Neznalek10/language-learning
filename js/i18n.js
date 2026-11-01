import { baseLang } from './data.js';
import { CS, CS_PATTERNS, CS_NOUNS } from './i18n-cs.js';

// Views write their texts in English. In Czech mode every text that reaches the screen is looked up in
// i18n-cs.js, so views don't need to know about languages and anything missing simply stays English.
const SKIP_TEXT = 'script, style, textarea, pre, code, [lang="fr"], [data-no-tr]';
const SKIP_ATTRS = '[lang="fr"], [data-no-tr]';
const ATTRS = ['placeholder', 'title', 'aria-label'];

const czech = () => baseLang() === 'cs';

export const locale = () => (czech() ? 'cs-CZ' : 'en-US');

export const csForm = (n, [one, few, many]) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);

// The noun for plural(): "5 words" becomes "5 slov".
export function nounFor(n, one, many) {
  const forms = czech() && CS_NOUNS[one];
  if (forms) return csForm(n, forms);
  return n === 1 ? one : many;
}

function lookup(key) {
  if (CS[key] !== undefined) return CS[key];
  for (const [re, rep] of CS_PATTERNS) {
    const m = key.match(re);
    const out = m && rep(...m.slice(1));
    if (out !== undefined && out !== null && out !== false) return out;
  }
  return undefined;
}

export function tr(text) {
  if (!czech()) return text;
  const key = text.replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z]/.test(key)) return text;
  let out = lookup(key);
  // "Message · Unit 2" and the like: each part on its own.
  if (out === undefined && key.includes(' · ')) {
    const parts = key.split(' · ');
    const done = parts.map(p => lookup(p) ?? p);
    if (done.some((p, i) => p !== parts[i])) out = done.join(' · ');
  }
  if (out === undefined) return text;
  return text.match(/^\s*/)[0] + out + text.match(/\s*$/)[0];
}

function translateText(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP_TEXT)) return;
  const next = tr(node.data);
  if (next !== node.data) node.data = next;
}

function translateAttrs(el) {
  if (el.closest(SKIP_ATTRS)) return;
  for (const name of ATTRS) {
    const value = el.getAttribute(name);
    if (!value) continue;
    const next = tr(value);
    if (next !== value) el.setAttribute(name, next);
  }
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  translateAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) translateText(node);
    else translateAttrs(node);
  }
}

// Translated text is never an English key, so the observer doesn't loop on its own changes.
export function startTranslating() {
  new MutationObserver(records => {
    if (!czech()) return;
    for (const r of records) {
      if (r.type === 'characterData') translateText(r.target);
      else if (r.type === 'attributes') translateAttrs(r.target);
      else r.addedNodes.forEach(translateTree);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  applyLanguage();
}

export function applyLanguage() {
  document.documentElement.lang = czech() ? 'cs' : 'en';
  if (czech()) translateTree(document.body);
}
