/**
 * Unit tests for js/sync/client.js: request shape, typed errors, 404 handling, timeouts and keepalive.
 *
 * Where it fits: registered with the shared harness (tests/js/harness.mjs) and run by tests/js/run.mjs
 * under gjs or node. No network: every test passes a fake fetch function that records its calls.
 */
import { test, assert } from './harness.mjs';
import { createClient, SyncHttpError, ConflictError } from '../../js/sync/client.js';

/**
 * Builds a fake fetch response.
 *
 * @param {number} status HTTP status.
 * @param {*} body Value sent as JSON, or a string sent as is.
 * @returns {{ok: boolean, status: number, text: () => Promise<string>}} The response.
 */
function reply(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/**
 * Creates a fake fetch that records calls and answers with the queued responses.
 *
 * @param {...(object | Error)} answers Responses (or errors to reject with), used in order; the last repeats.
 * @returns {{fetcher: Function, calls: Array<{url: string, init: object}>}} The fake and its call log.
 */
function fakeFetch(...answers) {
  const calls = [];
  /** Records the call and returns (or throws) the next queued answer. */
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetcher, calls };
}

/**
 * Waits for pending promise callbacks to run.
 *
 * @returns {Promise<void>} Resolves after a macrotask.
 */
function nextTick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

test('status performs GET /api/status and returns the parsed body', async () => {
  const { fetcher, calls } = fakeFetch(reply(200, { mode: 'file', exists: true, revision: 4 }));
  const status = await createClient({ fetcher }).status();
  assert.deepEqual(status, { mode: 'file', exists: true, revision: 4 });
  assert.equal(calls[0].url, '/api/status');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
});

test('baseUrl is prepended to every path', async () => {
  const { fetcher, calls } = fakeFetch(reply(200, {}));
  await createClient({ baseUrl: 'http://127.0.0.1:8768', fetcher }).getKeys();
  assert.equal(calls[0].url, 'http://127.0.0.1:8768/api/keys');
});

test('putData sends a JSON PUT with the content type the server requires', async () => {
  const { fetcher, calls } = fakeFetch(reply(200, { revision: 2, savedAt: '2026-11-03T10:00:00Z' }));
  const entries = { 'vocab.a': { ž: 'Příliš žluťoučký kůň' } };
  const saved = await createClient({ fetcher }).putData({ baseRevision: 1, entries });
  assert.deepEqual(saved, { revision: 2, savedAt: '2026-11-03T10:00:00Z' });
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { baseRevision: 1, entries });
});

test('postConflict, getKeys and saveKeys use their routes and methods', async () => {
  const { fetcher, calls } = fakeFetch(
    reply(201, { file: 'data/conflicts/c.json' }),
    reply(200, { AI_API_KEY: 'k' }),
    reply(200, { hasAiKey: true }),
  );
  const client = createClient({ fetcher });
  assert.deepEqual(await client.postConflict({ entries: {}, reason: 'r' }), { file: 'data/conflicts/c.json' });
  assert.deepEqual(await client.getKeys(), { AI_API_KEY: 'k' });
  assert.deepEqual(await client.saveKeys({ AI_API_KEY: 'k' }), { hasAiKey: true });
  assert.deepEqual(calls.map(call => `${call.init.method} ${call.url}`), [
    'POST /api/conflicts',
    'GET /api/keys',
    'PUT /api/keys',
  ]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { entries: {}, reason: 'r' });
  assert.deepEqual(JSON.parse(calls[2].init.body), { AI_API_KEY: 'k' });
});

test('getData returns the data file, and null for 404 (no file yet)', async () => {
  const file = { app: 'language-learning', format: 1, revision: 3, savedAt: 'x', entries: {} };
  assert.deepEqual(await createClient({ fetcher: fakeFetch(reply(200, file)).fetcher }).getData(), file);
  const missing = fakeFetch(reply(404, { error: 'No data file yet.' })).fetcher;
  assert.equal(await createClient({ fetcher: missing }).getData(), null);
});

