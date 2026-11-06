/**
 * Pure helpers that turn browser storage into portable entries and back, and keep AI keys out of them.
 *
 * Responsibility: decide which localStorage keys belong to the data file (TRACKED_PREFIXES), convert
 * every stored string to a JSON value and back (an exact round trip in memory), redact and refill AI
 * keys (and keep the keys of other providers across a restore), compare snapshots, fingerprint them
 * (contentHash), and keep the small sync bookkeeping record (META_KEY).
 * Where it fits: js/sync/engine.js is the only caller in the app; tests/js/snapshot.test.mjs covers it.
 * It uses nothing but the `storage` object passed in (the Web Storage interface: getItem, setItem,
 * removeItem, key, length), so it has no globals at import time and runs under gjs and node.
 *
 * Invariants:
 * - encodeValue/decodeValue round-trip every string byte for byte in memory. A value that went through
 *   the data file may come back with its object keys in another order (the server stores them sorted),
 *   which is semantically equal; canonical() ignores that order when comparing.
 * - META_KEY is never tracked, so bookkeeping never reaches the data file and is never wiped by a restore.
 * - Functions never mutate their inputs, except those whose job is to write to the given storage.
 */

/** localStorage key prefix saved in the data file: every profile of the language app. */
export const TRACKED_PREFIXES = ['vocab.'];

/** Storage key of the sync bookkeeping record {revision, dirty}; deliberately outside every tracked prefix. */
export const META_KEY = 'vocab-sync.meta';

/** Hosts (and their subdomains) that may receive the AI key from .env: only https URLs on these hosts. */
export const TRUSTED_KEY_HOSTS = ['openrouter.ai'];

/** Prefix whose entries are listed first when collecting keys (this app has only the one prefix). */
const PRIMARY_PREFIX = 'vocab.';

/** Property that marks a value stored as an unparsed string: {"$raw": "<original text>"}. */
const RAW_FIELD = '$raw';

/** Matches a UTF-16 surrogate that has no partner: a high one not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replacement for a lone surrogate (U+FFFD), the same character a UTF-8 encoder would produce. */
const REPLACEMENT_CHARACTER = '\uFFFD';

/** FNV-1a 32-bit parameters (offset basis and prime) used by contentHash. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Matches a hash made by contentHash: 8 lowercase hex digits. */
const HASH_PATTERN = /^[0-9a-f]{8}$/;

/**
 * Matches an https URL with a plain host: group 1 is the host, group 2 an optional numeric port.
 * Userinfo (`@`), backslashes, whitespace and any character outside letters, digits, dots and hyphens
 * before the first `/`, `?` or `#` make it fail, so look-alike URLs such as
 * `https://openrouter.ai@evil.example/` or `https://openrouter.ai\.evil.example/` are never trusted.
 */
const HTTPS_HOST_PATTERN = /^https:\/\/([a-z0-9.-]+)(?::(\d{1,5}))?(?:[/?#]|$)/i;

/**
 * Tells whether a localStorage key belongs to the data file.
 *
 * @param {string} key A localStorage key.
 * @returns {boolean} true when the key starts with one of TRACKED_PREFIXES.
 * @example
 * isTracked('vocab.account.a1'); // true
 * isTracked(META_KEY); // false
 */
export function isTracked(key) {
  return typeof key === 'string' && TRACKED_PREFIXES.some(prefix => key.startsWith(prefix));
}

/**
 * Tells whether a value is a plain JSON object (not null, not an array).
 *
 * @param {unknown} value Any value.
 * @returns {boolean} true for plain objects.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Tells whether a value is the {"$raw": text} wrapper produced by encodeValue for unparsable strings.
 *
 * @param {unknown} value Any value.
 * @returns {boolean} true when the value is an object whose only key is a string `$raw`.
 */
function isRawWrapper(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === RAW_FIELD && typeof value[RAW_FIELD] === 'string';
}

/**
 * Converts a stored string to the JSON value kept in the data file.
 *
 * The text is parsed only when `JSON.stringify(parsed)` gives exactly the same text again (so pretty
 * printing, `1.0`, `-0`, duplicate keys or odd escapes cannot change on the way back). Anything else,
 * and any object that already has a `$raw` key (it would be mistaken for the wrapper), is kept as
 * {"$raw": text}.
 *
 * @param {string} text The string returned by localStorage.getItem.
 * @returns {*} The parsed JSON value, or {$raw: text}.
 * @example
 * encodeValue('{"a":1}'); // {a: 1}
 * encodeValue('hello'); // {$raw: 'hello'}
 */
export function encodeValue(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Only "not JSON" is expected here; any other failure is a real bug and must surface.
    if (!(error instanceof SyntaxError)) throw error;
    return { [RAW_FIELD]: text };
  }
  const isExact = JSON.stringify(parsed) === text;
  const collidesWithWrapper = isPlainObject(parsed) && RAW_FIELD in parsed;
  return isExact && !collidesWithWrapper ? parsed : { [RAW_FIELD]: text };
}

/**
 * Converts a data-file value back to the string that was stored. Inverse of encodeValue: the string is
 * exact for the value it is given (object keys keep that value's order, which the server may have sorted).
 *
 * @param {*} value A JSON value from the data file, possibly the {$raw: text} wrapper.
 * @returns {string} The string to hand to localStorage.setItem.
 * @example
 * decodeValue({ a: 1 }); // '{"a":1}'
 * decodeValue({ $raw: 'hello' }); // 'hello'
 */
export function decodeValue(value) {
  return isRawWrapper(value) ? value[RAW_FIELD] : JSON.stringify(value);
}

/**
 * Lists the keys currently in a storage object.
 *
 * @param {Storage} storage A Web Storage compatible object.
 * @returns {string[]} Every key, tracked or not, in storage order.
 */
function allKeys(storage) {
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    keys.push(storage.key(index));
  }
  return keys;
}

