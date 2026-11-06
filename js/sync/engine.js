/**
 * Sync engine: keeps the browser's tracked localStorage keys and the server's data file in step.
 *
 * Responsibility: on start, decide whether this browser or the data file is newer (restore with one
 * reload, save, or just adopt the revision); afterwards watch tracked storage writes, save them after a
 * short debounce, when the page is hidden, and (small bodies only) on pagehide; keep AI keys out of the
 * data file by moving them to .env; resolve revision conflicts without losing the loser's data.
 * Where it fits: js/sync/page.js starts it on every page; js/views/account.js reads `syncState`, calls
 * syncNow and forgetKey. It uses js/sync/snapshot.js (pure storage/entry helpers) and a client made by
 * js/sync/client.js. Everything it touches (storage, client, window, session storage, timers) is passed to
 * startSync, so there are no globals at import time and tests run it with fakes.
 *
 * Invariants:
 * - Nothing is patched and nothing is sent unless /api/status answers with mode 'file'. The hooks go in
 *   before the startup network calls (they only count changes then) and come out again when startup fails
 *   or the page reloads.
 * - The wrapped Storage methods act only when `this` is the watched storage object; they are installed on
 *   the storage's prototype (never assigned on an instance, which would create an item named 'setItem').
 * - The engine's own writes (restore, fillSecrets, forgetKey) are muted, so they never mark data dirty.
 * - The data file never receives an AI key: every push is redacted first, and the key goes to .env. At
 *   startup .env wins over a different key held by this browser; keys for other providers stay in the
 *   browser only and survive a restore and forgetKey.
 * - Anything that would overwrite local data first saves it to data/conflicts/.
 * - Errors never reach the app's own code: hooks and handlers catch and report through `syncState.error`.
 */
import {
  isTracked,
  takeSnapshot,
  applySnapshot,
  redactSecrets,
  fillSecrets,
  blankTrustedKeys,
  collectUntrustedKeys,
  restoreUntrustedKeys,
  canonical,
  contentHash,
  META_KEY,
  readMeta,
  writeMeta,
} from './snapshot.js';
import { ConflictError, SyncHttpError } from './client.js';

/** How long after the last tracked change the data is saved, in milliseconds. */
export const DEBOUNCE_MS = 1500;

/** How long /api/status may take before the page is treated as having no server, in milliseconds. */
const STATUS_TIMEOUT_MS = 2500;

/** Browsers cap the body of a keepalive request at 64 KB; stay safely below it (bytes). */
const KEEPALIVE_LIMIT_BYTES = 60000;

/** Session-storage flag set once keys were filled in (or data restored) in this tab, to stop reload loops. */
const FILLED_FLAG = 'vocab-sync.filled';

/**
 * Session-storage flag holding the content hash of the data file the last page load restored before
 * reloading; cleared by the next start that needs no restore.
 */
const RESTORED_FLAG = 'vocab-sync.restored';

/**
 * Session-storage flag set when this page's data was stored in data/conflicts/ before a restore. It is not
 * cleared by a start, only by dismissConflictNotice, so the page that shows the notice may start after others.
 */
const CONFLICT_FLAG = 'vocab-sync.conflict';

/** Shown when the file to restore is the very content restored last time: it does not settle (see restoreFromRemote). */
const RESTORE_LOOP_MESSAGE = 'The data file could not be applied. Check data/language-data.json.';

/** The Storage methods whose calls are watched. */
const WATCHED_METHODS = ['setItem', 'removeItem', 'clear'];

/** Reason written next to local changes that lose against a newer data file at startup. */
const STARTUP_CONFLICT_REASON = 'Browser data replaced by a newer data file (found when the page opened).';

/** Reason written next to local changes that lose a save because the file moved on. */
const PUSH_CONFLICT_REASON = 'Browser data replaced by a newer data file (the save was rejected as stale).';

/** First HTTP status that means "the server itself failed" (as opposed to a missing route). */
const HTTP_SERVER_ERROR = 500;

/** What one push attempt ended with. */
const OUTCOME = Object.freeze({
  SAVED: 'saved',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  RELOADING: 'reloading',
});

/** Timer functions used when none are injected; looked up when called, not at import time. */
const DEFAULT_TIMERS = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: id => globalThis.clearTimeout(id),
};

/**
 * Builds the initial value of the shared state.
 *
 * @returns {object} A fresh state object in the 'starting' mode.
 */
function initialState() {
  return { mode: 'starting', revision: 0, savedAt: null, saving: false, error: '', hasAiKey: false, dataFile: '', conflictSaved: false };
}

