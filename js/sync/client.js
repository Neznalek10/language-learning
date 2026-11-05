/**
 * Small fetch wrapper for the local server's /api routes: GET /api/status, GET and PUT /api/data,
 * POST /api/conflicts, GET and PUT /api/keys.
 *
 * Responsibility: turn each API call into one function that sends JSON, enforces a timeout, and reports
 * every failure as a typed error (SyncHttpError, or ConflictError for a 409 revision conflict).
 * Where it fits: js/sync/engine.js is the only caller; page.js creates the client with the real fetch.
 * It touches no globals at import time: the fetch function is injected (defaulting to globalThis.fetch
 * when createClient runs), so tests pass a fake and nothing here depends on a browser at import.
 *
 * Invariants:
 * - Every request (except the fire-and-forget keepalive one) is cut off after `timeoutMs`, covering the
 *   response body as well as the headers.
 * - A network failure or timeout is a SyncHttpError with status 0, so callers handle one error family.
 */

/** Default time limit for one request, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5000;

/** HTTP status for "the revision you based your save on is no longer current". */
const STATUS_CONFLICT = 409;

/** HTTP status for "no such resource"; GET /api/data answers it while no data file exists. */
const STATUS_NOT_FOUND = 404;

/** Status code used for failures that never produced an HTTP response (network down, timeout). */
const STATUS_NO_RESPONSE = 0;

/** Headers for every request that carries a JSON body (the server rejects other content types). */
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Error for any failed API call. */
export class SyncHttpError extends Error {
  /**
   * Creates the error.
   *
   * @param {string} message What went wrong, taken from the server's {"error": ...} body when present.
   * @param {number} status HTTP status, or 0 when no response arrived.
   * @param {boolean} [fromApi] true when the message came from the server's own {"error": ...} body, which
   *   tells this app's server apart from any other server that happens to answer.
   */
  constructor(message, status, fromApi = false) {
    super(message);
    this.name = 'SyncHttpError';
    /** @type {number} */
    this.status = status;
    /** @type {boolean} */
    this.fromApi = fromApi;
  }
}

/** Error for PUT /api/data when the file has moved on since `baseRevision` (HTTP 409). */
export class ConflictError extends SyncHttpError {
  /**
   * Creates the error.
   *
   * @param {string} message The server's message.
   * @param {number} revision The revision the data file has now.
   */
  constructor(message, revision) {
    super(message, STATUS_CONFLICT);
    this.name = 'ConflictError';
    /** @type {number} */
    this.revision = revision;
  }
}

/**
 * Parses a response body that should be JSON.
 *
 * @param {string} text The raw body; may be empty.
 * @returns {*} The parsed value, or null when the body is empty or not JSON (a non-API server answering
 *   with an HTML page must not crash the caller).
 */
