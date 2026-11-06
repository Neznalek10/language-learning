/**
 * Unit tests for js/sync/engine.js: startup decisions (first save, restore, adopt, conflict), debounced
 * saving, revision conflicts, AI key capture and refill, storage hooks, page listeners and browser mode.
 *
 * Where it fits: registered with the shared harness (tests/js/harness.mjs) and run by tests/js/run.mjs under
 * gjs or node. Everything the engine touches is faked: a class-based Storage (the engine patches its
 * prototype), a fake server client that applies the real revision rules (including 409 and the "no AI key
 * in entries" rule), a fake window that counts reloads and records listeners, and manual timers.
 */
import { test, assert } from './harness.mjs';
import {
  DEBOUNCE_MS,
  syncState,
  onSyncChange,
  startSync,
  syncNow,
  forgetKey,
  dismissConflictNotice,
  resetForTests,
} from '../../js/sync/engine.js';
import { ConflictError, SyncHttpError } from '../../js/sync/client.js';
import {
  META_KEY,
  canonical,
  contentHash,
  readMeta,
  redactSecrets,
  takeSnapshot,
} from '../../js/sync/snapshot.js';

/** The session-storage flag the engine sets once keys were filled in or data restored. */
const FILLED_FLAG = 'vocab-sync.filled';

/** The session-storage flag holding the hash of the file content restored last in this tab. */
const RESTORED_FLAG = 'vocab-sync.restored';

/** The session-storage flag set when a conflict copy was stored before a restore. */
const CONFLICT_FLAG = 'vocab-sync.conflict';

/** An AI provider the engine never sends the .env key to. */
const GROQ_URL = 'https://api.groq.com/openai/v1';

/** Matches the JSON escape (backslash, u, d8 to df, two hex digits) that JSON.stringify writes for a lone surrogate. */
const LONE_SURROGATE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i;

/** An AI config as the apps store it, with the given key. */
const aiSettings = key => ({ ai: { url: 'https://openrouter.ai/api/v1', model: 'm', key } });

/**
 * Makes a deep copy of JSON data.
 *
 * @param {*} value Any JSON value.
 * @returns {*} An independent copy.
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Creates a fresh Storage-like class. Each test gets its own class because the engine patches the prototype.
 *
 * @returns {Function} A class with getItem, setItem, removeItem, key, clear and length.
 */
function createStorageClass() {
  return class FakeStorage {
    /** @param {Record<string, string>} [initial] Starting items. */
    constructor(initial = {}) {
      this.map = new Map(Object.entries(initial));
    }

    /** Returns the stored text or null, like Storage.getItem. */
    getItem(key) {
      return this.map.has(key) ? this.map.get(key) : null;
    }

    /** Stores String(value), like Storage.setItem. */
    setItem(key, value) {
      this.map.set(key, String(value));
    }

    /** Deletes the key, like Storage.removeItem. */
    removeItem(key) {
      this.map.delete(key);
    }

    /** Returns the key at the index or null, like Storage.key. */
    key(index) {
      return [...this.map.keys()][index] ?? null;
    }

    /** Deletes every item, like Storage.clear. */
    clear() {
      this.map.clear();
    }

    /** Number of items, like Storage.length. */
    get length() {
      return this.map.size;
    }
  };
}

/**
 * Creates manual timers: callbacks run only when the test fires them.
 *
 * @returns {{pending: Map<number, {callback: Function, ms: number}>, setTimeout: Function,
 *   clearTimeout: Function, fireAll: () => void}} The timers.
 */
function createTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    pending,
    /** Registers a callback without running it; returns its id. */
    setTimeout(callback, ms) {
      const id = nextId++;
      pending.set(id, { callback, ms });
      return id;
    },
    /** Cancels a registered callback. */
    clearTimeout: id => pending.delete(id),
    /** Runs every registered callback once, in registration order. */
    fireAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const { callback } of due) callback();
    },
  };
}

/**
 * Creates a fake window that counts reloads and records listeners.
 *
 * @returns {object} The window with `reloads`, `listeners`, `document.visibilityState` and `dispatch`.
 */
function createWindow() {
  const win = {
    reloads: 0,
    listeners: { visibilitychange: [], pagehide: [] },
    document: { visibilityState: 'visible' },
    location: {
      /** Counts a page reload. */
      reload: () => (win.reloads += 1),
    },
    /** Records a listener for the event type. */
    addEventListener: (type, listener) => win.listeners[type].push(listener),
    /** Forgets a recorded listener. */
    removeEventListener: (type, listener) => {
      win.listeners[type] = win.listeners[type].filter(item => item !== listener);
    },
    /** Calls every listener of the event type, like the browser firing the event. */
    dispatch: type => win.listeners[type].forEach(listener => listener()),
  };
  return win;
}

/**
 * Builds a data file object.
 *
 * @param {number} revision Revision number.
 * @param {object} entries Entries (parsed JSON values).
 * @returns {object} The file as GET /api/data returns it.
 */
function fileOf(revision, entries) {
  return { app: 'language-learning', format: 1, revision, savedAt: `saved-${revision}`, entries };
}

/**
 * Creates a fake server client that applies the real rules: revision check with 409, and a 400 when the
 * entries still hold an AI key. Test hooks: `gate` delays putData, `putError`, `keysError`, `statusError`,
 * `statusHangs`, `statusBody` and `getDataError` make the matching call misbehave.
 *
 * @param {object} [options] Starting `file` (or null) and `envKey`.
 * @returns {object} The server state (`file`, `envKey`, logs) with its `client`.
 */
function createServer({ file = null, envKey = '' } = {}) {
  const server = {
    file,
    envKey,
    puts: [],
    conflicts: [],
    keySaves: [],
    keepalives: [],
    gate: null,
    putError: null,
    keysError: null,
    statusError: null,
    statusHangs: false,
    statusBody: null,
    getDataError: null,
  };
  server.client = {
    /** GET /api/status, or the failure selected by the test hooks. */
    async status() {
      if (server.statusError) throw server.statusError;
      if (server.statusHangs) return new Promise(() => {});
      return (
        server.statusBody ?? {
          app: 'language-learning',
          version: 'test',
          mode: 'file',
          dataFile: 'data/language-data.json',
          exists: server.file !== null,
          revision: server.file?.revision ?? 0,
          savedAt: server.file?.savedAt ?? null,
          hasAiKey: server.envKey !== '',
        }
      );
    },
    /** GET /api/keys. */
    getKeys: async () => ({ AI_API_KEY: server.envKey }),
    /** GET /api/data: a copy of the file, or null when there is none. */
    async getData() {
      if (server.getDataError) throw server.getDataError;
      return server.file ? clone(server.file) : null;
    },
    /** PUT /api/data with the real revision rule and the server's 400 rules (AI key, lone surrogate). */
    async putData({ baseRevision, entries }) {
      server.puts.push({ baseRevision, entries: clone(entries) });
      if (server.gate) await server.gate;
      if (server.putError) throw server.putError;
      const current = server.file?.revision ?? 0;
      if (baseRevision !== current) throw new ConflictError('Stale revision.', current);
      if (redactSecrets(entries).found.length > 0) throw new SyncHttpError('Entries contain an AI key.', 400);
      // JSON.stringify writes a lone surrogate as a backslash-u escape; the real server cannot encode those as UTF-8.
      if (LONE_SURROGATE_ESCAPE.test(JSON.stringify(entries))) throw new SyncHttpError('Invalid text.', 400);
      server.file = fileOf(current + 1, clone(entries));
      return { revision: server.file.revision, savedAt: server.file.savedAt };
    },
    /** POST /api/conflicts: records the conflict copy. */
    async postConflict({ entries, reason }) {
      server.conflicts.push({ entries: clone(entries), reason });
      return { file: 'data/conflicts/conflict.json' };
    },
    /** PUT /api/keys: stores the key, or fails when `keysError` is set. */
    async saveKeys(values) {
      if (server.keysError) throw server.keysError;
      server.keySaves.push(values.AI_API_KEY);
      server.envKey = values.AI_API_KEY;
      return { hasAiKey: server.envKey !== '' };
    },
    /** Records a keepalive save without applying it. */
    putDataKeepalive: payload => server.keepalives.push(clone(payload)),
  };
  return server;
}