/**
 * Observable sync state. The object identity never changes; fields are updated in place and
 * listeners registered with onSyncChange are called after each update.
 *
 * mode: 'starting' | 'file' | 'browser'; revision: last known file revision; savedAt: ISO time of the last
 * known save (or null); saving: a save request is in flight; error: last problem text ('' when fine);
 * hasAiKey: .env holds a key; dataFile: the data file's path as reported by the server; conflictSaved: an
 * earlier page load in this tab stored its data in data/conflicts/ and the notice is not dismissed yet.
 */
export const syncState = initialState();

/** Functions called after every state change. */
const listeners = new Set();

/** The promise returned by the first startSync call (a second call returns it again). */
let startPromise = null;

/** Runtime of the running engine, or null before startSync / after resetForTests. */
let current = null;

/**
 * Registers a function to be called after every change of `syncState`.
 *
 * @param {() => void} listener Called with no arguments.
 * @returns {() => void} Call it to stop listening.
 * @example
 * const stop = onSyncChange(() => render(syncState));
 */
export function onSyncChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Updates `syncState` in place and tells the listeners.
 *
 * @param {Partial<typeof syncState>} patch Fields to change.
 * @returns {void}
 */
function update(patch) {
  Object.assign(syncState, patch);
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      // A broken view must not break saving; report it and carry on with the other listeners.
      console.error('A sync listener failed:', error);
    }
  }
}

/**
 * Turns any thrown value into text for `syncState.error`.
 *
 * @param {unknown} error A caught value.
 * @returns {string} The message.
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rejects when a promise takes too long.
 *
 * @param {Promise<T>} promise The pending work.
 * @param {number} ms Time limit in milliseconds.
 * @param {typeof DEFAULT_TIMERS} timers Timer functions.
 * @returns {Promise<T>} The promise's result, or a rejection after `ms`.
 * @template T
 */
