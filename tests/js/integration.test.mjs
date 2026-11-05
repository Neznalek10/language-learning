/**
 * Integration tests written from the acceptance criteria (plan.md section 2), not from the implementation:
 * two "machines" syncing through one fake server (AC4, AC5, AC6, AC11), new accounts and starter kits
 * (AC1, AC2) and the subject setup flow reaching every prompt (AC3).
 *
 * Where it fits: registered with the shared harness (tests/js/harness.mjs), run by tests/js/run.mjs under gjs
 * or node. The sync tests use the real snapshot.js, client.js (its error classes) and engine.js; only the
 * browser (Storage, window, timers) and the HTTP server are faked. The fake server enforces the same rules as
 * server/datastore.py: a 409 on a stale base revision and a rejection of entries that still hold an AI key.
 * The Python side of the same criteria lives in tests/test_integration.py.
 *
 * Invariant: each machine owns its own Storage class (the engine patches the class prototype), and
 * resetForTests() runs before every boot because the engine is a singleton per page.
 */
import { test, assert } from './harness.mjs';
import { resetForTests, startSync } from '../../js/sync/engine.js';
import { ConflictError, SyncHttpError } from '../../js/sync/client.js';
import { META_KEY, readMeta, redactSecrets } from '../../js/sync/snapshot.js';

/** Key under which the dashboard stores its AI settings in these tests. */
const SETTINGS_KEY = 'vocab.a1.settings';

/** An AI config as the apps store it, pointing at OpenRouter (the only host a key is filled into). */
const trusted = key => ({ ai: { url: 'https://openrouter.ai/api/v1', model: 'm', key } });

/** An AI config pointing at some other provider: a key must never be filled into it. */
const foreign = key => ({ ai: { url: 'https://example.org/v1', model: 'm', key } });

/** A secret typed by the user in these tests. */
const TYPED_KEY = 'sk-typed-by-user-123';

/**
 * Makes a deep copy of JSON data, so the fake server never shares objects with a machine.
 *
 * @param {*} value Any JSON value.
 * @returns {*} An independent copy.
 */
const clone = value => JSON.parse(JSON.stringify(value));

/**
 * Waits for promise callbacks to run (a few macrotasks, because a push chains several awaits).
 *
 * @returns {Promise<void>} Resolves when the queue is quiet.
 */
async function settle() {
  for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Creates a Storage-like class. The engine patches the prototype, so every machine needs its own class.
 *
 * @returns {Function} A class with getItem, setItem, removeItem, key, clear and length.
 */
function createStorageClass() {
  return class FakeStorage {
    /** Starts empty; values are kept as strings, like the real Storage. */
    constructor() {
      this.map = new Map();
    }

    /** Returns the stored string for `key`, or null when absent. */
    getItem(key) {
      return this.map.has(key) ? this.map.get(key) : null;
    }

    /** Stores `value` converted to a string, as the browser does. */
    setItem(key, value) {
      this.map.set(key, String(value));
    }

    /** Deletes `key` if present. */
    removeItem(key) {
      this.map.delete(key);
    }

    /** Returns the key at position `index`, or null past the end. */
    key(index) {
      return [...this.map.keys()][index] ?? null;
    }

    /** Removes every entry. */
    clear() {
      this.map.clear();
    }

    /** Number of stored entries. */
    get length() {
      return this.map.size;
    }
  };
}

/**
 * Creates manual timers: the debounce only fires when the test says time has passed.
 *
 * @returns {object} `setTimeout`, `clearTimeout` and `fireAll`.
 */
function createTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    /** Registers `callback` without a real delay; it runs only when `fireAll` is called. */
    setTimeout(callback) {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    /** Cancels a registered callback by id. */
    clearTimeout: id => pending.delete(id),
    /** Runs every pending callback once, as if the debounce time had passed. */
    fireAll() {
      const due = [...pending.values()];
      pending.clear();
      due.forEach(callback => callback());
    },
  };
}