/**
 * Builds a complete test environment and resets the engine.
 *
 * @param {object} [options] `local` (key -> JSON value stored as text), `raw` (key -> literal text), `meta`,
 *   `file`, `envKey` and `filled` (preset session flag).
 * @returns {object} The fakes plus `original` (the unpatched setItem) and `start` (runs startSync).
 */
function createEnv({ local = {}, raw = {}, meta = null, file = null, envKey = '', filled = false } = {}) {
  resetForTests();
  const Storage = createStorageClass();
  const initial = { ...raw };
  for (const [key, value] of Object.entries(local)) initial[key] = JSON.stringify(value);
  const storage = new Storage(initial);
  // hash: 'auto' means "the browser data is exactly what was last synced".
  if (meta) {
    const hash = meta.hash === 'auto' ? hashOf(storage) : meta.hash;
    storage.setItem(META_KEY, JSON.stringify({ ...meta, hash }));
  }
  const session = new Storage();
  if (filled) session.setItem(FILLED_FLAG, contentHash(envKey));
  const env = {
    Storage,
    storage,
    session,
    server: createServer({ file, envKey }),
    win: createWindow(),
    timers: createTimers(),
    original: Storage.prototype.setItem,
  };
  env.start = () =>
    startSync({ storage, client: env.server.client, win: env.win, session, timers: env.timers });
  return env;
}

/**
 * Creates an environment that has already done its first save, so hooks are installed and the file is revision 1.
 *
 * @param {object} [options] Same as createEnv.
 * @returns {Promise<object>} The started environment.
 */
async function startedEnv(options = {}) {
  const env = createEnv({ local: { 'vocab.a': { v: 0 } }, ...options });
  await env.start();
  return env;
}

/**
 * Waits for pending promise callbacks to run.
 *
 * @returns {Promise<void>} Resolves after a macrotask.
 */
function nextTick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Parses a stored JSON text.
 *
 * @param {object} storage The fake storage.
 * @param {string} key Storage key.
 * @returns {*} The parsed value, or null when the key is missing.
 */
function stored(storage, key) {
  const text = storage.getItem(key);
  return text === null ? null : JSON.parse(text);
}

/**
 * Reads the bookkeeping record without its content hash, for tests that only care about revision and dirty.
 *
 * @param {object} storage The fake storage.
 * @returns {{revision: number, dirty: boolean}} The stored revision and dirty flag.
 */
function readState(storage) {
  const { revision, dirty } = readMeta(storage);
  return { revision, dirty };
}

/**
 * Computes the content hash the engine stores for given (already redacted) entries.
 *
 * @param {object} entries Entries as the data file holds them.
 * @returns {string} The 8-digit hash of their canonical text.
 */
function hashOfEntries(entries) {
  return contentHash(canonical(entries));
}

/**
 * Computes the content hash the engine stores for the current tracked data of a storage.
 *
 * @param {object} storage The fake storage.
 * @returns {string} The 8-digit hash of the redacted, canonical entries.
 */
function hashOf(storage) {
  return contentHash(canonical(redactSecrets(takeSnapshot(storage)).entries));
}

// ---------------------------------------------------------------- startup: first save and restore

test('first start without a data file saves the existing browser data (migration) with base revision 0', async () => {
  const env = createEnv({
    local: { 'vocab.a': { x: 1 } },
    raw: { 'vocab.v2-p': 'plain text', 'other.key': 'not tracked' },
    envKey: 'sk-env',
  });
  await env.start();
  assert.deepEqual(env.server.puts.map(put => put.baseRevision), [0]);
  assert.deepEqual(env.server.file.entries, { 'vocab.a': { x: 1 }, 'vocab.v2-p': { $raw: 'plain text' } });
  assert.deepEqual(readState(env.storage), { revision: 1, dirty: false });
  assert.equal(env.win.reloads, 0);
  assert.equal(syncState.mode, 'file');
  assert.equal(syncState.revision, 1);
  assert.equal(syncState.savedAt, 'saved-1');
  assert.equal(syncState.dataFile, 'data/language-data.json');
  assert.equal(syncState.hasAiKey, true);
  assert.equal(syncState.error, '');
});

test('a missing data file with an older local revision still saves as a first save (base 0)', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 }, meta: { revision: 4, dirty: false } });
  await env.start();
  assert.deepEqual(env.server.puts.map(put => put.baseRevision), [0]);
  assert.deepEqual(readState(env.storage), { revision: 1, dirty: false });
});

test('a newer data file replaces tracked browser data with exactly one reload and installs no hooks', async () => {
  const env = createEnv({
    local: { 'vocab.a': { old: true }, 'vocab.gone': 1 },
    raw: { 'other.key': 'keep me' },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(3, { 'vocab.a': { fresh: true }, 'vocab.v2-p': { $raw: 'text' } }),
  });
  await env.start();
  assert.deepEqual(stored(env.storage, 'vocab.a'), { fresh: true });
  assert.equal(env.storage.getItem('vocab.gone'), null);
  assert.equal(env.storage.getItem('vocab.v2-p'), 'text');
  assert.equal(env.storage.getItem('other.key'), 'keep me');
  assert.equal(env.win.reloads, 1);
  assert.deepEqual(readState(env.storage), { revision: 3, dirty: false });
  assert.equal(env.session.getItem(FILLED_FLAG), contentHash(env.server.envKey));
  assert.equal(env.server.puts.length, 0);
  assert.equal(env.server.conflicts.length, 0);
  assert.equal(env.Storage.prototype.setItem, env.original);
  assert.equal(env.win.listeners.visibilitychange.length, 0);
});

test('a data file with a different revision but equal content is adopted without a reload', async () => {
  const env = createEnv({
    local: { 'vocab.a': { y: 2, x: 1 }, 'vocab.settings': aiSettings('sk-local') },
    meta: { revision: 2, dirty: false },
    file: fileOf(5, { 'vocab.a': { x: 1, y: 2 }, 'vocab.settings': aiSettings('') }),
    envKey: 'sk-local',
  });
  await env.start();
  assert.equal(env.win.reloads, 0);
  assert.deepEqual(readState(env.storage), { revision: 5, dirty: false });
  assert.equal(env.server.puts.length, 0);
  assert.equal(syncState.revision, 5);
  assert.ok(env.Storage.prototype.setItem !== env.original, 'hooks are installed');
});

test('unsaved local changes that lose against a newer file are saved as a conflict, then the file is restored', async () => {
  const env = createEnv({
    local: { 'vocab.a': { mine: true }, 'vocab.settings': aiSettings('sk-secret') },
    meta: { revision: 1, dirty: true },
    file: fileOf(2, { 'vocab.a': { theirs: true } }),
    envKey: 'sk-secret',
  });
  await env.start();
  assert.equal(env.server.conflicts.length, 1);
  assert.deepEqual(env.server.conflicts[0].entries, {
    'vocab.a': { mine: true },
    'vocab.settings': aiSettings(''),
  });
  assert.match(env.server.conflicts[0].reason, /newer data file/);
  assert.deepEqual(stored(env.storage, 'vocab.a'), { theirs: true });
  assert.equal(env.storage.getItem('vocab.settings'), null);
  assert.equal(env.win.reloads, 1);
});

test('browser data that never had a revision is saved as a conflict before a foreign file replaces it', async () => {
  const env = createEnv({ local: { 'vocab.a': { mine: true } }, file: fileOf(2, { 'vocab.a': { theirs: true } }) });
  await env.start();
  assert.deepEqual(env.server.conflicts.map(conflict => conflict.entries), [{ 'vocab.a': { mine: true } }]);
  assert.deepEqual(stored(env.storage, 'vocab.a'), { theirs: true });
  assert.equal(env.win.reloads, 1);
});

test('a clean browser without data restores the file without writing a conflict', async () => {
  const env = createEnv({ file: fileOf(2, { 'vocab.a': 1 }) });
  await env.start();
  assert.equal(env.server.conflicts.length, 0);
  assert.equal(stored(env.storage, 'vocab.a'), 1);
  assert.equal(env.win.reloads, 1);
});

test('a failing conflict copy stops the restore so nothing is lost', async () => {
  const env = createEnv({
    local: { 'vocab.a': { mine: true } },
    meta: { revision: 1, dirty: true },
    file: fileOf(2, { 'vocab.a': { theirs: true } }),
  });
  env.server.client.postConflict = async () => {
    throw new SyncHttpError('Disk full.', 500);
  };
  await env.start();
  assert.deepEqual(stored(env.storage, 'vocab.a'), { mine: true });
  assert.equal(env.win.reloads, 0);
  assert.equal(syncState.error, 'Disk full.');
  assert.equal(env.Storage.prototype.setItem, env.original);
});