/**
 * Reads every tracked key from storage into data-file entries.
 *
 * @param {Storage} storage A Web Storage compatible object.
 * @returns {Record<string, *>} Entries for tracked keys only, keys sorted, values from encodeValue.
 * @example
 * takeSnapshot(localStorage); // { 'vocab.settings': {...}, 'vocab.v2-progress': {...} }
 */
export function takeSnapshot(storage) {
  const entries = {};
  for (const key of allKeys(storage).filter(isTracked).sort()) {
    const text = storage.getItem(key);
    if (text !== null) entries[key] = encodeValue(text);
  }
  return entries;
}

/**
 * Makes the tracked part of storage equal to the given entries.
 *
 * Tracked keys missing from `entries` are removed, the others are written. Untracked keys (including
 * META_KEY) are never touched, and untracked keys inside `entries` are ignored, so a damaged data file
 * cannot overwrite bookkeeping or unrelated site data.
 *
 * @param {Storage} storage A Web Storage compatible object.
 * @param {Record<string, *>} entries Entries as stored in the data file.
 * @returns {void}
 */
export function applySnapshot(storage, entries) {
  // The key list is copied first because removing keys while indexing them would skip some.
  for (const key of allKeys(storage).filter(isTracked)) {
    if (!Object.hasOwn(entries, key)) storage.removeItem(key);
  }
  for (const key of Object.keys(entries).filter(isTracked)) {
    storage.setItem(key, decodeValue(entries[key]));
  }
}

/**
 * Tells whether a value looks like an AI settings object: a plain object with a string `key`
 * and a string `url` or `model`.
 *
 * @param {unknown} value Any value.
 * @returns {boolean} true for AI config objects.
 */
function isAiConfig(value) {
  return (
    isPlainObject(value) &&
    typeof value.key === 'string' &&
    (typeof value.url === 'string' || typeof value.model === 'string')
  );
}

/**
 * Tells whether an AI config may receive the .env key: its url is missing or empty, or it is an https
 * URL whose host is a trusted host or a subdomain of one.
 *
 * @param {{url?: unknown}} config An AI config object.
 * @returns {boolean} false for http URLs, other hosts and anything unparsable, so the key is never
 *   sent to an address the user did not choose for it.
 */
function isTrustedTarget(config) {
  if (typeof config.url !== 'string' || config.url.trim() === '') return true;
  const match = HTTPS_HOST_PATTERN.exec(config.url.trim());
  if (!match) return false;
  const host = match[1].toLowerCase();
  return TRUSTED_KEY_HOSTS.some(trusted => host === trusted || host.endsWith(`.${trusted}`));
}

/**
 * Replaces lone UTF-16 surrogates (for example half an emoji left by a string slice) with U+FFFD.
 * The server stores UTF-8 and rejects such strings, so one of them would otherwise stall every save.
 *
 * @param {string} text Any string.
 * @returns {string} The string with every lone surrogate replaced; well-formed pairs are untouched.
 */
function scrubSurrogates(text) {
  return text.replace(LONE_SURROGATE, REPLACEMENT_CHARACTER);
}

/**
 * Copies a JSON value, blanking the key of every AI config object and scrubbing lone surrogates.
 *
 * @param {*} node A JSON value.
 * @param {{found: Set<string>, trusted: Set<string>}} keys Receives each non-empty key that was removed
 *   (`found`) and those of them from configs that may receive the .env key (`trusted`).
 * @returns {*} A new value with no non-empty AI key; `node` is left unchanged.
 */