/**
 * Creates a fake window that counts reloads and records listeners.
 *
 * @returns {object} The window.
 */
function createWindow() {
  const win = {
    reloads: 0,
    document: { visibilityState: 'visible' },
    /** Counts a page reload instead of performing it. */
    location: { reload: () => (win.reloads += 1) },
    /** Ignores listeners: the tests trigger flushes through the timers instead. */
    addEventListener() {},
    /** Ignores listener removal, matching `addEventListener`. */
    removeEventListener() {},
  };
  return win;
}

/**
 * Creates the fake server: a data file, a .env key and a client with the real API semantics.
 *
 * @returns {object} The state (`file`, `envKey`, `conflicts`) and its `client`.
 */
function createFakeServer() {
  const server = { file: null, envKey: '', conflicts: [] };
  server.client = {
    /** Mirrors GET /api/status from the current file and key. */
    async status() {
      return {
        app: 'language-learning',
        version: 'test',
        mode: 'file',
        dataFile: 'data/language-data.json',
        exists: server.file !== null,
        revision: server.file?.revision ?? 0,
        savedAt: server.file?.savedAt ?? null,
        hasAiKey: server.envKey !== '',
      };
    },
    /** Mirrors GET /api/keys: the key held in the fake .env. */
    getKeys: async () => ({ AI_API_KEY: server.envKey }),
    /** Mirrors GET /api/data: a copy of the file, or null when there is none. */
    getData: async () => (server.file ? clone(server.file) : null),
    /** Mirrors PUT /api/data: 409 on a stale base revision, 400 when an AI key is still inside. */
    async putData({ baseRevision, entries }) {
      const current = server.file?.revision ?? 0;
      if (baseRevision !== current) throw new ConflictError('Stale revision.', current);
      if (redactSecrets(entries).found.length > 0) throw new SyncHttpError('Entries contain an AI key.', 400);
      const revision = current + 1;
      server.file = { app: 'language-learning', format: 1, revision, savedAt: `saved-${revision}`, entries: clone(entries) };
      return { revision, savedAt: server.file.savedAt };
    },
    /** Mirrors POST /api/conflicts: records the losing entries and returns a file name. */
    async postConflict({ entries, reason }) {
      server.conflicts.push({ entries: clone(entries), reason });
      return { file: `data/conflicts/conflict-${server.conflicts.length}.json` };
    },
    /** Mirrors PUT /api/keys: stores the key in the fake .env (empty removes it). */
    async saveKeys(values) {
      server.envKey = values.AI_API_KEY;
      return { hasAiKey: server.envKey !== '' };
    },
    /** Page-hide save: not needed by these tests, so it does nothing. */
    putDataKeepalive() {},
  };
  return server;
}

/**
 * Creates a machine: a browser profile whose localStorage survives page loads.
 *
 * @param {object} server The shared fake server.
 * @returns {object} The machine with `storage`, `put`, `read` and `boot` (one page load).
 */
function createMachine(server) {
  const Storage = createStorageClass();
  const machine = {
    storage: new Storage(),
    session: new Storage(),
    win: null,
    timers: null,
    /** Writes a JSON value the way the apps do (through the possibly patched setItem). */
    put: (key, value) => machine.storage.setItem(key, JSON.stringify(value)),
    /** Reads a stored JSON value, or null. */
    read: key => (machine.storage.getItem(key) === null ? null : JSON.parse(machine.storage.getItem(key))),
    /** Simulates opening the page: a new window and timers, the same storage; the session survives reloads. */
    async boot({ newSession = false } = {}) {
      resetForTests();
      if (newSession) machine.session = new Storage();
      machine.win = createWindow();
      machine.timers = createTimers();
      await startSync({
        storage: machine.storage,
        client: server.client,
        win: machine.win,
        session: machine.session,
        timers: machine.timers,
      });
    },
    /** Lets the debounce elapse and waits for the save to finish. */
    async flush() {
      machine.timers.fireAll();
      await settle();
    },
  };
  return machine;
}