test('getData still throws for server errors other than 404', async () => {
  const broken = fakeFetch(reply(500, { error: 'The data file is damaged.' })).fetcher;
  await assert.rejects(createClient({ fetcher: broken }).getData(), SyncHttpError);
});

test('a 409 on putData becomes a ConflictError carrying the current revision', async () => {
  const stale = fakeFetch(reply(409, { error: 'Stale revision.', revision: 7 })).fetcher;
  let caught;
  try {
    await createClient({ fetcher: stale }).putData({ baseRevision: 1, entries: {} });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ConflictError);
  assert.ok(caught instanceof SyncHttpError);
  assert.equal(caught.revision, 7);
  assert.equal(caught.status, 409);
  assert.equal(caught.message, 'Stale revision.');
});

test('a non-2xx answer becomes a SyncHttpError with the server message and status', async () => {
  const invalid = fakeFetch(reply(400, { error: 'Entries contain an AI key.' })).fetcher;
  let caught;
  try {
    await createClient({ fetcher: invalid }).putData({ baseRevision: 0, entries: {} });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SyncHttpError);
  assert.equal(caught.status, 400);
  assert.equal(caught.message, 'Entries contain an AI key.');
  assert.equal(caught.fromApi, true);
});

test('fromApi tells this app\'s JSON errors from other servers\' error pages', async () => {
  const errors = [];
  for (const answer of [reply(500, { error: 'The data file is damaged.' }), reply(500, '<h1>Oops</h1>')]) {
    try {
      await createClient({ fetcher: fakeFetch(answer).fetcher }).status();
    } catch (error) {
      errors.push(error);
    }
  }
  assert.deepEqual(errors.map(error => error.fromApi), [true, false]);
  assert.deepEqual(errors.map(error => error.status), [500, 500]);
});

test('an error page that is not JSON still gives a SyncHttpError with a generic message', async () => {
  const html = fakeFetch(reply(404, '<html>Not found</html>')).fetcher;
  let caught;
  try {
    await createClient({ fetcher: html }).status();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SyncHttpError);
  assert.equal(caught.status, 404);
  assert.match(caught.message, /HTTP 404/);
});

test('a 2xx answer that is not JSON resolves to null so the caller can reject it', async () => {
  const page = fakeFetch(reply(200, '<html>index</html>')).fetcher;
  assert.equal(await createClient({ fetcher: page }).status(), null);
});

test('a network failure becomes a SyncHttpError with status 0', async () => {
  const down = fakeFetch(new TypeError('Failed to fetch')).fetcher;
  let caught;
  try {
    await createClient({ fetcher: down }).status();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SyncHttpError);
  assert.equal(caught.status, 0);
  assert.match(caught.message, /Failed to fetch/);
});

test('a request that never answers is cut off after timeoutMs with status 0', async () => {
  /** A fetch that never settles, to trigger the timeout. */
  const hanging = () => new Promise(() => {});
  let caught;
  try {
    await createClient({ fetcher: hanging, timeoutMs: 20 }).status();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SyncHttpError);
  assert.equal(caught.status, 0);
  assert.match(caught.message, /20 ms/);
});

test('a body that never finishes is also covered by the timeout', async () => {
  /** A fetch whose headers arrive but whose body never finishes. */
  const slowBody = async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) });
  await assert.rejects(createClient({ fetcher: slowBody, timeoutMs: 20 }).getKeys(), SyncHttpError);
});

test('putDataKeepalive sends a keepalive PUT, returns nothing and ignores a failed request', async () => {
  const { fetcher, calls } = fakeFetch(new TypeError('offline'));
  const result = createClient({ fetcher }).putDataKeepalive({ baseRevision: 5, entries: { 'vocab.a': 1 } });
  assert.equal(result, undefined);
  assert.equal(calls[0].url, '/api/data');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.keepalive, true);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { baseRevision: 5, entries: { 'vocab.a': 1 } });
  // A rejected keepalive request must not surface as an unhandled rejection.
  await nextTick();
});

test('createClient refuses to start without a fetch function', () => {
  assert.throws(() => createClient({ fetcher: null }), TypeError);
});