function withTimeout(promise, ms, timers) {
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = timers.setTimeout(() => reject(new Error(`No answer within ${ms} ms.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => timers.clearTimeout(timerId));
}

/**
 * Creates the mutable runtime for one started engine and checks the options.
 *
 * @param {object} options The startSync options.
 * @returns {object} The runtime: the injected objects plus revision, dirty flag, last pushed content,
 *   change counters, mute depth, the "reconciling" flag (startup in progress), the canonical text last
 *   sent by keepalive, debounce timer id, the push queue and the teardown function.
 * @throws {TypeError} When storage, client, win or session is missing.
 */
function createRuntime(options) {
  const { storage, client, win, session, debounceMs = DEBOUNCE_MS, timers = DEFAULT_TIMERS } = options;
  if (!storage || !client || !win || !session) {
    throw new TypeError('startSync needs storage, client, win and session.');
  }
  return {
    storage,
    client,
    win,
    session,
    timers,
    debounceMs,
    envKey: '',
    revision: 0,
    dirty: false,
    hash: undefined,
    lastPushed: null,
    changeCount: 0,
    pushMark: 0,
    muted: 0,
    reconciling: false,
    keepaliveText: null,
    stopped: false,
    timerId: null,
    chain: Promise.resolve(),
    teardown: () => {},
  };
}

/**
 * Runs a storage-writing function without the writes counting as user changes.
 *
 * @param {object} rt The runtime.
 * @param {() => T} write Function that writes to storage.
 * @returns {T} Whatever `write` returns.
 * @template T
 */
function muted(rt, write) {
  rt.muted += 1;
  try {
    return write();
  } finally {
    rt.muted -= 1;
  }
}

/**
 * Stores the in-memory revision, dirty flag and content hash in the bookkeeping record.
 *
 * @param {object} rt The runtime.
 * @returns {void}
 */
function persistMeta(rt) {
  const meta = { revision: rt.revision, dirty: rt.dirty };
  if (rt.hash !== undefined) meta.hash = rt.hash;
  writeMeta(rt.storage, meta);
}

/**
 * Reads the tracked browser data in the form the data file holds it.
 *
 * @param {object} rt The runtime.
 * @returns {{entries: object, found: string[], trusted: string[]}} The redacted entries and the AI keys
 *   removed from them (see redactSecrets).
 */
function localEntries(rt) {
  return redactSecrets(takeSnapshot(rt.storage));
}

/**
 * Cancels the pending debounced save, if any.
 *
 * @param {object} rt The runtime.
 * @returns {void}
 */
function cancelScheduledSave(rt) {
  if (rt.timerId === null) return;
  rt.timers.clearTimeout(rt.timerId);
  rt.timerId = null;
}

/**
 * Restarts the debounce timer so one save follows the last change after `debounceMs`.
 *
 * @param {object} rt The runtime.
 * @returns {void}
 */
function scheduleSave(rt) {
  cancelScheduledSave(rt);
  rt.timerId = rt.timers.setTimeout(() => {
    rt.timerId = null;
    pushNow(rt);
  }, rt.debounceMs);
}

/**
 * Records that the data file now holds `text` at `revision`, as far as this tab knows.
 *
 * Changes made while a save was in flight keep the dirty flag and schedule another save.
 *
 * @param {object} rt The runtime.
 * @param {number} revision The file's revision.
 * @param {string | null} savedAt The file's save time.
 * @param {string} text Canonical text of the redacted entries the file holds.
 * @returns {void}
 */
function markSynced(rt, revision, savedAt, text) {
  rt.revision = revision;
  rt.lastPushed = text;
  // The hash lets the next start notice edits made later while no server (and so no hook) was running.
  rt.hash = contentHash(text);
  rt.dirty = rt.changeCount !== rt.pushMark;
  persistMeta(rt);
  update({ revision, savedAt, error: '' });
  if (rt.dirty) scheduleSave(rt);
}

/**
 * Saves the AI key typed in this browser to .env: the first trusted key that differs from the one .env has.
 *
 * At startup every trusted setting is made equal to .env (see adoptEnvKey), so a key that differs is the
 * one changed in this session, whichever profile it was typed in. With an empty .env this is the first trusted
 * key found. After the key is saved the other trusted settings get it too, otherwise their old
 * key would differ on the next save and be sent to .env in turn.
 *
 * @param {object} rt The runtime.
 * @param {string[]} trusted Keys from AI settings that may receive the .env key (see redactSecrets), in scan
 *   order. Keys for other providers are not in this list, so they are never sent on.
 * @returns {Promise<void>}
 * @throws {Error} When the server refuses the key; the caller must then not save the data.
 */
async function captureKey(rt, trusted) {
  const newKey = trusted.find(candidate => candidate !== rt.envKey);
  if (newKey === undefined) return;
  await rt.client.saveKeys({ AI_API_KEY: newKey });
  rt.envKey = newKey;
  muted(rt, () => fillSecrets(rt.storage, newKey, { replace: true }));
  update({ hasAiKey: true });
}

/**
 * Saves a key typed in this browser to .env when .env has none, so no key stays only in one browser.
 *
 * @param {object} rt The runtime.
 * @returns {Promise<void>}
 * @throws {Error} When the server refuses the key.
 */
async function captureKeyIfEnvEmpty(rt) {
  if (rt.envKey !== '') return;
  await captureKey(rt, localEntries(rt).trusted);
}

/**
 * Stores the current redacted browser data in data/conflicts/, repeating until the copy is current.
 *
 * Edits made while a copy is being uploaded are not in it, so the data is read again afterwards and one
 * more copy is stored if it changed. The last read happens right before the caller overwrites the data
 * (no await in between), so nothing can be lost between copy and overwrite.
 *
 * @param {object} rt The runtime.
 * @param {string} reason Why the data is being replaced (stored in the conflict file).
 * @returns {Promise<void>}
 * @throws {Error} When the server cannot store a copy; the caller must then keep the browser data.
 */
async function saveConflictCopy(rt, reason) {
  let storedText = null;
  for (;;) {
    const { entries } = localEntries(rt);
    const text = canonical(entries);
    if (text === storedText) return;
    await rt.client.postConflict({ entries, reason });
    storedText = text;
  }
}

/**
 * Replaces the tracked browser data with the data file's, then reloads the page once.
 *
 * Before the data is overwritten, a key typed in this browser is saved to .env when .env has none, so
 * the restore cannot lose it (fillSecrets puts it back right away), and, when `conflictReason` is given,
 * the browser data is stored in data/conflicts/ (see saveConflictCopy). Keys for providers other than the
 * trusted ones exist only in this browser (never in .env or the file), so they are collected before the
 * overwrite and put back afterwards.
 *
 * Two guards stop a restore-reload loop (for example a hand-edited file whose content does not survive a
 * round trip through storage): RESTORED_FLAG records the hash of the file restored last in this session
 * and a restore of that same content is refused (a restore of different content, because the file changed
 * again, is fine and updates the flag); and the stored hash is the file's, not the read-back's, so the
 * next start sees the browser as changed and saves its normalised data on top instead of restoring again.
 *
 * @param {object} rt The runtime.
 * @param {{revision: number, savedAt: string, entries: object}} remote The data file.
 * @param {string | null} [conflictReason] Reason for a conflict copy of the local data, or null for none.
 * @returns {Promise<void>}
 * @throws {Error} RESTORE_LOOP_MESSAGE when this session already restored this very file content;
 *   nothing is changed or reloaded then.
 */
async function restoreFromRemote(rt, remote, conflictReason = null) {
  const remoteHash = contentHash(canonical(remote.entries));
  if (rt.session.getItem(RESTORED_FLAG) === remoteHash) throw new Error(RESTORE_LOOP_MESSAGE);
  await captureKeyIfEnvEmpty(rt);
  if (conflictReason !== null) {
    await saveConflictCopy(rt, conflictReason);
    // The reload hides the loss otherwise; the next start in this tab tells the user (see dismissConflictNotice).
    rt.session.setItem(CONFLICT_FLAG, '1');
  }
  muted(rt, () => {
    // Read right before the overwrite (no await in between) so a key typed meanwhile is kept as well.
    const untrustedKeys = collectUntrustedKeys(rt.storage);
    applySnapshot(rt.storage, remote.entries);
    fillSecrets(rt.storage, rt.envKey);
    restoreUntrustedKeys(rt.storage, untrustedKeys);
  });
  rt.revision = remote.revision;
  rt.dirty = false;
  rt.lastPushed = null;
  // The file's hash even if the read-back differs: then the next start pushes the normalised data.
  rt.hash = remoteHash;
  persistMeta(rt);
  // Keys are already filled, so the post-reload start must not reload again for this .env key.
  rt.session.setItem(FILLED_FLAG, filledMark(rt.envKey));
  rt.session.setItem(RESTORED_FLAG, remoteHash);
  rt.stopped = true;
  cancelScheduledSave(rt);
  update({ revision: remote.revision, savedAt: remote.savedAt, error: '' });
  rt.win.location.reload();
}

/**
 * Tells whether the newer file revision was saved by this browser itself, so this browser's data already
 * contains it and saving on top of it loses nothing.
 *
 * Two cases: another page of this browser saved it (pages share localStorage, so that page also wrote the
 * bookkeeping record, whose hash is then the hash of the file's content), or this tab's own keepalive save
 * on pagehide landed without the answer being seen (rt.keepaliveText is what it sent).
 *
 * @param {object} rt The runtime.
 * @param {{entries: object}} remote The data file as read after the rejection.
 * @returns {boolean} true when the file holds content saved by this browser.
 */
function fileSavedByThisBrowser(rt, remote) {
  const remoteText = canonical(remote.entries);
  return readMeta(rt.storage).hash === contentHash(remoteText) || remoteText === rt.keepaliveText;
}

/**
 * Handles a rejected save: adopts the file when it already equals the local data; builds on it when this
 * browser itself saved it (see fileSavedByThisBrowser: another page, or this tab's keepalive); otherwise stores the local data in
 * data/conflicts/ and restores the file.
 *
 * @param {object} rt The runtime.
 * @param {object} entries The redacted local entries that were rejected.
 * @param {boolean} canRetry Whether one more save on top of the file's revision may be tried; false on
 *   the retry itself, so a file that keeps moving ends in the conflict copy instead of looping.
 * @returns {Promise<string>} OUTCOME.SAVED or OUTCOME.RELOADING.
 * @throws {Error} When the file cannot be read or the conflict copy cannot be written.
 */
async function resolveConflict(rt, entries, canRetry) {
  const remote = await rt.client.getData();
  if (remote === null) {
    // The file vanished between the rejection and now; the next save is a first save again.
    rt.revision = 0;
    persistMeta(rt);
    throw new Error('The data file is missing on the server; the next save will create it.');
  }
  const text = canonical(entries);
  if (text === canonical(remote.entries)) {
    // Another save (for example a keepalive one from this tab) already stored the same data.
    markSynced(rt, remote.revision, remote.savedAt, text);
    return OUTCOME.SAVED;
  }
  if (canRetry && fileSavedByThisBrowser(rt, remote)) {
    // Another page of this browser (for example the French app, while this page sat in the back/forward
    // cache) or this tab's own keepalive save wrote the file and this page then edited on top of it:
    // save again on the file's revision.
    rt.revision = remote.revision;
    return putOrResolve(rt, entries, text, false);
  }
  await restoreFromRemote(rt, remote, PUSH_CONFLICT_REASON);
  return OUTCOME.RELOADING;
}

/**
 * Saves the redacted entries and resolves a stale revision.
 *
 * @param {object} rt The runtime.
 * @param {object} entries Redacted entries.
 * @param {string} text Canonical text of `entries`.
 * @param {boolean} [canRetry] Whether a rejection may be answered with one more save (see resolveConflict).
 * @returns {Promise<string>} OUTCOME.SAVED or OUTCOME.RELOADING.
 * @throws {Error} For any failure other than a revision conflict.
 */
async function putOrResolve(rt, entries, text, canRetry = true) {
  let saved;
  try {
    saved = await rt.client.putData({ baseRevision: rt.revision, entries });
  } catch (error) {
    if (error instanceof ConflictError) return resolveConflict(rt, entries, canRetry);
    throw error;
  }
  markSynced(rt, saved.revision, saved.savedAt, text);
  return OUTCOME.SAVED;
}

/**
 * Performs one save if there is something to save. Never rejects: failures go to `syncState.error` and
 * the dirty flag stays set, so the next change, visibility change or syncNow retries.
 *
 * @param {object} rt The runtime.
 * @returns {Promise<string>} One of OUTCOME.
 */
async function pushOnce(rt) {
  // A clean tab that has synced before has nothing to send; this keeps tab switches cheap.
  if (rt.stopped || (!rt.dirty && rt.lastPushed !== null)) return OUTCOME.SKIPPED;
  update({ saving: true });
  try {
    const { entries, trusted } = localEntries(rt);
    rt.pushMark = rt.changeCount;
    // The key moves to .env before anything else: redaction hides a changed key from the comparison below.
    await captureKey(rt, trusted);
    const text = canonical(entries);
    if (text === rt.lastPushed) {
      // The change was undone before it was saved; the file already has this content. A change made
      // while the key was being saved (counter moved) is still unsaved and gets its own save.
      rt.hash = contentHash(text);
      rt.dirty = rt.changeCount !== rt.pushMark;
      persistMeta(rt);
      if (rt.dirty) scheduleSave(rt);
      return OUTCOME.SKIPPED;
    }
    return await putOrResolve(rt, entries, text);
  } catch (error) {
    update({ error: describeError(error) });
    return OUTCOME.FAILED;
  } finally {
    update({ saving: false });
  }
}

/**
 * Queues a save right now (cancelling the debounce) behind any save already running.
 *
 * @param {object} rt The runtime.
 * @returns {Promise<string>} Resolves with the outcome of this save; never rejects.
 */
function pushNow(rt) {
  cancelScheduledSave(rt);
  rt.chain = rt.chain.then(() => pushOnce(rt));
  return rt.chain;
}

/**
 * Tells whether a watched Storage call changes tracked data.
 *
 * @param {string} method 'setItem', 'removeItem' or 'clear'.
 * @param {unknown[]} args The call's arguments.
 * @param {string | null} before The value stored under the key before the call (null if none).
 * @returns {boolean} true when tracked data may have changed.
 */
function changesTrackedData(method, args, before) {
  if (method === 'clear') return true;
  if (!isTracked(String(args[0]))) return false;
  // Writing the same text again changes nothing, so it must not cause a save (apps re-save on load).
  return method === 'setItem' ? before !== String(args[1]) : before !== null;
}

/**
 * Stores the dirty flag in the bookkeeping record without overwriting the revision and hash in it.
 *
 * Another page of this browser may have saved the file and updated the record since this page last wrote
 * it; keeping its revision and hash is what lets resolveConflict recognise the file as this browser's own.
 * When the record is missing (clear() wiped it) it is written again from this page's state.
 *
 * @param {object} rt The runtime (its dirty flag is already set).
 * @returns {void}
 */
function persistDirtyMeta(rt) {
  if (rt.storage.getItem(META_KEY) === null) {
    persistMeta(rt);
    return;
  }
  writeMeta(rt.storage, { ...readMeta(rt.storage), dirty: true });
}

/**
 * Marks the data dirty, stores that in the bookkeeping record and schedules a save.
 * Catches its own failures (for example a full storage) so the app's own write never throws because of sync.
 *
 * @param {object} rt The runtime.
 * @returns {void}
 */
function markDirtyAndSchedule(rt) {
  try {
    rt.dirty = true;
    persistDirtyMeta(rt);
    scheduleSave(rt);
  } catch (error) {
    update({ error: describeError(error) });
  }
}

/**
 * Reacts to a watched Storage call: counts the change, marks the data dirty and schedules a save.
 * While startup is reconciling it only counts: the bookkeeping record is not loaded yet, and
 * adoptChangesMadeDuringReconcile acts on the counter once reconcile is done.
 *
 * @param {object} rt The runtime.
 * @param {string} method 'setItem', 'removeItem' or 'clear'.
 * @param {unknown[]} args The call's arguments.
 * @param {string | null} before The value stored under the key before the call.
 * @returns {void}
 */
function noteStorageWrite(rt, method, args, before) {
  if (rt.muted > 0 || rt.stopped || !changesTrackedData(method, args, before)) return;
  rt.changeCount += 1;
  if (!rt.reconciling) markDirtyAndSchedule(rt);
}

/**
 * Wraps the watched Storage methods on the storage object's prototype.
 *
 * @param {object} rt The runtime.
 * @returns {() => void} Restores the original methods.
 */
function installStorageHooks(rt) {
  const proto = Object.getPrototypeOf(rt.storage);
  const originals = WATCHED_METHODS.map(method => [method, proto[method]]);
  for (const [method, original] of originals) {
    proto[method] = function watched(...args) {
      // Other Storage objects (sessionStorage) share the prototype and must pass through untouched.
      if (this !== rt.storage) return original.apply(this, args);
      const before = method === 'clear' ? null : rt.storage.getItem(String(args[0]));
      const result = original.apply(this, args);
      noteStorageWrite(rt, method, args, before);
      return result;
    };
  }
  return () => {
    for (const [method, original] of originals) proto[method] = original;
  };
}

/**
 * Measures the UTF-8 size of a string.
 *
 * @param {string} text Any text.
 * @returns {number} Size in bytes.
 */
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * Sends the data with a keepalive request when the page is going away, if it fits the browser's limit.
 * Larger data relies on the save made when the page became hidden.
 *
 * The sent text is remembered in rt.keepaliveText: if the page survives (back/forward cache) the request
 * may have landed, and the next rejected save recognises that file as this tab's own (resolveConflict).
 *
 * @param {object} rt The runtime.
 * @returns {void}
 */
function sendKeepalive(rt) {
  if (rt.stopped || !rt.dirty) return;
  try {
    const { entries } = localEntries(rt);
    const payload = { baseRevision: rt.revision, entries };
    if (byteLength(JSON.stringify(payload)) >= KEEPALIVE_LIMIT_BYTES) return;
    rt.keepaliveText = canonical(entries);
    rt.client.putDataKeepalive(payload);
  } catch (error) {
    update({ error: describeError(error) });
  }
}

/**
 * Listens for the page being hidden or unloaded.
 *
 * @param {object} rt The runtime.
 * @returns {() => void} Removes the listeners.
 */
function installPageListeners(rt) {
  /**
   * Saves right away when the page has just become hidden.
   *
   * @returns {void}
   */
  const onVisibilityChange = () => {
    // Hidden is the last moment a normal request is reliable (tab switch, mobile app switch, close).
    if (rt.win.document?.visibilityState === 'hidden') pushNow(rt);
  };
  /**
   * Sends the unsaved data with a keepalive request as the page unloads.
   *
   * @returns {void}
   */
  const onPageHide = () => sendKeepalive(rt);
  rt.win.addEventListener('visibilitychange', onVisibilityChange);
  rt.win.addEventListener('pagehide', onPageHide);
  return () => {
    rt.win.removeEventListener('visibilitychange', onVisibilityChange);
    rt.win.removeEventListener('pagehide', onPageHide);
  };
}

/**
 * Asks the server for its status within the time limit.
 *
 * @param {object} rt The runtime.
 * @returns {Promise<{status: object} | {failure: string} | null>} `{status}` when the server runs in file
 *   mode; `{failure}` (the server's message) when this app's server answers with a 5xx error, for example a
 *   damaged data file; null for any other failure, timeout or kind of answer, which all mean "use plain
 *   browser storage".
 */
async function probeServer(rt) {
  try {
    const status = await withTimeout(rt.client.status(), STATUS_TIMEOUT_MS, rt.timers);
    return status?.mode === 'file' ? { status } : null;
  } catch (error) {
    // Our own server reporting an internal error is still file mode: the user must see its message.
    if (error instanceof SyncHttpError && error.fromApi && error.status >= HTTP_SERVER_ERROR) {
      return { failure: error.message };
    }
    // Any other failure (no server, wrong server, slow server) simply means there is no file mode.
    return null;
  }
}

/**
 * Builds the value of the fill reload guard for one .env key.
 *
 * @param {string} envKey The .env key the page is being reloaded for.
 * @returns {string} A short fingerprint, so the key itself never goes to sessionStorage.
 */
function filledMark(envKey) {
  return contentHash(envKey);
}

/**
 * Reloads the page once so the app reads the filled-in keys, unless this tab already did that.
 *
 * @param {object} rt The runtime.
 * @param {boolean} alreadyWrote true when keys were already written earlier in this start (see
 *   adoptEnvKey), which also needs the reload.
 * @returns {boolean} true when the page is reloading.
 */
function fillKeysFromEnv(rt, alreadyWrote) {
  const wrote = muted(rt, () => fillSecrets(rt.storage, rt.envKey)) || alreadyWrote;
  // The flag stops a reload loop if filling never settles (for example a storage that drops writes). It
  // names the .env key it was set for, so a different .env key later in this tab still gets its reload and
  // the page cannot keep an old key in memory and save it back.
  const mark = filledMark(rt.envKey);
  if (!wrote || rt.session.getItem(FILLED_FLAG) === mark) return false;
  rt.session.setItem(FILLED_FLAG, mark);
  rt.stopped = true;
  rt.win.location.reload();
  return true;
}

/**
 * Tells whether the browser holds data the data file has never seen, which a restore would destroy.
 *
 * True when the dirty flag is set, or when there is tracked data and it differs from what was last synced
 * (hash mismatch, which catches edits made while no server ran) or nothing is known about the last sync
 * (no hash: an older browser or never synced).
 *
 * @param {object} rt The runtime (dirty flag and hash come from the stored meta).
 * @param {object} entries Redacted local entries.
 * @param {string} text Canonical text of `entries`.
 * @returns {boolean} true when a conflict copy must be written before restoring.
 */
function hasUnsavedLocalData(rt, entries, text) {
  if (rt.dirty) return true;
  if (Object.keys(entries).length === 0) return false;
  return rt.hash === undefined || contentHash(text) !== rt.hash;
}

/**
 * Decides what to do with an existing data file, whatever its revision.
 *
 * Both sides are compared with the fingerprint of the content last synced (`rt.hash`):
 * - same content: nothing to do, adopt the file's revision;
 * - file unchanged since the last sync (its hash matches): the browser is ahead, save it on top;
 * - file changed, browser not: restore the file (one reload);
 * - both changed: store the browser data in data/conflicts/, then restore the file.
 * A missing hash (older browser, never synced) counts as "changed" for both sides.
 *
 * @param {object} rt The runtime.
 * @param {{revision: number, savedAt: string, entries: object}} remote The data file.
 * @returns {Promise<boolean>} true when the page is reloading.
 */
async function syncWithRemote(rt, remote) {
  const { entries: local } = localEntries(rt);
  const localText = canonical(local);
  const remoteText = canonical(remote.entries);
  if (localText === remoteText) {
    // Same content (maybe under another revision, for example after a save whose answer was lost).
    markSynced(rt, remote.revision, remote.savedAt, remoteText);
    return false;
  }
  const remoteChanged = rt.hash === undefined || contentHash(remoteText) !== rt.hash;
  if (!remoteChanged) {
    // The file still holds what this browser last synced, so building on its revision loses nothing.
    rt.revision = remote.revision;
    rt.dirty = true;
    persistMeta(rt);
    return (await pushNow(rt)) === OUTCOME.RELOADING;
  }
  const reason = hasUnsavedLocalData(rt, local, localText) ? STARTUP_CONFLICT_REASON : null;
  await restoreFromRemote(rt, remote, reason);
  return true;
}

/**
 * Makes .env the source of truth for the AI key at startup: trusted AI settings holding another
 * non-empty key get the .env key. Without this, a browser with an old key would overwrite a newer
 * .env key on its next save (captureKey), and two machines would keep overwriting each other.
 * Must run before anything in reconcile can call captureKey. Does nothing when .env has no key.
 *
 * @param {object} rt The runtime (envKey already read).
 * @returns {boolean} true when stored settings were rewritten (the app needs a reload to read them).
 */
function adoptEnvKey(rt) {
  return muted(rt, () => fillSecrets(rt.storage, rt.envKey, { replace: true }));
}

/**
 * Brings browser and file into agreement (steps 2 to 6 of startup).
 *
 * @param {object} rt The runtime.
 * @param {object} status The server status.
 * @returns {Promise<boolean>} true when the page is reloading and the engine must not continue.
 */
async function reconcile(rt, status) {
  rt.envKey = (await rt.client.getKeys()).AI_API_KEY ?? '';
  const adoptedEnvKey = adoptEnvKey(rt);
  const remote = status.exists ? await rt.client.getData() : null;
  const meta = readMeta(rt.storage);
  rt.revision = meta.revision;
  rt.dirty = meta.dirty;
  rt.hash = meta.hash;
  update({ hasAiKey: rt.envKey !== '', revision: rt.revision, savedAt: status.savedAt ?? null });

  let reloading;
  if (remote === null) {
    // First save: this migrates whatever the browser already holds into the new data file.
    rt.revision = 0;
    rt.dirty = true;
    persistMeta(rt);
    reloading = (await pushNow(rt)) === OUTCOME.RELOADING;
  } else {
    reloading = await syncWithRemote(rt, remote);
  }
  if (reloading) return true;
  // A key typed while no server ran would otherwise wait for the next data change to reach .env.
  await captureKeyIfEnvEmpty(rt);
  return fillKeysFromEnv(rt, adoptedEnvKey);
}

/**
 * Acts on tracked writes the hooks only counted while startup was reconciling: when the counter moved
 * past the last save's mark, the data is marked dirty and a save is scheduled (a redundant save that
 * finds nothing new is harmless).
 *
 * @param {object} rt The runtime.
 * @returns {void}
 */
function adoptChangesMadeDuringReconcile(rt) {
  if (rt.changeCount !== rt.pushMark) markDirtyAndSchedule(rt);
}

/**
 * Installs the storage hooks, reconciles browser and file, and on success starts watching the page.
 *
 * The hooks go in before reconcile so writes made while its network calls run (for example an app saving
 * its settings after an async load) are not missed. They only count then (see noteStorageWrite). When
 * reconcile throws or the page is reloading, the hooks are removed again.
 *
 * @param {object} rt The runtime.
 * @param {object} status The server status.
 * @returns {Promise<void>}
 * @throws {Error} Whatever reconcile throws; nothing stays patched then.
 */
async function reconcileAndWatch(rt, status) {
  const removeHooks = installStorageHooks(rt);
  rt.reconciling = true;
  let watching = false;
  try {
    watching = !(await reconcile(rt, status));
  } finally {
    rt.reconciling = false;
    if (!watching) removeHooks();
  }
  if (!watching) return;
  // A start that needed no restore ends the "restored last time" state, so a later restore is allowed.
  rt.session.removeItem(RESTORED_FLAG);
  adoptChangesMadeDuringReconcile(rt);
  const removeListeners = installPageListeners(rt);
  rt.teardown = () => {
    removeHooks();
    removeListeners();
  };
}

/**
 * The whole startup sequence.
 *
 * @param {object} options The startSync options.
 * @returns {Promise<typeof syncState>} The shared state.
 */
async function runStartup(options) {
  const rt = createRuntime(options);
  current = rt;
  update({ conflictSaved: rt.session.getItem(CONFLICT_FLAG) !== null });
  const probe = await probeServer(rt);
  if (probe === null) {
    update({ mode: 'browser' });
    return syncState;
  }
  if (probe.failure !== undefined) {
    // No hooks and no saves until the next start: the server cannot be trusted with a write right now.
    rt.stopped = true;
    update({ mode: 'file', error: probe.failure });
    return syncState;
  }
  update({ mode: 'file', dataFile: probe.status.dataFile ?? '' });
  try {
    await reconcileAndWatch(rt, probe.status);
  } catch (error) {
    // The hooks are gone again, so the app keeps working on browser storage; Settings shows the problem.
    // Stopped also keeps syncNow from saving with a revision that was never reconciled.
    rt.stopped = true;
    update({ error: describeError(error) });
  }
  return syncState;
}

/**
 * Starts syncing this page with the server's data file. Call once per page; later calls return the same promise.
 *
 * @param {object} options Dependencies and settings.
 * @param {Storage} options.storage The watched localStorage.
 * @param {object} options.client A client from createClient.
 * @param {Window} options.win The window (location.reload, add/removeEventListener, document.visibilityState).
 * @param {Storage} options.session sessionStorage, for the reload-loop guard.
 * @param {number} [options.debounceMs] Delay between the last change and the save.
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers] Timer functions (tests inject fakes).
 * @returns {Promise<typeof syncState>} Resolves once startup finished (or the page started reloading).
 * @example
 * await startSync({ storage: localStorage, client: createClient(), win: window, session: sessionStorage });
 */
export function startSync(options = {}) {
  if (!startPromise) startPromise = runStartup(options);
  return startPromise;
}

/**
 * Saves now if there is anything unsaved (also retries a failed save). Resolves after the save finished;
 * a failure is reported in `syncState.error`, not thrown. Does nothing without file mode.
 *
 * @returns {Promise<void>}
 */
export async function syncNow() {
  if (!startPromise) return;
  await startPromise;
  if (syncState.mode !== 'file' || current.stopped) return;
  await pushNow(current);
}

/**
 * Removes the AI key from .env and blanks it in the browser's trusted AI settings (the ones the .env key
 * is filled into). Keys for other providers exist only in this browser, so they are left untouched.
 *
 * @returns {Promise<void>}
 * @throws {Error} When sync is not in file mode or the server refuses the change.
 */
export async function forgetKey() {
  if (!current || syncState.mode !== 'file') {
    throw new Error('Keys are only stored in .env when the local server is running.');
  }
  const rt = current;
  await rt.client.saveKeys({ AI_API_KEY: '' });
  rt.envKey = '';
  update({ hasAiKey: false });
  // Only keys are blanked, which the data file never contained, so this is not a change to save.
  muted(rt, () => blankTrustedKeys(rt.storage));
}

/**
 * Clears the "your changes were saved as a conflict" notice, in the state and in session storage, once the
 * user has been told. Does nothing before startSync.
 *
 * @returns {void}
 */
export function dismissConflictNotice() {
  if (!current) return;
  current.session.removeItem(CONFLICT_FLAG);
  update({ conflictSaved: false });
}

/**
 * Forgets everything: stops the engine, restores the Storage methods and clears state and listeners.
 * For tests only.
 *
 * @returns {void}
 */
export function resetForTests() {
  if (current) {
    cancelScheduledSave(current);
    current.teardown();
  }
  current = null;
  startPromise = null;
  listeners.clear();
  Object.assign(syncState, initialState());
}