// ---------------------------------------------------------------- startup: same revision

test('dirty data with an equal revision is saved at startup', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 2 } },
    meta: { revision: 2, dirty: true, hash: hashOfEntries({ 'vocab.a': { v: 1 } }) },
    file: fileOf(2, { 'vocab.a': { v: 1 } }),
  });
  await env.start();
  assert.deepEqual(env.server.puts.map(put => put.baseRevision), [2]);
  assert.equal(env.server.file.revision, 3);
  assert.deepEqual(readState(env.storage), { revision: 3, dirty: false });
});

test('content that differs under an equal revision (edited while no server ran) is saved at startup', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 2 } },
    meta: { revision: 2, dirty: false, hash: hashOfEntries({ 'vocab.a': { v: 1 } }) },
    file: fileOf(2, { 'vocab.a': { v: 1 } }),
  });
  await env.start();
  assert.equal(env.server.file.revision, 3);
  assert.deepEqual(env.server.file.entries, { 'vocab.a': { v: 2 } });
});

test('a clean browser at the file revision sends nothing', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 2, dirty: true },
    file: fileOf(2, { 'vocab.a': { v: 1 } }),
  });
  await env.start();
  assert.equal(env.server.puts.length, 0);
  assert.deepEqual(readState(env.storage), { revision: 2, dirty: false });
});

test('a failed first save keeps the data dirty, installs the hooks and a later syncNow succeeds', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 } });
  env.server.putError = new SyncHttpError('The server is busy.', 503);
  await env.start();
  assert.equal(syncState.error, 'The server is busy.');
  assert.deepEqual(readState(env.storage), { revision: 0, dirty: true });
  assert.ok(env.Storage.prototype.setItem !== env.original);
  env.server.putError = null;
  await syncNow();
  assert.equal(syncState.error, '');
  assert.deepEqual(readState(env.storage), { revision: 1, dirty: false });
});

test('an unreadable data file leaves the app on browser storage and reports the error', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 }, file: fileOf(2, {}) });
  env.server.getDataError = new SyncHttpError('The data file is damaged.', 500);
  await env.start();
  assert.equal(syncState.mode, 'file');
  assert.equal(syncState.error, 'The data file is damaged.');
  assert.equal(env.Storage.prototype.setItem, env.original);
  assert.equal(env.server.puts.length, 0);
});

// ---------------------------------------------------------------- browser mode

test('browser mode when status fails: nothing is patched, listened to or sent', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 } });
  env.server.statusError = new SyncHttpError('Not found.', 404);
  await env.start();
  assert.equal(syncState.mode, 'browser');
  assert.equal(env.Storage.prototype.setItem, env.original);
  assert.equal(env.win.listeners.visibilitychange.length + env.win.listeners.pagehide.length, 0);
  env.storage.setItem('vocab.a', '2');
  assert.equal(env.timers.pending.size, 0);
  assert.equal(env.storage.getItem(META_KEY), null);
  await syncNow();
  assert.equal(env.server.puts.length, 0);
});

test('browser mode when status does not answer within the time limit', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 } });
  env.server.statusHangs = true;
  const started = env.start();
  assert.equal(env.timers.pending.size, 1, 'the status time limit is armed');
  env.timers.fireAll();
  await started;
  assert.equal(syncState.mode, 'browser');
});

test('browser mode when the answer is not from this app (no mode "file")', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 } });
  env.server.statusBody = null;
  env.server.client.status = async () => ({ hello: 'other server' });
  await env.start();
  assert.equal(syncState.mode, 'browser');
});

test('startSync called twice returns the same promise and starts once', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 } });
  const first = env.start();
  const second = env.start();
  assert.ok(first === second);
  await first;
  assert.equal(env.server.puts.length, 1);
});

test('startSync rejects when a required dependency is missing', async () => {
  resetForTests();
  await assert.rejects(startSync({ storage: {} }), TypeError);
});

// ---------------------------------------------------------------- storage hooks and debounce

test('tracked changes mark dirty and schedule one save per burst after the debounce time', async () => {
  const env = await startedEnv();
  env.storage.setItem('vocab.a', '{"v":1}');
  env.storage.setItem('vocab.a', '{"v":2}');
  assert.equal(env.timers.pending.size, 1);
  assert.equal([...env.timers.pending.values()][0].ms, DEBOUNCE_MS);
  assert.deepEqual(readState(env.storage), { revision: 1, dirty: true });
  env.timers.fireAll();
  await syncNow();
  assert.deepEqual(env.server.puts.map(put => put.baseRevision), [0, 1]);
  assert.deepEqual(env.server.file.entries['vocab.a'], { v: 2 });
  assert.deepEqual(readState(env.storage), { revision: 2, dirty: false });
});

test('the debounce time can be injected', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 } });
  await startSync({
    storage: env.storage,
    client: env.server.client,
    win: env.win,
    session: env.session,
    timers: env.timers,
    debounceMs: 250,
  });
  env.storage.setItem('vocab.a', '2');
  assert.equal([...env.timers.pending.values()][0].ms, 250);
});

test('changes to untracked keys, unchanged values and other Storage objects do not schedule a save', async () => {
  const env = await startedEnv();
  env.storage.setItem('other.key', 'x');
  env.storage.setItem('vocab.a', '{"v":0}');
  env.storage.removeItem('vocab.missing');
  new env.Storage().setItem('vocab.a', 'elsewhere');
  env.session.setItem('vocab.a', 'session');
  assert.equal(env.timers.pending.size, 0);
  assert.deepEqual(readState(env.storage), { revision: 1, dirty: false });
});

test('removeItem of a tracked key and clear() both mark the data dirty and keep the bookkeeping record', async () => {
  const removed = await startedEnv();
  removed.storage.removeItem('vocab.a');
  assert.equal(removed.timers.pending.size, 1);
  assert.equal(readMeta(removed.storage).dirty, true);

  const cleared = await startedEnv();
  cleared.storage.clear();
  assert.equal(cleared.timers.pending.size, 1);
  assert.deepEqual(readState(cleared.storage), { revision: 1, dirty: true });
});

test('the hooks live on the prototype and never create an own setItem property on the storage', async () => {
  const env = await startedEnv();
  assert.equal(Object.hasOwn(env.storage, 'setItem'), false);
  assert.equal(env.storage.getItem('setItem'), null);
});

test('the application sees normal Storage behaviour through the hooks', async () => {
  const env = await startedEnv();
  env.storage.setItem('vocab.a', '{"v":5}');
  assert.equal(env.storage.getItem('vocab.a'), '{"v":5}');
  env.storage.removeItem('vocab.a');
  assert.equal(env.storage.getItem('vocab.a'), null);
});

test('resetForTests restores the Storage methods and removes the page listeners', async () => {
  const env = await startedEnv();
  assert.equal(env.win.listeners.visibilitychange.length, 1);
  assert.equal(env.win.listeners.pagehide.length, 1);
  resetForTests();
  assert.equal(env.Storage.prototype.setItem, env.original);
  assert.equal(env.win.listeners.visibilitychange.length + env.win.listeners.pagehide.length, 0);
  assert.equal(syncState.mode, 'starting');
});

// ---------------------------------------------------------------- saving and conflicts after startup

test('409 during a save stores the local data as a conflict, restores the file and reloads once', async () => {
  const env = await startedEnv();
  env.server.file = fileOf(5, { 'vocab.a': { v: 'other machine' } });
  env.storage.setItem('vocab.b', '"mine"');
  env.timers.fireAll();
  await syncNow();
  assert.equal(env.server.conflicts.length, 1);
  assert.deepEqual(env.server.conflicts[0].entries, { 'vocab.a': { v: 0 }, 'vocab.b': 'mine' });
  assert.match(env.server.conflicts[0].reason, /stale/);
  assert.deepEqual(stored(env.storage, 'vocab.a'), { v: 'other machine' });
  assert.equal(env.storage.getItem('vocab.b'), null);
  assert.equal(env.win.reloads, 1);
  assert.deepEqual(readState(env.storage), { revision: 5, dirty: false });
  // After the reload is requested the engine is inert, so a further change cannot start a second restore.
  env.storage.setItem('vocab.c', '1');
  assert.equal(env.timers.pending.size, 0);
});