/**
 * Builds the data machine A starts with: a dashboard account with a typed key, and a French app value.
 *
 * @param {object} machine The machine whose storage is filled (before sync is started, so nothing is hooked).
 * @returns {void}
 */
function seedExistingData(machine) {
  machine.put('vocab.accounts', [{ id: 'a1', name: 'User' }]);
  machine.put('vocab.a1.imports', [{ id: 'fr/my-words', title: 'My words' }, { id: 'fr/czech', title: 'Příliš žluťoučký kůň' }]);
  machine.put(SETTINGS_KEY, { ...trusted(TYPED_KEY), other: foreign('') });
  machine.put('vocab.a1.progress', { streak: 3 });
  machine.storage.setItem('vocab.a1.raw', 'not json');
  machine.storage.setItem('unrelated.key', 'stays local');
}

// ---------------------------------------------------------------- AC4, AC5, AC11: migration and restore

test('AC11: the first start saves the data the browser already holds, minus the AI key', async () => {
  const server = createFakeServer();
  const machineA = createMachine(server);
  seedExistingData(machineA);
  await machineA.boot();
  assert.equal(server.file.revision, 1);
  assert.deepEqual(Object.keys(server.file.entries).sort(), [
    'vocab.a1.imports', 'vocab.a1.progress', 'vocab.a1.raw', 'vocab.a1.settings', 'vocab.accounts',
  ]);
  assert.deepEqual(server.file.entries['vocab.a1.raw'], { $raw: 'not json' });
  assert.equal(server.file.entries['vocab.a1.imports'][1].title, 'Příliš žluťoučký kůň');
  assert.equal(machineA.win.reloads, 0);
  const metaA = readMeta(machineA.storage);
  // The meta also carries a content hash of the last sync; only revision and dirty matter here.
  assert.deepEqual({ revision: metaA.revision, dirty: metaA.dirty }, { revision: 1, dirty: false });
  assert.match(metaA.hash, /^[0-9a-f]{8}$/);
});

test('AC5: a key already typed on the first machine goes to .env and never into the data file', async () => {
  const server = createFakeServer();
  const machineA = createMachine(server);
  seedExistingData(machineA);
  await machineA.boot();
  assert.equal(server.envKey, TYPED_KEY);
  assert.ok(!JSON.stringify(server.file).includes(TYPED_KEY));
  assert.equal(machineA.read(SETTINGS_KEY).ai.key, TYPED_KEY, 'the key stays usable in the browser');
});

test('AC4: an empty second machine restores the first one\'s data with exactly one reload', async () => {
  const server = createFakeServer();
  const machineA = createMachine(server);
  seedExistingData(machineA);
  await machineA.boot();
  const machineB = createMachine(server);
  await machineB.boot();
  assert.equal(machineB.win.reloads, 1);
  assert.deepEqual(machineB.read('vocab.a1.progress'), { streak: 3 });
  assert.equal(machineB.storage.getItem('vocab.a1.raw'), 'not json');
  assert.equal(machineB.storage.getItem('unrelated.key'), null);
  const metaB = readMeta(machineB.storage);
  // The meta also carries a content hash of the last sync; only revision and dirty matter here.
  assert.deepEqual({ revision: metaB.revision, dirty: metaB.dirty }, { revision: 1, dirty: false });
  assert.match(metaB.hash, /^[0-9a-f]{8}$/);
  // The page loads again after the reload: no second reload and nothing is saved back.
  await machineB.boot();
  assert.equal(machineB.win.reloads, 0);
  assert.equal(server.file.revision, 1);
});

test('AC5: the second machine gets the key from .env, only in the OpenRouter config', async () => {
  const server = createFakeServer();
  const machineA = createMachine(server);
  seedExistingData(machineA);
  await machineA.boot();
  const machineB = createMachine(server);
  await machineB.boot();
  const settings = machineB.read(SETTINGS_KEY);
  assert.equal(settings.ai.key, TYPED_KEY);
  assert.equal(settings.other.ai.key, '');
});