function parseJson(text) {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    // Only "not JSON" is expected here; anything else is a real bug and must surface.
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

/**
 * Builds the typed error for a non-2xx response.
 *
 * @param {number} status The HTTP status.
 * @param {*} body The parsed JSON body or null.
 * @returns {SyncHttpError} A ConflictError for 409, otherwise a SyncHttpError.
 */
function errorFor(status, body) {
  const fromApi = typeof body?.error === 'string';
  const message = fromApi ? body.error : `The server answered HTTP ${status}.`;
  if (status === STATUS_CONFLICT) return new ConflictError(message, body?.revision);
  return new SyncHttpError(message, status, fromApi);
}

/**
 * Sends one request and returns the parsed JSON body.
 *
 * @param {Function} fetcher The fetch function.
 * @param {string} url Request URL.
 * @param {RequestInit} init Method, headers and body.
 * @param {AbortSignal | undefined} signal Aborts the request on timeout when the runtime has AbortController.
 * @returns {Promise<*>} The parsed body of a 2xx response.
 * @throws {SyncHttpError} For a non-2xx status or a failed network call.
 */
async function exchange(fetcher, url, init, signal) {
  let response;
  let text;
  try {
    response = await fetcher(url, { ...init, signal });
    text = await response.text();
  } catch (error) {
    if (error instanceof SyncHttpError) throw error;
    throw new SyncHttpError(`The server could not be reached: ${error?.message ?? error}`, STATUS_NO_RESPONSE);
  }
  const body = parseJson(text);
  if (!response.ok) throw errorFor(response.status, body);
  return body;
}

/**
 * Does nothing with a failed keepalive request: the page is unloading, so nobody can react, and the
 * engine keeps its dirty flag set, so the next page load saves the data again.
 *
 * @returns {void}
 */
function ignoreKeepaliveFailure() {}

/**
 * Calls the API with a timeout and returns the parsed body.
 *
 * @param {{baseUrl: string, fetcher: Function, timeoutMs: number}} settings The client settings.
 * @param {string} path Path starting with /api.
 * @param {string} [method] HTTP method.
 * @param {object} [payload] Value sent as the JSON body; omitted for GET.
 * @returns {Promise<*>} The parsed JSON body.
 * @throws {SyncHttpError} On any failure, including a timeout (status 0).
 */
async function callApi({ baseUrl, fetcher, timeoutMs }, path, method = 'GET', payload = undefined) {
  // AbortController is missing in some runtimes (gjs); then the race below still stops the wait.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const init = { method };
  if (payload !== undefined) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify(payload);
  }
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      controller?.abort();
      reject(new SyncHttpError(`The server did not answer within ${timeoutMs} ms.`, STATUS_NO_RESPONSE));
    }, timeoutMs);
  });
  try {
    return await Promise.race([exchange(fetcher, `${baseUrl}${path}`, init, controller?.signal), timeout]);
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * GET /api/status.
 *
 * @param {object} settings The client settings.
 * @returns {Promise<object | null>} The status object (null if the server answered with something that is not JSON).
 * @throws {SyncHttpError} For any failure.
 */
function readStatus(settings) {
  return callApi(settings, '/api/status');
}

/**
 * GET /api/data.
 *
 * @param {object} settings The client settings.
 * @returns {Promise<object | null>} The data file object, or null when no data file exists yet (HTTP 404).
 * @throws {SyncHttpError} For any other failure.
 */
async function readData(settings) {
  try {
    return await callApi(settings, '/api/data');
  } catch (error) {
    // 404 only means "no data file yet", which is a normal first-run answer, not a failure.
    if (error instanceof SyncHttpError && error.status === STATUS_NOT_FOUND) return null;
    throw error;
  }
}

/**
 * PUT /api/data.
 *
 * @param {object} settings The client settings.
 * @param {{baseRevision: number, entries: object}} payload The revision the save builds on and the entries.
 * @returns {Promise<{revision: number, savedAt: string}>} The new revision.
 * @throws {ConflictError} When the file's revision is not `baseRevision` any more (HTTP 409).
 * @throws {SyncHttpError} For any other failure.
 */
function writeData(settings, { baseRevision, entries }) {
  return callApi(settings, '/api/data', 'PUT', { baseRevision, entries });
}

/**
 * POST /api/conflicts.
 *
 * @param {object} settings The client settings.
 * @param {{entries: object, reason: string}} payload The entries to keep and why.
 * @returns {Promise<{file: string}>} The path of the conflict file the server wrote.
 * @throws {SyncHttpError} For any failure.
 */
function writeConflict(settings, { entries, reason }) {
  return callApi(settings, '/api/conflicts', 'POST', { entries, reason });
}

/**
 * GET /api/keys.
 *
 * @param {object} settings The client settings.
 * @returns {Promise<{AI_API_KEY: string}>} The keys stored in .env ('' when unset).
 * @throws {SyncHttpError} For any failure.
 */
function readKeys(settings) {
  return callApi(settings, '/api/keys');
}

/**
 * PUT /api/keys.
 *
 * @param {object} settings The client settings.
 * @param {{AI_API_KEY: string}} values The keys to store; '' removes a key.
 * @returns {Promise<{hasAiKey: boolean}>} Whether .env now holds a key.
 * @throws {SyncHttpError} For any failure, including a value the server refuses (HTTP 400).
 */
function writeKeys(settings, values) {
  return callApi(settings, '/api/keys', 'PUT', values);
}

/**
 * Saves the data with a request that may outlive the page (for pagehide). Fire and forget: nothing is
 * returned and a failure is ignored; the engine keeps its dirty flag, so the next load saves again.
 *
 * @param {object} settings The client settings.
 * @param {{baseRevision: number, entries: object}} payload The same body as writeData.
 * @returns {void}
 */
function writeDataKeepalive({ baseUrl, fetcher }, { baseRevision, entries }) {
  // keepalive lets the request outlive the page; browsers cap such bodies at 64 KB (engine checks).
  fetcher(`${baseUrl}/api/data`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ baseRevision, entries }),
    keepalive: true,
  }).catch(ignoreKeepaliveFailure);
}

/**
 * Creates the API client.
 *
 * @param {object} [options] Client options.
 * @param {string} [options.baseUrl] Prefix for every path ('' means the page's own origin).
 * @param {Function} [options.fetcher] A fetch-compatible function; defaults to globalThis.fetch.
 * @param {number} [options.timeoutMs] Per-request time limit in milliseconds.
 * @returns {{
 *   status: () => Promise<object>,
 *   getData: () => Promise<object | null>,
 *   putData: (payload: {baseRevision: number, entries: object}) => Promise<{revision: number, savedAt: string}>,
 *   postConflict: (payload: {entries: object, reason: string}) => Promise<{file: string}>,
 *   getKeys: () => Promise<{AI_API_KEY: string}>,
 *   saveKeys: (values: {AI_API_KEY: string}) => Promise<{hasAiKey: boolean}>,
 *   putDataKeepalive: (payload: {baseRevision: number, entries: object}) => void,
 * }} The client; every method except putDataKeepalive returns a promise.
 * @throws {TypeError} When no fetch function is available.
 * @example
 * const client = createClient();
 * const { exists, revision } = await client.status();
 */
export function createClient({ baseUrl = '', fetcher = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetcher !== 'function') {
    throw new TypeError('createClient needs a fetch function; this runtime has none.');
  }
  const settings = { baseUrl, fetcher, timeoutMs };
  return {
    status: () => readStatus(settings),
    getData: () => readData(settings),
    putData: payload => writeData(settings, payload),
    postConflict: payload => writeConflict(settings, payload),
    getKeys: () => readKeys(settings),
    saveKeys: values => writeKeys(settings, values),
    putDataKeepalive: payload => writeDataKeepalive(settings, payload),
  };
}