test('409 when the file already holds the same data adopts its revision without a conflict or reload', async () => {
  const env = await startedEnv();
  env.server.file = fileOf(2, { 'vocab.a': { v: 9 } });
  env.storage.setItem('vocab.a', '{"v":9}');
  env.timers.fireAll();
  await syncNow();
  assert.equal(env.server.conflicts.length, 0);
  assert.equal(env.win.reloads, 0);
  assert.deepEqual(readState(env.storage), { revision: 2, dirty: false });
  assert.equal(syncState.revision, 2);
});

test('a failed save keeps the data dirty and the next syncNow retries', async () => {
  const env = await startedEnv();
  env.server.putError = new SyncHttpError('Disk full.', 500);
  env.storage.setItem('vocab.a', '{"v":3}');
  await syncNow();
  assert.equal(syncState.error, 'Disk full.');
  assert.equal(syncState.saving, false);
  assert.equal(readMeta(env.storage).dirty, true);
  env.server.putError = null;
  await syncNow();
  assert.equal(syncState.error, '');
  assert.equal(readMeta(env.storage).dirty, false);
  assert.deepEqual(env.server.file.entries['vocab.a'], { v: 3 });
});

test('a change made while a save is in flight is saved by a follow-up save', async () => {
  const env = await startedEnv();
  let release;
  env.server.gate = new Promise(resolve => (release = resolve));
  env.storage.setItem('vocab.a', '{"v":1}');
  env.timers.fireAll();
  await nextTick();
  assert.equal(syncState.saving, true);
  env.storage.setItem('vocab.a', '{"v":2}');
  env.server.gate = null;
  release();
  await syncNow();
  env.timers.fireAll();
  await syncNow();
  assert.deepEqual(env.server.file.entries['vocab.a'], { v: 2 });
  assert.deepEqual(readState(env.storage), { revision: env.server.file.revision, dirty: false });
});

test('undoing a change before it is saved sends nothing and clears the dirty flag', async () => {
  const env = await startedEnv();
  env.storage.setItem('vocab.a', '{"v":7}');
  env.storage.setItem('vocab.a', '{"v":0}');
  await syncNow();
  assert.equal(env.server.puts.length, 1);
  assert.equal(readMeta(env.storage).dirty, false);
});

test('syncNow with nothing to save does not touch the server', async () => {
  const env = await startedEnv();
  await syncNow();
  assert.equal(env.server.puts.length, 1);
});

test('syncNow before startSync resolves and does nothing', async () => {
  resetForTests();
  await syncNow();
  assert.equal(syncState.mode, 'starting');
});

// ---------------------------------------------------------------- page listeners

test('the page becoming hidden saves immediately with a normal request, visible does not', async () => {
  const env = await startedEnv();
  env.storage.setItem('vocab.a', '{"v":4}');
  env.win.dispatch('visibilitychange');
  await nextTick();
  assert.equal(env.server.puts.length, 1, 'visible: nothing sent yet');
  env.win.document.visibilityState = 'hidden';
  env.win.dispatch('visibilitychange');
  await syncNow();
  assert.deepEqual(env.server.file.entries['vocab.a'], { v: 4 });
  assert.equal(env.timers.pending.size, 0, 'the debounce timer was replaced by the immediate save');
});

test('pagehide sends a redacted keepalive save when the data is dirty and small', async () => {
  const env = await startedEnv({ local: { 'vocab.settings': aiSettings('sk-live') }, envKey: 'sk-live' });
  env.storage.setItem('vocab.a', '{"v":1}');
  env.win.dispatch('pagehide');
  assert.equal(env.server.keepalives.length, 1);
  assert.equal(env.server.keepalives[0].baseRevision, env.server.file.revision);
  assert.deepEqual(env.server.keepalives[0].entries['vocab.settings'], aiSettings(''));
  assert.deepEqual(env.server.keepalives[0].entries['vocab.a'], { v: 1 });
});

test('pagehide sends nothing when the data is clean', async () => {
  const env = await startedEnv();
  env.win.dispatch('pagehide');
  assert.equal(env.server.keepalives.length, 0);
});

test('pagehide skips the keepalive request when the body would exceed the browser limit', async () => {
  const env = await startedEnv();
  env.storage.setItem('vocab.big', JSON.stringify('x'.repeat(70000)));
  env.win.dispatch('pagehide');
  assert.equal(env.server.keepalives.length, 0);
});

test('the keepalive limit counts bytes, not characters', async () => {
  const env = await startedEnv();
  // 25 000 characters of 3 bytes each is far over the limit although the character count is under it.
  env.storage.setItem('vocab.big', JSON.stringify('€'.repeat(25000)));
  env.win.dispatch('pagehide');
  assert.equal(env.server.keepalives.length, 0);
});

// ---------------------------------------------------------------- AI keys

test('a key typed in the browser goes to .env and never into the data file', async () => {
  const env = createEnv({ local: { 'vocab.settings': aiSettings('sk-local'), 'vocab.a': 1 } });
  await env.start();
  assert.deepEqual(env.server.keySaves, ['sk-local']);
  assert.equal(env.server.envKey, 'sk-local');
  assert.deepEqual(env.server.file.entries['vocab.settings'], aiSettings(''));
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings('sk-local'));
  assert.equal(syncState.hasAiKey, true);
});

test('a key that equals the one in .env is not saved again, a changed key is (even when nothing else changes)', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('sk-one') },
    envKey: 'sk-one',
    meta: { revision: 1, dirty: false },
    file: fileOf(1, { 'vocab.settings': aiSettings('') }),
  });
  await env.start();
  env.storage.setItem('vocab.a', '1');
  await syncNow();
  assert.deepEqual(env.server.keySaves, []);
  env.storage.setItem('vocab.settings', JSON.stringify(aiSettings('sk-two')));
  await syncNow();
  assert.deepEqual(env.server.keySaves, ['sk-two']);
});

test('when .env cannot be written the data is not saved either and the error is shown', async () => {
  const env = createEnv({ local: { 'vocab.settings': aiSettings('sk-local') } });
  env.server.keysError = new SyncHttpError('.env is read-only.', 500);
  await env.start();
  assert.equal(env.server.puts.length, 0);
  assert.equal(syncState.error, '.env is read-only.');
  assert.equal(readMeta(env.storage).dirty, true);
});

test('a restore keeps a key typed in this browser by saving it to an empty .env first', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('sk-typed') },
    meta: { revision: 1, dirty: true },
    file: fileOf(2, { 'vocab.settings': aiSettings(''), 'vocab.a': 1 }),
  });
  await env.start();
  assert.equal(env.win.reloads, 1);
  assert.deepEqual(env.server.keySaves, ['sk-typed']);
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings('sk-typed'));
});

test('a key typed while no server ran reaches an empty .env at the next start even if nothing else changed', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('sk-offline') },
    meta: { revision: 1, dirty: false },
    file: fileOf(1, { 'vocab.settings': aiSettings('') }),
  });
  await env.start();
  assert.deepEqual(env.server.keySaves, ['sk-offline']);
  assert.equal(env.server.puts.length, 0);
});

test('empty key fields are filled from .env with one reload, and not marked dirty', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('') },
    meta: { revision: 1, dirty: false },
    file: fileOf(1, { 'vocab.settings': aiSettings('') }),
    envKey: 'sk-env',
  });
  await env.start();
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings('sk-env'));
  assert.equal(env.win.reloads, 1);
  assert.equal(env.session.getItem(FILLED_FLAG), contentHash(env.server.envKey));
  assert.deepEqual(readState(env.storage), { revision: 1, dirty: false });
  assert.equal(env.server.puts.length, 0);
});

test('the reload guard: after one fill-reload in this tab a fill never reloads again', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('') },
    meta: { revision: 1, dirty: false },
    file: fileOf(1, { 'vocab.settings': aiSettings('') }),
    envKey: 'sk-env',
    filled: true,
  });
  await env.start();
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings('sk-env'));
  assert.equal(env.win.reloads, 0);
  assert.ok(env.Storage.prototype.setItem !== env.original, 'sync still runs');
  assert.equal(env.timers.pending.size, 0, 'the fill itself is not a user change');
  assert.equal(readMeta(env.storage).dirty, false);
});

test('after the reload the second start finds nothing to fill and does not reload', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('') },
    meta: { revision: 1, dirty: false },
    file: fileOf(1, { 'vocab.settings': aiSettings('') }),
    envKey: 'sk-env',
  });
  await env.start();
  resetForTests();
  const secondWindow = createWindow();
  await startSync({
    storage: env.storage,
    client: env.server.client,
    win: secondWindow,
    session: env.session,
    timers: env.timers,
  });
  assert.equal(secondWindow.reloads, 0);
});