test('AC4: a change on machine B reaches machine A when A restarts', async () => {
  const server = createFakeServer();
  const machineA = createMachine(server);
  seedExistingData(machineA);
  await machineA.boot();
  const machineB = createMachine(server);
  await machineB.boot();
  await machineB.boot();
  machineB.put('vocab.a1.progress', { streak: 9 });
  await machineB.flush();
  assert.equal(server.file.revision, 2);
  await machineA.boot();
  assert.deepEqual(machineA.read('vocab.a1.progress'), { streak: 9 });
  assert.equal(machineA.win.reloads, 1);
  assert.equal(machineA.read(SETTINGS_KEY).ai.key, TYPED_KEY, 'the key survives the restore');
});

test('AC5: a key typed on machine A reaches .env, not the data file, and machine B gets it filled in', async () => {
  const server = createFakeServer();
  const machineA = createMachine(server);
  machineA.put(SETTINGS_KEY, { ...trusted(''), other: foreign('') });
  await machineA.boot();
  assert.equal(server.envKey, '');
  machineA.put(SETTINGS_KEY, { ...trusted(TYPED_KEY), other: foreign('') });
  await machineA.flush();
  assert.equal(server.envKey, TYPED_KEY);
  assert.ok(!JSON.stringify(server.file).includes(TYPED_KEY));
  const machineB = createMachine(server);
  await machineB.boot();
  assert.equal(machineB.read(SETTINGS_KEY).ai.key, TYPED_KEY);
  assert.equal(machineB.read(SETTINGS_KEY).other.ai.key, '');
});

// ---------------------------------------------------------------- AC6: stale machines

test('AC6: a stale machine saves its changes as a conflict copy and adopts the newer data', async () => {
  const server = createFakeServer();
  const machineA = createMachine(server);
  seedExistingData(machineA);
  await machineA.boot();
  // Machine A stays open (its engine is live) and changes a value; the save waits for the debounce.
  machineA.put('vocab.a1.progress', { streak: 4 });
  // Meanwhile another machine saves revision 2. The engine is a singleton per page, so that machine's
  // save is applied to the fake server directly instead of booting a second engine.
  const newer = clone(server.file);
  newer.revision = 2;
  newer.entries['vocab.a1.progress'] = { streak: 10 };
  server.file = newer;
  await machineA.flush();
  assert.equal(server.conflicts.length, 1);
  assert.deepEqual(server.conflicts[0].entries['vocab.a1.progress'], { streak: 4 });
  assert.ok(server.conflicts[0].reason.length > 0);
  assert.deepEqual(server.file.entries['vocab.a1.progress'], { streak: 10 }, 'the newer data is not overwritten');
  assert.deepEqual(machineA.read('vocab.a1.progress'), { streak: 10 });
  assert.equal(readMeta(machineA.storage).revision, 2);
  assert.equal(machineA.win.reloads, 1);
});

test('AC6: unsaved changes found at start-up against a newer file are kept as a conflict copy', async () => {
  const server = createFakeServer();
  const machineA = createMachine(server);
  seedExistingData(machineA);
  await machineA.boot();
  const machineB = createMachine(server);
  await machineB.boot();
  await machineB.boot();
  machineB.put('vocab.a1.progress', { streak: 10 });
  await machineB.flush();
  // Machine A was closed with an unsaved change (dirty meta).
  machineA.storage.setItem(META_KEY, JSON.stringify({ revision: 1, dirty: true }));
  machineA.put('vocab.a1.progress', { streak: 5 });
  await machineA.boot();
  assert.equal(server.conflicts.length, 1);
  assert.deepEqual(server.conflicts[0].entries['vocab.a1.progress'], { streak: 5 });
  assert.deepEqual(machineA.read('vocab.a1.progress'), { streak: 10 });
});
