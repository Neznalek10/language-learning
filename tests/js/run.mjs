/**
 * Entry point for the JavaScript test suite, run as `gjs -m tests/js/run.mjs` locally or `node tests/js/run.mjs` in CI.
 *
 * Responsibility: import every test file in TEST_FILES (each registers its tests with the shared harness),
 * run them all, and exit non-zero when anything failed. A file that does not exist yet is reported as SKIP
 * and is not a failure, because the task that owns it has not been built. A file that exists but fails to
 * load is a failure. Invariant: the exit status is set only after all output is printed, since gjs exits
 * at once when asked.
 */
import { run } from './harness.mjs';

/** Test files in run order. harness.test.mjs goes first so a broken harness shows before feature tests. */
const TEST_FILES = [
  'harness.test.mjs',
  'snapshot.test.mjs',
  'client.test.mjs',
  'engine.test.mjs',
  'integration.test.mjs',
];

/** Folder URL of this file (with a trailing slash), used to locate the test files on disk. */
const THIS_FOLDER_URL = import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1);

/**
 * Tells whether a test file exists in this folder, using the file API of the current runtime.
 * gjs has no URL global, so the check works on the file:// URL string directly.
 *
 * @param {string} name File name relative to this folder, for example "snapshot.test.mjs".
 * @returns {Promise<boolean>} true when the file is on disk.
 */
async function fileExists(name) {
  const url = THIS_FOLDER_URL + name;
  if (globalThis.process) {
    // node: convert the file:// URL to a path, then check it synchronously.
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    return existsSync(fileURLToPath(url));
  }
  // gjs: Gio understands file:// URIs directly.
  const { default: Gio } = await import('gi://Gio?version=2.0');
  return Gio.File.new_for_uri(url).query_exists(null);
}

/**
 * Writes one line of output. gjs provides a global `print`; node uses `console.log`.
 *
 * @param {string} line Text to print.
 * @returns {void}
 */
function writeLine(line) {
  const printLine = globalThis.print ?? console.log;
  printLine(line);
}

/**
 * Imports one test file so its tests register, or reports it as skipped when it is not written yet.
 *
 * @param {string} name File name relative to this folder.
 * @returns {Promise<boolean>} false when the file exists but failed to load (counted as a failure).
 */
async function loadTestFile(name) {
  if (!(await fileExists(name))) {
    writeLine(`SKIP ${name} (not written yet)`);
    return true;
  }
  try {
    await import(`./${name}`);
    return true;
  } catch (error) {
    // A load error (syntax error, failing top-level code) is a real failure, not a skip.
    writeLine(`FAIL ${name} did not load: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * Ends the process with the given status using the current runtime's API.
 * Called only after all output is printed, because gjs's system.exit stops the process immediately.
 *
 * @param {number} code Exit status: 0 when everything passed, 1 otherwise.
 * @returns {Promise<void>}
 */
async function exitWith(code) {
  if (globalThis.process) {
    // node: setting exitCode lets the process finish flushing output before it exits.
    process.exitCode = code;
    return;
  }
  const { default: system } = await import('system');
  system.exit(code);
}

/**
 * Loads every test file, runs every registered test and exits with the combined status.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let loadFailures = 0;
  for (const name of TEST_FILES) {
    if (!(await loadTestFile(name))) loadFailures += 1;
  }
  const { failed } = await run();
  await exitWith(failed + loadFailures > 0 ? 1 : 0);
}

await main();