function redactNode(node, keys) {
  if (typeof node === 'string') return scrubSurrogates(node);
  if (Array.isArray(node)) return node.map(item => redactNode(item, keys));
  if (!isPlainObject(node)) return node;
  const isConfig = isAiConfig(node);
  if (isConfig && node.key !== '') {
    keys.found.add(node.key);
    if (isTrustedTarget(node)) keys.trusted.add(node.key);
  }
  // Object.fromEntries defines own properties, so a "__proto__" key from JSON cannot change the prototype.
  return Object.fromEntries(
    Object.entries(node).map(([name, child]) => [
      scrubSurrogates(name),
      name === 'key' && isConfig ? '' : redactNode(child, keys),
    ]),
  );
}

/**
 * Parses the text inside a {$raw: text} wrapper when it is JSON.
 *
 * @param {string} text The raw text.
 * @returns {{parsed: *} | null} The parsed value, or null when the text is not JSON.
 */
function parseRawText(text) {
  try {
    return { parsed: JSON.parse(text) };
  } catch (error) {
    // Only "not JSON" is expected here; any other failure is a real bug and must surface.
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

/**
 * Redacts one entry value. A {$raw: text} value is kept as is unless its text is JSON that holds an AI
 * key; then it is replaced by the parsed, redacted value (its layout may change, the key must go).
 *
 * @param {*} value An entry value.
 * @param {{found: Set<string>, trusted: Set<string>}} keys Collector for removed keys.
 * @returns {*} The redacted copy.
 */
function redactEntry(value, keys) {
  const parsedRaw = isRawWrapper(value) ? parseRawText(value[RAW_FIELD]) : null;
  if (parsedRaw === null) return redactNode(value, keys);
  const rawKeys = { found: new Set(), trusted: new Set() };
  const redacted = redactNode(parsedRaw.parsed, rawKeys);
  if (rawKeys.found.size === 0) return redactNode(value, keys);
  rawKeys.found.forEach(key => keys.found.add(key));
  rawKeys.trusted.forEach(key => keys.trusted.add(key));
  return redacted;
}

/**
 * Returns a deep copy of the entries with every AI key blanked and every lone surrogate replaced, plus
 * the keys that were found.
 *
 * Input is never mutated. `found` lists distinct non-empty keys; entries under 'vocab.' are scanned
 * first (the only prefix in this app). `trusted` lists the subset that
 * sits in configs fillSecrets would also fill (no url, or https on TRUSTED_KEY_HOSTS); the engine saves
 * the first of them that differs from .env's key to .env, so a key made for another provider is removed
 * from the file but never sent on.
 *
 * @param {Record<string, *>} entries Entries from takeSnapshot.
 * @returns {{entries: Record<string, *>, found: string[], trusted: string[]}} The redacted copy (same key
 *   order as the input), all removed keys and the trusted ones.
 * @example
 * redactSecrets({ 'vocab.s': { ai: { url: 'https://openrouter.ai/api/v1', key: 'sk-1' } } });
 * // { entries: { 'vocab.s': { ai: { url: '...', key: '' } } }, found: ['sk-1'], trusted: ['sk-1'] }
 */
export function redactSecrets(entries) {
  const names = Object.keys(entries);
  const scanOrder = [
    ...names.filter(name => name.startsWith(PRIMARY_PREFIX)),
    ...names.filter(name => !name.startsWith(PRIMARY_PREFIX)),
  ];
  const keys = { found: new Set(), trusted: new Set() };
  const redacted = new Map(scanOrder.map(name => [name, redactEntry(entries[name], keys)]));
  return {
    entries: Object.fromEntries(names.map(name => [scrubSurrogates(name), redacted.get(name)])),
    found: [...keys.found],
    trusted: [...keys.trusted],
  };
}

/**
 * Rewrites the key of AI config objects inside a JSON value, in place.
 *
 * @param {*} node A freshly parsed JSON value (safe to mutate).
 * @param {(config: object) => string | null} nextKey Decides the new key for one AI config; null leaves
 *   the config alone. A returned key equal to the current one counts as no change.
 * @returns {boolean} true when at least one config was changed.
 */
function rewriteNode(node, nextKey) {
  if (Array.isArray(node)) return node.map(item => rewriteNode(item, nextKey)).includes(true);
  if (!isPlainObject(node)) return false;
  let changed = false;
  if (isAiConfig(node)) {
    const key = nextKey(node);
    if (key !== null && key !== node.key) {
      node.key = key;
      changed = true;
    }
  }
  // Every child is visited (no short-circuit) so nested configs are rewritten too.
  const childResults = Object.values(node).map(child => rewriteNode(child, nextKey));
  return changed || childResults.includes(true);
}

/**
 * Applies `nextKey` to every AI config in the tracked part of storage and writes back what changed.
 *
 * @param {Storage} storage A Web Storage compatible object.
 * @param {(config: object, storageKey: string) => string | null} nextKey See rewriteNode; it also receives
 *   the storage key of the entry being rewritten.
 * @param {boolean} [includeRaw] Also rewrite `$raw` values whose text is JSON (their layout may change
 *   when they are rewritten). By default `$raw` values are skipped, as they hold no key the apps read.
 * @returns {boolean} true when at least one stored value was rewritten.
 */
function rewriteStoredConfigs(storage, nextKey, includeRaw = false) {
  let wrote = false;
  for (const key of allKeys(storage).filter(isTracked)) {
    let value = encodeValue(storage.getItem(key));
    if (isRawWrapper(value)) {
      const parsedRaw = includeRaw ? parseRawText(value[RAW_FIELD]) : null;
      if (parsedRaw === null) continue;
      value = parsedRaw.parsed;
    }
    if (!rewriteNode(value, config => nextKey(config, key))) continue;
    storage.setItem(key, decodeValue(value));
    wrote = true;
  }
  return wrote;
}

/**
 * Writes the .env AI key into tracked AI settings that have none (or, with `replace`, a different one).
 *
 * Only settings that may receive the key (no url, or an https url on TRUSTED_KEY_HOSTS) are touched; a
 * setting that points anywhere else never receives the key. Values stored as `$raw` text are skipped.
 *
 * @param {Storage} storage A Web Storage compatible object.
 * @param {string} aiKey The key read from .env; empty means nothing to do.
 * @param {{replace?: boolean}} [options] `replace: true` also overwrites a non-empty key that differs from
 *   `aiKey` (at startup .env is the source of truth); by default only empty keys are filled.
 * @returns {boolean} true when at least one stored value was rewritten.
 * @example
 * fillSecrets(localStorage, 'sk-env'); // fills empty keys
 * fillSecrets(localStorage, 'sk-env', { replace: true }); // also replaces stale keys
 */
export function fillSecrets(storage, aiKey, { replace = false } = {}) {
  if (!aiKey) return false;
  return rewriteStoredConfigs(storage, config => {
    if (!isTrustedTarget(config)) return null;
    return config.key === '' || replace ? aiKey : null;
  });
}

/**
 * Blanks the key of every tracked AI config that fillSecrets would fill (the .env key's home).
 *
 * Keys of configs for other providers are left alone: they are not in .env or the data file, so this
 * browser holds the only copy. `$raw` values that hold JSON are rewritten too (their layout may change).
 *
 * @param {Storage} storage A Web Storage compatible object.
 * @returns {boolean} true when at least one stored value was rewritten.
 */
export function blankTrustedKeys(storage) {
  return rewriteStoredConfigs(storage, config => (isTrustedTarget(config) ? '' : null), true);
}

/**
 * Collects the non-empty keys of tracked AI configs that point at an untrusted provider, by url.
 *
 * Such keys are never sent to .env or the data file, so a restore that overwrites storage with redacted
 * entries would erase them; the engine collects them before the restore and puts them back afterwards.
 * `$raw` values are skipped, as in fillSecrets.
 *
 * @param {Storage} storage A Web Storage compatible object.
 * @returns {Map<string, Map<string, string>>} Storage key to (config url to key). Keys are remembered per
 *   storage entry, so two accounts on the same provider keep their own keys; inside one entry the first
 *   config found for a url wins.
 * @example
 * collectUntrustedKeys(localStorage);
 * // Map { 'vocab.fr-settings' => Map { 'https://api.groq.com/openai/v1' => 'gsk_x' } }
 */
export function collectUntrustedKeys(storage) {
  const keys = new Map();
  /**
   * Records the key of every untrusted, non-empty AI config in a value.
   *
   * @param {*} node A parsed JSON value.
   * @returns {void}
   */
  const collect = node => {
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (!isPlainObject(node)) return;
    if (isAiConfig(node) && node.key !== '' && !isTrustedTarget(node) && !found.has(node.url)) {
      found.set(node.url, node.key);
    }
    Object.values(node).forEach(collect);
  };
  let found;
  for (const key of allKeys(storage).filter(isTracked)) {
    const value = encodeValue(storage.getItem(key));
    if (isRawWrapper(value)) continue;
    found = new Map();
    collect(value);
    if (found.size > 0) keys.set(key, found);
  }
  return keys;
}

/**
 * Puts keys collected by collectUntrustedKeys back into untrusted AI configs that have an empty key.
 *
 * A key only goes back into the storage entry it came from, to a config with the same url. Trusted configs,
 * configs that already have a key and urls not in the map are untouched.
 *
 * @param {Storage} storage A Web Storage compatible object.
 * @param {Map<string, Map<string, string>>} keysByEntry The result of collectUntrustedKeys.
 * @returns {boolean} true when at least one stored value was rewritten.
 */
export function restoreUntrustedKeys(storage, keysByEntry) {
  if (keysByEntry.size === 0) return false;
  return rewriteStoredConfigs(storage, (config, storageKey) => {
    if (isTrustedTarget(config) || config.key !== '') return null;
    return keysByEntry.get(storageKey)?.get(config.url) ?? null;
  });
}

/**
 * Serialises a JSON value to a string that does not depend on key order at any level.
 *
 * @param {*} value A JSON value.
 * @returns {string} JSON text with object keys sorted; arrays keep their order.
 */
function canonicalText(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  if (isPlainObject(value)) {
    const parts = Object.keys(value)
      .sort()
      .filter(name => value[name] !== undefined)
      .map(name => `${JSON.stringify(name)}:${canonicalText(value[name])}`);
    return `{${parts.join(',')}}`;
  }
  // undefined is not valid JSON; null keeps array positions stable like JSON.stringify does.
  return JSON.stringify(value) ?? 'null';
}

/**
 * Builds a key-order-independent string for comparing two sets of entries.
 *
 * @param {Record<string, *>} entries Entries from takeSnapshot, the data file or redactSecrets.
 * @returns {string} Equal for entries with the same content, whatever the order of their keys.
 * @example
 * canonical({ b: 1, a: { y: 1, x: 2 } }) === canonical({ a: { x: 2, y: 1 }, b: 1 }); // true
 */
export function canonical(entries) {
  return canonicalText(entries);
}

/**
 * Fingerprints a string with FNV-1a (32 bit). Not cryptographic: it only has to notice that content changed.
 *
 * @param {string} text Any string, usually from canonical().
 * @returns {string} 8 lowercase hex digits.
 * @example
 * contentHash(canonical({ 'vocab.a': 1 })); // e.g. 'a1b2c3d4'
 */
export function contentHash(text) {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // Math.imul keeps the multiplication in 32 bits; >>> 0 turns the result back into an unsigned number.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Tells whether a value is a valid revision number.
 *
 * @param {unknown} value Any value.
 * @returns {boolean} true for non-negative integers.
 */
function isRevision(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Reads the sync bookkeeping record.
 *
 * @param {Storage} storage A Web Storage compatible object.
 * @returns {{revision: number, dirty: boolean, hash?: string}} The stored record; defaults to
 *   {revision: 0, dirty: false} when it is missing, unreadable or has the wrong shape (a damaged record
 *   must not block syncing). `hash` (the contentHash of the content last synced) is present only when valid.
 */
export function readMeta(storage) {
  const defaults = { revision: 0, dirty: false };
  const text = storage.getItem(META_KEY);
  if (text === null) return defaults;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return defaults;
  }
  if (!isPlainObject(parsed)) return defaults;
  const meta = { revision: isRevision(parsed.revision) ? parsed.revision : 0, dirty: parsed.dirty === true };
  if (typeof parsed.hash === 'string' && HASH_PATTERN.test(parsed.hash)) meta.hash = parsed.hash;
  return meta;
}

/**
 * Stores the sync bookkeeping record.
 *
 * @param {Storage} storage A Web Storage compatible object.
 * @param {{revision: number, dirty: boolean, hash?: string}} meta The record to store; `hash` is optional.
 * @returns {void}
 * @throws {TypeError} When revision is not a non-negative integer, dirty is not a boolean or hash is
 *   given but is not 8 lowercase hex digits.
 */
export function writeMeta(storage, meta) {
  if (!isRevision(meta?.revision) || typeof meta.dirty !== 'boolean') {
    throw new TypeError('Sync meta needs a non-negative integer revision and a boolean dirty flag.');
  }
  if (meta.hash !== undefined && !(typeof meta.hash === 'string' && HASH_PATTERN.test(meta.hash))) {
    throw new TypeError('Sync meta hash must be 8 lowercase hex digits.');
  }
  const record = { revision: meta.revision, dirty: meta.dirty };
  if (meta.hash !== undefined) record.hash = meta.hash;
  storage.setItem(META_KEY, JSON.stringify(record));
}