test('forgetKey clears .env and the key fields without scheduling a save', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('') },
    meta: { revision: 1, dirty: false },
    file: fileOf(1, { 'vocab.settings': aiSettings('') }),
    envKey: 'sk-env',
    filled: true,
  });
  await env.start();
  await forgetKey();
  assert.deepEqual(env.server.keySaves, ['']);
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings(''));
  assert.equal(syncState.hasAiKey, false);
  assert.equal(env.timers.pending.size, 0);
  assert.equal(readMeta(env.storage).dirty, false);
});

test('forgetKey refuses to run without file mode', async () => {
  resetForTests();
  await assert.rejects(forgetKey(), /\.env/);
});

// ---------------------------------------------------------------- state notifications

test('onSyncChange listeners hear state changes until they unsubscribe', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 } });
  let calls = 0;
  const stop = onSyncChange(() => (calls += 1));
  await env.start();
  assert.ok(calls > 0);
  stop();
  const before = calls;
  env.storage.setItem('vocab.a', '2');
  await syncNow();
  assert.equal(calls, before);
});

// ---------------------------------------------------------------- fix round 1: offline edits (F1)

test('F1: edits made while no server ran are saved as a conflict when the file moved on (hash differs)', async () => {
  const synced = { 'vocab.notes': ['original'] };
  const env = createEnv({
    local: { 'vocab.notes': ['offline edit'] },
    meta: { revision: 3, dirty: false, hash: contentHash(canonical(synced)) },
    file: fileOf(4, { 'vocab.notes': ['from another machine'] }),
  });
  await env.start();
  assert.deepEqual(env.server.conflicts.map(conflict => conflict.entries), [{ 'vocab.notes': ['offline edit'] }]);
  assert.deepEqual(stored(env.storage, 'vocab.notes'), ['from another machine']);
  assert.equal(env.win.reloads, 1);
});

test('F1: without a stored hash, tracked data that differs from a newer file is saved as a conflict', async () => {
  const env = createEnv({
    local: { 'vocab.notes': ['offline edit'] },
    meta: { revision: 3, dirty: false },
    file: fileOf(4, { 'vocab.notes': ['from another machine'] }),
  });
  await env.start();
  assert.equal(env.server.conflicts.length, 1);
  assert.equal(env.win.reloads, 1);
});

test('F1: browser data that still matches the stored hash is replaced without a conflict copy', async () => {
  const env = createEnv({
    local: { 'vocab.notes': ['unchanged'] },
    meta: { revision: 3, dirty: false, hash: 'auto' },
    file: fileOf(4, { 'vocab.notes': ['from another machine'] }),
  });
  await env.start();
  assert.equal(env.server.conflicts.length, 0);
  assert.deepEqual(stored(env.storage, 'vocab.notes'), ['from another machine']);
});

test('F1: the content hash follows every successful sync (save, adopt, restore)', async () => {
  const saved = createEnv({ local: { 'vocab.a': 1 } });
  await saved.start();
  assert.equal(readMeta(saved.storage).hash, hashOf(saved.storage));

  const adopted = createEnv({
    local: { 'vocab.a': 1 },
    meta: { revision: 1, dirty: false },
    file: fileOf(2, { 'vocab.a': 1 }),
  });
  await adopted.start();
  assert.equal(readMeta(adopted.storage).hash, hashOf(adopted.storage));

  const restored = createEnv({ file: fileOf(2, { 'vocab.a': 2 }) });
  await restored.start();
  assert.equal(readMeta(restored.storage).hash, hashOf(restored.storage));
});

test('F1: the content hash is refreshed by a later save', async () => {
  const env = await startedEnv();
  env.storage.setItem('vocab.a', '{"v":8}');
  await syncNow();
  assert.equal(readMeta(env.storage).hash, hashOf(env.storage));
});

// ---------------------------------------------------------------- fix round 1: surrogates and $raw keys (F2, F3)

test('F2: a lone surrogate never reaches the server (replaced in the copy), storage keeps its text', async () => {
  const env = createEnv({ raw: { 'vocab.a': '"half \ud83d"', 'vocab.b': '{"k\ud83d":["\udc00"]}' } });
  await env.start();
  assert.equal(syncState.error, '');
  assert.equal(env.server.puts.length, 1);
  assert.deepEqual(env.server.file.entries['vocab.a'], { $raw: 'half �'.replace('half ', '"half ') + '"' });
  assert.equal(env.storage.getItem('vocab.a'), '"half \ud83d"');
});

test('F2: a conflict copy is also free of lone surrogates', async () => {
  const env = createEnv({
    raw: { 'vocab.a': '"half \ud83d"' },
    meta: { revision: 1, dirty: true },
    file: fileOf(2, { 'vocab.a': 'theirs' }),
  });
  await env.start();
  assert.ok(!LONE_SURROGATE_ESCAPE.test(JSON.stringify(env.server.conflicts[0].entries)));
});

test('F3: an AI key inside pretty-printed JSON (stored as $raw) is kept out of the file and moved to .env', async () => {
  const pretty = JSON.stringify({ ai: { url: 'https://openrouter.ai/api/v1', model: 'm', key: 'sk-pretty' } }, null, 2);
  const env = createEnv({ raw: { 'vocab.settings': pretty } });
  await env.start();
  assert.deepEqual(env.server.keySaves, ['sk-pretty']);
  assert.deepEqual(env.server.file.entries['vocab.settings'], aiSettings(''));
  assert.equal(env.storage.getItem('vocab.settings'), pretty, 'the browser copy is untouched');
});

// ---------------------------------------------------------------- fix round 1: key trust (F4)

test('F4: only a key from a trusted AI setting goes to .env, a key for another provider stays out of both', async () => {
  const other = { ai: { url: 'https://api.example.com/v1', model: 'm', key: 'sk-other' } };
  const env = createEnv({ local: { 'vocab.settings': other, 'vocab.v2-cfg': aiSettings('sk-router') } });
  await env.start();
  assert.deepEqual(env.server.keySaves, ['sk-router']);
  assert.deepEqual(env.server.file.entries['vocab.settings'].ai.key, '');
  assert.deepEqual(env.server.file.entries['vocab.v2-cfg'], aiSettings(''));
});

test('F4: a key that only an untrusted setting holds is never sent to .env', async () => {
  const other = { ai: { url: 'https://api.example.com/v1', model: 'm', key: 'sk-other' } };
  const env = createEnv({ local: { 'vocab.settings': other } });
  await env.start();
  assert.deepEqual(env.server.keySaves, []);
  assert.equal(env.server.file.entries['vocab.settings'].ai.key, '');
});

// ---------------------------------------------------------------- fix round 1: server errors (F5)

test('F5: a 5xx JSON answer from this app\'s server is file mode with the message, no hooks and no saves', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 } });
  env.server.statusError = new SyncHttpError('The data file is damaged.', 500, true);
  await env.start();
  assert.equal(syncState.mode, 'file');
  assert.equal(syncState.error, 'The data file is damaged.');
  assert.equal(env.Storage.prototype.setItem, env.original);
  assert.equal(env.win.listeners.pagehide.length, 0);
  assert.equal(env.server.puts.length, 0);
  await syncNow();
  assert.equal(env.server.puts.length, 0);
});

test('F5: a 5xx answer that is not from this app\'s API still means browser mode', async () => {
  const env = createEnv({ local: { 'vocab.a': 1 } });
  env.server.statusError = new SyncHttpError('The server answered HTTP 502.', 502);
  await env.start();
  assert.equal(syncState.mode, 'browser');
  assert.equal(syncState.error, '');
});

// ---------------------------------------------------------------- fix round 1: change during key capture (F6)

test('F6: a change made while the key is being saved is not forgotten when the content looks unchanged', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('sk-one') },
    envKey: 'sk-one',
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(1, { 'vocab.settings': aiSettings('') }),
  });
  await env.start();
  const saveKeys = env.server.client.saveKeys;
  env.server.client.saveKeys = async values => {
    env.storage.setItem('vocab.b', '"late"');
    return saveKeys(values);
  };
  env.storage.setItem('vocab.settings', JSON.stringify(aiSettings('sk-two')));
  env.timers.fireAll();
  await syncNow();
  assert.deepEqual(env.server.file.entries['vocab.b'], 'late');
  assert.equal(readMeta(env.storage).dirty, false);
});

// ---------------------------------------------------------------- fix round 2: equal revision (F1)

/** The entries a browser and the file agreed on at the last sync in the equal-revision tests. */
const LAST_SYNCED = { 'vocab.a': { v: 0 } };

test('R2-F1: equal revision, equal content: nothing is sent and the hash is refreshed', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 5 } },
    meta: { revision: 3, dirty: false, hash: hashOfEntries(LAST_SYNCED) },
    file: fileOf(3, { 'vocab.a': { v: 5 } }),
  });
  await env.start();
  assert.equal(env.server.puts.length, 0);
  assert.equal(env.win.reloads, 0);
  assert.equal(readMeta(env.storage).hash, hashOfEntries({ 'vocab.a': { v: 5 } }));
});

test('R2-F1: equal revision, only the browser changed: the browser data is saved', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 3, dirty: false, hash: hashOfEntries(LAST_SYNCED) },
    file: fileOf(3, LAST_SYNCED),
  });
  await env.start();
  assert.deepEqual(env.server.file.entries, { 'vocab.a': { v: 1 } });
  assert.equal(env.server.file.revision, 4);
  assert.equal(env.win.reloads, 0);
  assert.equal(env.server.conflicts.length, 0);
});

test('R2-F1: equal revision, only the file changed: the file is restored without a conflict copy', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 3, dirty: false, hash: 'auto' },
    file: fileOf(3, { 'vocab.a': { v: 2 } }),
  });
  await env.start();
  assert.equal(env.server.puts.length, 0);
  assert.equal(env.server.conflicts.length, 0);
  assert.deepEqual(stored(env.storage, 'vocab.a'), { v: 2 });
  assert.equal(env.win.reloads, 1);
});

test('R2-F1: equal revision, both changed: a conflict copy of the browser data, then the file is restored', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 3, dirty: false, hash: hashOfEntries(LAST_SYNCED) },
    file: fileOf(3, { 'vocab.a': { v: 2 } }),
  });
  await env.start();
  assert.deepEqual(env.server.conflicts.map(conflict => conflict.entries), [{ 'vocab.a': { v: 1 } }]);
  assert.equal(env.server.puts.length, 0);
  assert.deepEqual(stored(env.storage, 'vocab.a'), { v: 2 });
  assert.equal(env.win.reloads, 1);
});

test('R2-F1: without a stored hash both sides count as changed (conflict copy, then restore)', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 3, dirty: false },
    file: fileOf(3, { 'vocab.a': { v: 2 } }),
  });
  await env.start();
  assert.equal(env.server.conflicts.length, 1);
  assert.deepEqual(stored(env.storage, 'vocab.a'), { v: 2 });
  assert.equal(env.win.reloads, 1);
});

test('R2-F1: a newer revision whose content is what this browser last synced is built on, not restored', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 3, dirty: false, hash: hashOfEntries(LAST_SYNCED) },
    file: fileOf(5, LAST_SYNCED),
  });
  await env.start();
  assert.deepEqual(env.server.puts.map(put => put.baseRevision), [5]);
  assert.deepEqual(env.server.file.entries, { 'vocab.a': { v: 1 } });
  assert.equal(env.win.reloads, 0);
});

// ---------------------------------------------------------------- fix round 2: edits during the conflict copy (F2)

test('R2-F2: edits made while the startup conflict copy is uploaded get their own copy before the restore', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 1, dirty: true },
    file: fileOf(2, { 'vocab.a': { v: 2 } }),
  });
  const postConflict = env.server.client.postConflict;
  let edited = false;
  env.server.client.postConflict = async payload => {
    if (!edited) {
      edited = true;
      env.storage.setItem('vocab.late', '"typed during upload"');
    }
    return postConflict(payload);
  };
  await env.start();
  assert.equal(env.server.conflicts.length, 2);
  assert.equal(env.server.conflicts[1].entries['vocab.late'], 'typed during upload');
  assert.equal(env.storage.getItem('vocab.late'), null);
  assert.equal(env.win.reloads, 1);
});

test('R2-F2: the same holds for a conflict found while saving', async () => {
  const env = await startedEnv();
  env.server.file = fileOf(5, { 'vocab.a': { v: 'other' } });
  const postConflict = env.server.client.postConflict;
  let edited = false;
  env.server.client.postConflict = async payload => {
    if (!edited) {
      edited = true;
      env.storage.setItem('vocab.late', '"typed during upload"');
    }
    return postConflict(payload);
  };
  env.storage.setItem('vocab.b', '"mine"');
  env.timers.fireAll();
  await syncNow();
  assert.equal(env.server.conflicts.length, 2);
  assert.equal(env.server.conflicts[0].entries['vocab.late'], undefined);
  assert.equal(env.server.conflicts[1].entries['vocab.late'], 'typed during upload');
  assert.equal(env.storage.getItem('vocab.late'), null);
});

// ---------------------------------------------------------------- fix round 3: restore-reload loop guards

/**
 * Starts a new engine on the same fakes (one more page load), with its own window.
 *
 * @param {object} env The environment from createEnv.
 * @returns {Promise<object>} The new window, to read its reload count.
 */
async function restartOn(env) {
  resetForTests();
  const win = createWindow();
  await startSync({ storage: env.storage, client: env.server.client, win, session: env.session, timers: env.timers });
  return win;
}

test('R3-F1: a file that does not survive storage ({"$raw": 5, "x": 1}) restores once, then saves normalised data', async () => {
  const env = createEnv({ file: fileOf(1, { 'vocab.a': { $raw: 5, x: 1 } }) });
  let reloads = 0;
  await env.start();
  reloads += env.win.reloads;
  for (let restart = 0; restart < 4; restart += 1) {
    reloads += (await restartOn(env)).reloads;
  }
  assert.equal(reloads, 1);
  assert.equal(env.storage.getItem('vocab.a'), '{"$raw":5,"x":1}');
  assert.equal(env.server.conflicts.length, 0);
  assert.equal(env.server.file.revision, 2, 'the normalised data was saved once on top of the file');
  assert.equal(syncState.error, '');
});

test('R3-F1: after a restore the stored hash is the file\'s, even when the read-back differs', async () => {
  const entries = { 'vocab.a': { $raw: 5, x: 1 } };
  const env = createEnv({ file: fileOf(1, entries) });
  await env.start();
  assert.equal(readMeta(env.storage).hash, hashOfEntries(entries));
});

test('R3-F1: restoring the same content again right after a restore stops with an error instead of reloading again', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(2, { 'vocab.a': { v: 2 } }),
  });
  // The flag holds the hash of the content restored last time; restoring that same content again is a loop.
  env.session.setItem(RESTORED_FLAG, hashOfEntries({ 'vocab.a': { v: 2 } }));
  await env.start();
  assert.equal(syncState.error, 'The data file could not be applied. Check data/language-data.json.');
  assert.equal(env.win.reloads, 0);
  assert.deepEqual(stored(env.storage, 'vocab.a'), { v: 1 });
  assert.equal(env.server.conflicts.length, 0);
  assert.equal(env.Storage.prototype.setItem, env.original);
});

test('R3-F1: a start that needs no restore clears the guard, so a later restore works again', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 2, dirty: false, hash: 'auto' },
    file: fileOf(2, { 'vocab.a': { v: 1 } }),
  });
  env.session.setItem('vocab-sync.restored', '1');
  await env.start();
  assert.equal(env.session.getItem('vocab-sync.restored'), null);
  env.server.file = fileOf(3, { 'vocab.a': { v: 9 } });
  const win = await restartOn(env);
  assert.equal(win.reloads, 1);
  assert.deepEqual(stored(env.storage, 'vocab.a'), { v: 9 });
});

// ---------------------------------------------------------------- fix round 1

/**
 * Simulates another page of the same browser saving `entries` as revision `revision`: the file moves on
 * and the shared bookkeeping record gets that revision and the content's hash, without this page's hooks
 * seeing anything (the unpatched setItem is used).
 *
 * @param {object} env The environment from createEnv.
 * @param {number} revision The new file revision.
 * @param {object} entries The redacted entries the other page saved.
 * @returns {void}
 */
function otherPageSaves(env, revision, entries) {
  env.server.file = fileOf(revision, entries);
  const meta = { revision, dirty: false, hash: hashOfEntries(entries) };
  env.original.call(env.storage, META_KEY, JSON.stringify(meta));
}

test('R1-F1: a newer revision saved by another page of this browser is built on, not stored as a conflict', async () => {
  const env = await startedEnv();
  // Another tab of the app wrote a change and saved rev 6; this page still thinks it is at rev 1.
  env.original.call(env.storage, 'vocab.fr-x', '{"n":1}');
  otherPageSaves(env, 6, { 'vocab.a': { v: 0 }, 'vocab.fr-x': { n: 1 } });
  env.storage.setItem('vocab.a', '{"v":5}');
  env.timers.fireAll();
  await syncNow();
  assert.equal(env.server.conflicts.length, 0);
  assert.equal(env.win.reloads, 0);
  assert.deepEqual(env.server.puts.map(put => put.baseRevision), [0, 1, 6]);
  assert.equal(env.server.file.revision, 7);
  assert.deepEqual(env.server.file.entries, { 'vocab.a': { v: 5 }, 'vocab.fr-x': { n: 1 } });
  assert.deepEqual(readState(env.storage), { revision: 7, dirty: false });
  assert.equal(syncState.revision, 7);
  assert.equal(syncState.error, '');
});

test('R1-F1: a file changed by another machine (hash differs from the stored record) still ends in a conflict copy', async () => {
  const env = await startedEnv();
  env.server.file = fileOf(5, { 'vocab.a': { v: 'other machine' } });
  env.storage.setItem('vocab.a', '{"v":5}');
  env.timers.fireAll();
  await syncNow();
  assert.equal(env.server.conflicts.length, 1);
  assert.equal(env.win.reloads, 1);
  assert.deepEqual(env.server.puts.map(put => put.baseRevision), [0, 1]);
});

test('R1-F1: when the retry also conflicts there is exactly one retry, then the conflict copy and restore', async () => {
  const env = await startedEnv();
  const realGetData = env.server.client.getData;
  let reads = 0;
  // Every read finds a file this browser saved, but another page saves again right after the read.
  env.server.client.getData = async () => {
    const copy = await realGetData();
    reads += 1;
    otherPageSaves(env, copy.revision + 1, { 'vocab.a': { v: 0 }, 'vocab.fr-x': { n: reads } });
    env.original.call(env.storage, META_KEY, JSON.stringify({ revision: copy.revision, dirty: false, hash: hashOfEntries(copy.entries) }));
    return copy;
  };
  otherPageSaves(env, 6, { 'vocab.a': { v: 0 }, 'vocab.fr-x': { n: 0 } });
  env.storage.setItem('vocab.a', '{"v":5}');
  env.timers.fireAll();
  await syncNow();
  assert.deepEqual(env.server.puts.map(put => put.baseRevision), [0, 1, 6]);
  assert.equal(reads, 2);
  assert.equal(env.server.conflicts.length, 1);
  assert.equal(env.win.reloads, 1);
});

test('R1-F2: a file that changed again after a restore is restored again instead of stopping sync', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(2, { 'vocab.a': { v: 2 } }),
  });
  await env.start();
  assert.equal(env.win.reloads, 1);
  assert.equal(env.session.getItem(RESTORED_FLAG), hashOfEntries({ 'vocab.a': { v: 2 } }));
  // Another tab or machine saved rev 3 before the reload finished.
  env.server.file = fileOf(3, { 'vocab.a': { v: 3 } });
  const win = await restartOn(env);
  assert.equal(win.reloads, 1);
  assert.equal(syncState.error, '');
  assert.deepEqual(stored(env.storage, 'vocab.a'), { v: 3 });
  assert.equal(env.session.getItem(RESTORED_FLAG), hashOfEntries({ 'vocab.a': { v: 3 } }));
  assert.equal(env.server.conflicts.length, 0);
});

test('R1-F3: a restore keeps the key of a provider that is not trusted and still fills the trusted one', async () => {
  const groqSettings = key => ({ ai: { url: GROQ_URL, model: 'llama', key } });
  const env = createEnv({
    local: { 'vocab.fr-settings': groqSettings('gsk_x'), 'vocab.settings': aiSettings(''), 'vocab.a': 1 },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(2, { 'vocab.fr-settings': groqSettings(''), 'vocab.settings': aiSettings(''), 'vocab.a': 2 }),
    envKey: 'sk-env',
  });
  await env.start();
  assert.equal(env.win.reloads, 1);
  assert.deepEqual(stored(env.storage, 'vocab.fr-settings'), groqSettings('gsk_x'));
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings('sk-env'));
  assert.equal(stored(env.storage, 'vocab.a'), 2);
  assert.deepEqual(env.server.keySaves, []);
});

test('R1-F3: the untrusted key never reaches the server or the conflict copy', async () => {
  const groqSettings = key => ({ ai: { url: GROQ_URL, model: 'llama', key } });
  const env = createEnv({
    local: { 'vocab.fr-settings': groqSettings('gsk_x'), 'vocab.a': 1 },
    meta: { revision: 1, dirty: true },
    file: fileOf(2, { 'vocab.fr-settings': groqSettings(''), 'vocab.a': 2 }),
  });
  await env.start();
  assert.equal(env.server.conflicts.length, 1);
  assert.equal(JSON.stringify(env.server.conflicts[0]).includes('gsk_x'), false);
  assert.deepEqual(env.server.keySaves, []);
  assert.deepEqual(stored(env.storage, 'vocab.fr-settings'), groqSettings('gsk_x'));
});

test('R1-F4: at startup .env wins over an older key held by this browser, and the page reloads once to read it', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('sk-old'), 'vocab.a': 1 },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(1, { 'vocab.settings': aiSettings(''), 'vocab.a': 1 }),
    envKey: 'sk-new',
  });
  await env.start();
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings('sk-new'));
  assert.deepEqual(env.server.keySaves, []);
  assert.equal(env.server.envKey, 'sk-new');
  assert.equal(env.win.reloads, 1);
  assert.equal(env.session.getItem(FILLED_FLAG), contentHash(env.server.envKey));
});

test('R1-F4: a startup save with an old key in the browser does not overwrite the newer .env key', async () => {
  const file = fileOf(1, { 'vocab.settings': aiSettings(''), 'vocab.a': 1 });
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('sk-old'), 'vocab.a': 2 },
    meta: { revision: 1, dirty: true, hash: hashOfEntries(file.entries) },
    file,
    envKey: 'sk-new',
  });
  await env.start();
  assert.deepEqual(env.server.puts.map(put => put.baseRevision), [1], 'the changed data was saved');
  assert.deepEqual(env.server.keySaves, []);
  assert.equal(env.server.envKey, 'sk-new');
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings('sk-new'));
});

test('R1-F4: a key changed in this browser during the session is still saved to .env', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('sk-env') },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(1, { 'vocab.settings': aiSettings('') }),
    envKey: 'sk-env',
  });
  await env.start();
  env.storage.setItem('vocab.settings', JSON.stringify(aiSettings('sk-typed')));
  await syncNow();
  assert.deepEqual(env.server.keySaves, ['sk-typed']);
});

test('R1-F5: forgetKey blanks the trusted key and keeps the key of another provider', async () => {
  const groqSettings = key => ({ ai: { url: GROQ_URL, model: 'llama', key } });
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('sk-env'), 'vocab.fr-settings': groqSettings('gsk_x') },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(1, { 'vocab.settings': aiSettings(''), 'vocab.fr-settings': groqSettings('') }),
    envKey: 'sk-env',
    filled: true,
  });
  await env.start();
  await forgetKey();
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings(''));
  assert.deepEqual(stored(env.storage, 'vocab.fr-settings'), groqSettings('gsk_x'));
  assert.deepEqual(env.server.keySaves, ['']);
  assert.equal(env.timers.pending.size, 0);
  assert.equal(readMeta(env.storage).dirty, false);
});

/**
 * Starts the engine on an environment whose /api/keys answer is held back, so the test can act while
 * startup is reconciling.
 *
 * @param {object} env The environment from createEnv.
 * @returns {{started: Promise<object>, release: () => void, fail: (error: Error) => void}} The pending
 *   start and the controls that let the held-back keys call finish or fail.
 */
function startWithHeldKeys(env) {
  let release;
  let fail;
  const gate = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  env.server.client.getKeys = async () => {
    await gate;
    return { AI_API_KEY: env.server.envKey };
  };
  return { started: env.start(), release, fail };
}

test('R1-F6: a tracked write made while startup reconciles marks the data dirty and is saved', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 }, 'vocab.settings': aiSettings('sk-typed') },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(1, { 'vocab.a': { v: 1 }, 'vocab.settings': aiSettings('') }),
  });
  // Startup ends by saving the typed key to the empty .env; hold that call, after the data was compared.
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const realSaveKeys = env.server.client.saveKeys;
  env.server.client.saveKeys = async values => {
    await gate;
    return realSaveKeys(values);
  };
  const started = env.start();
  await nextTick();
  assert.ok(env.Storage.prototype.setItem !== env.original, 'hooks are installed before reconcile');
  env.storage.setItem('vocab.a', '{"v":9}');
  assert.equal(env.timers.pending.size, 0, 'nothing is scheduled while reconciling');
  assert.equal(readMeta(env.storage).dirty, false, 'the bookkeeping record is not touched while reconciling');
  release();
  await started;
  assert.equal(readMeta(env.storage).dirty, true);
  assert.equal(env.timers.pending.size, 1, 'a save is scheduled once reconcile is done');
  env.timers.fireAll();
  await syncNow();
  assert.deepEqual(env.server.file.entries['vocab.a'], { v: 9 });
  assert.deepEqual(readState(env.storage), { revision: 2, dirty: false });
});

test('R1-F6: with no write during reconcile no save is scheduled', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(1, { 'vocab.a': { v: 1 } }),
  });
  await env.start();
  assert.equal(env.timers.pending.size, 0);
  assert.equal(readMeta(env.storage).dirty, false);
});

test('R1-F6: when reconcile fails the hooks are removed again and a write made meanwhile is not tracked', async () => {
  const env = createEnv({ local: { 'vocab.a': { v: 1 } } });
  const { started, fail } = startWithHeldKeys(env);
  await nextTick();
  env.storage.setItem('vocab.a', '{"v":2}');
  fail(new SyncHttpError('Keys unavailable.', 500));
  await started;
  assert.equal(syncState.error, 'Keys unavailable.');
  assert.equal(env.Storage.prototype.setItem, env.original);
  assert.equal(env.win.listeners.visibilitychange.length + env.win.listeners.pagehide.length, 0);
  assert.equal(env.timers.pending.size, 0);
  env.storage.setItem('vocab.a', '{"v":3}');
  await syncNow();
  assert.equal(env.server.puts.length, 0, 'a stopped engine saves nothing');
});

test('R1-F6: when startup ends in a reload the hooks are removed too', async () => {
  const env = createEnv({
    local: { 'vocab.a': { v: 1 } },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(2, { 'vocab.a': { v: 2 } }),
  });
  await env.start();
  assert.equal(env.win.reloads, 1);
  assert.equal(env.Storage.prototype.setItem, env.original);
});

// ---------------------------------------------------------------- fix round 1: keys and keepalive

test('R1-F7: a key typed in a later app\'s settings reaches .env even when the dashboard still holds the .env key', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('K1'), 'vocab.fr-settings': aiSettings('K1') },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(1, { 'vocab.settings': aiSettings(''), 'vocab.fr-settings': aiSettings('') }),
    envKey: 'K1',
    filled: true,
  });
  await env.start();
  env.storage.setItem('vocab.fr-settings', JSON.stringify(aiSettings('K2')));
  await syncNow();
  assert.deepEqual(env.server.keySaves, ['K2']);
  assert.equal(env.server.envKey, 'K2');
  // The other trusted setting follows, so the next save does not send K1 back to .env.
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings('K2'));
  env.storage.setItem('vocab.a', '1');
  await syncNow();
  assert.deepEqual(env.server.keySaves, ['K2']);
});

test('R1-F1: an edit made on top of another page\'s save does not overwrite the shared revision and hash', async () => {
  const env = await startedEnv();
  otherPageSaves(env, 6, { 'vocab.a': { v: 0 } });
  env.storage.setItem('vocab.a', '{"v":5}');
  assert.deepEqual(readMeta(env.storage), { revision: 6, dirty: true, hash: hashOfEntries({ 'vocab.a': { v: 0 } }) });
});

test('R1-F1: clear() wipes the bookkeeping record and it is written again from this page', async () => {
  const env = await startedEnv();
  env.storage.clear();
  assert.deepEqual(readState(env.storage), { revision: 1, dirty: true });
});

test('R1-F8: a keepalive save that landed does not turn the next edit into a conflict copy', async () => {
  const env = await startedEnv();
  env.storage.setItem('vocab.a', '{"v":1}');
  env.win.dispatch('pagehide');
  assert.equal(env.server.keepalives.length, 1);
  // The keepalive request landed (the page survived in the back/forward cache and never saw the answer).
  env.server.file = fileOf(env.server.file.revision + 1, env.server.keepalives[0].entries);
  env.storage.setItem('vocab.a', '{"v":2}');
  env.timers.fireAll();
  await syncNow();
  assert.equal(env.server.conflicts.length, 0);
  assert.equal(env.win.reloads, 0);
  assert.deepEqual(env.server.file.entries['vocab.a'], { v: 2 });
  assert.equal(env.server.file.revision, 3);
  assert.deepEqual(readState(env.storage), { revision: 3, dirty: false });
});

test('R1-F8: without a keepalive, a file that differs still ends in a conflict copy', async () => {
  const env = await startedEnv();
  env.server.file = fileOf(2, { 'vocab.a': { v: 1 } });
  env.storage.setItem('vocab.a', '{"v":2}');
  env.timers.fireAll();
  await syncNow();
  assert.equal(env.server.conflicts.length, 1);
  assert.equal(env.win.reloads, 1);
});

test('a startup conflict restore sets the session flag, the next start exposes conflictSaved, dismiss clears both', async () => {
  const first = createEnv({ local: { 'vocab.a': { mine: true } }, file: fileOf(2, { 'vocab.a': { theirs: true } }) });
  await first.start();
  assert.equal(first.session.getItem(CONFLICT_FLAG), '1');

  // The reload starts a new page in the same tab: same session storage, fresh engine.
  const next = createEnv({ file: fileOf(2, { 'vocab.a': { theirs: true } }), meta: { revision: 2, dirty: false, hash: 'auto' } });
  next.session.setItem(CONFLICT_FLAG, first.session.getItem(CONFLICT_FLAG));
  await next.start();
  assert.equal(syncState.conflictSaved, true);
  // A start never clears the flag by itself, so a page that starts first cannot swallow the notice.
  assert.equal(next.session.getItem(CONFLICT_FLAG), '1');

  let heard = 0;
  onSyncChange(() => { heard += 1; });
  dismissConflictNotice();
  assert.equal(syncState.conflictSaved, false);
  assert.equal(next.session.getItem(CONFLICT_FLAG), null);
  assert.equal(heard, 1);
});

test('a rejected save that is restored with a conflict copy sets the session flag', async () => {
  const env = await startedEnv();
  assert.equal(env.session.getItem(CONFLICT_FLAG), null);
  env.server.file = fileOf(5, { 'vocab.a': { v: 'other machine' } });
  env.storage.setItem('vocab.b', '"mine"');
  env.timers.fireAll();
  await syncNow();
  assert.equal(env.session.getItem(CONFLICT_FLAG), '1');
});

test('a restore without a conflict copy does not set the flag, and conflictSaved stays false', async () => {
  const env = createEnv({ file: fileOf(2, { 'vocab.a': 1 }) });
  await env.start();
  assert.equal(env.win.reloads, 1);
  assert.equal(env.session.getItem(CONFLICT_FLAG), null);
  assert.equal(syncState.conflictSaved, false);
});

test('a different .env key later in the same tab still reloads once so the page drops the old key', async () => {
  const env = createEnv({
    local: { 'vocab.settings': aiSettings('sk-old') },
    meta: { revision: 1, dirty: false, hash: 'auto' },
    file: fileOf(1, { 'vocab.settings': aiSettings('') }),
    envKey: 'sk-new',
  });
  // This tab already reloaded once for an earlier .env key.
  env.session.setItem(FILLED_FLAG, contentHash('sk-old'));
  await env.start();
  assert.deepEqual(stored(env.storage, 'vocab.settings'), aiSettings('sk-new'));
  assert.equal(env.win.reloads, 1);
  assert.equal(env.session.getItem(FILLED_FLAG), contentHash('sk-new'));
  assert.deepEqual(env.server.keySaves, []);
});
