/**
 * Tiny test harness shared by gjs and node: registers tests, provides assertions and runs them.
 *
 * Responsibility: test files call `test(name, fn)` and `assert.*` at import time; run.mjs calls `run()`
 * once every file is loaded. Only plain ECMAScript is used at import time, so the same file works under
 * gjs (`gjs -m`, used locally) and node (used in CI). Output goes through `globalThis.print` on gjs and
 * `console.log` on node.
 *
 * Invariant: tests run one at a time in registration order, so fakes shared between tests stay predictable.
 */

/** Registered tests in the order their files were imported. */
const registry = [];

/**
 * Registers a test. The test passes when its function returns or its promise resolves, and fails when it throws.
 *
 * @param {string} name Describes the behaviour the test protects, for example "deepEqual ignores key order".
 * @param {() => unknown} fn Test body; may be async.
 * @returns {void}
 * @example
 * test('sum adds two numbers', () => assert.equal(1 + 1, 2));
 */
export function test(name, fn) {
  registry.push({ name, fn });
}

/** Error raised by every failed assertion; the runner prints its message and counts the test as failed. */
class AssertionError extends Error {
  /**
   * Creates a failed-assertion error.
   *
   * @param {string} message Explains which value was expected and which was found.
   */
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * Throws an AssertionError with the given message.
 *
 * @param {string} message Explains the failed expectation.
 * @returns {never}
 */
function fail(message) {
  throw new AssertionError(message);
}

/**
 * Renders a value for a failure message: JSON when possible, otherwise String().
 *
 * @param {unknown} value Any value, including undefined, functions and circular structures.
 * @returns {string} Readable text; never throws.
 */
function formatValue(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular structures and BigInt cannot be serialised; String() still gives a usable hint.
    return String(value);
  }
}

/**
 * Tells whether a value is an object or array (and not null).
 *
 * @param {unknown} value Any value.
 * @returns {boolean} true for non-null objects, including arrays.
 */
function isObject(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * Compares two JSON-like values structurally: primitives by Object.is, arrays and objects key by key.
 *
 * @param {unknown} left First value.
 * @param {unknown} right Second value.
 * @returns {boolean} true when both have the same shape and equal leaves; key order does not matter.
 */
function isDeepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!isObject(left) || !isObject(right)) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  // Sorting both key lists lets objects with the same keys in another order compare equal.
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) => key === rightKeys[index] && isDeepEqual(left[key], right[key]),
  );
}

/**
 * Checks that a thrown error matches the optional expectation given to throws or rejects.
 *
 * @param {unknown} error The value that was thrown or the reason of the rejection.
 * @param {Function | RegExp | undefined} expected A class the error must be an instance of, a RegExp the
 *   error message must match, or undefined to accept any error.
 * @param {string | undefined} message Optional failure message that replaces the default.
 * @returns {void}
 * @throws {AssertionError} When the error does not match the expectation.
 */
function checkError(error, expected, message) {
  const text = error?.message ?? String(error);
  if (typeof expected === 'function' && !(error instanceof expected)) {
    fail(message ?? `expected an error of type ${expected.name}, got ${formatValue(text)}`);
  }
  if (expected instanceof RegExp && !expected.test(text)) {
    fail(message ?? `expected the error message to match ${expected}, got ${formatValue(text)}`);
  }
}

/**
 * Assertions used by the test files. Each one throws an AssertionError when its expectation is not met.
 *
 * @example
 * assert.deepEqual({ a: [1, 2] }, { a: [1, 2] });
 * assert.throws(() => JSON.parse('{'), SyntaxError);
 */
export const assert = {
  /**
   * Passes when value is truthy.
   *
   * @param {unknown} value Value to test.
   * @param {string} [message] Failure message; a default describes the value.
   * @returns {void}
   */
  ok(value, message) {
    if (!value) fail(message ?? `expected a truthy value, got ${formatValue(value)}`);
  },

  /**
   * Passes when actual and expected are strictly equal (===).
   *
   * @param {unknown} actual Value the code produced.
   * @param {unknown} expected Value the test expects.
   * @param {string} [message] Failure message; a default shows both values.
   * @returns {void}
   */
  equal(actual, expected, message) {
    if (actual !== expected) {
      fail(message ?? `expected ${formatValue(expected)}, got ${formatValue(actual)}`);
    }
  },

  /**
   * Passes when actual and expected are not strictly equal (!==).
   *
   * @param {unknown} actual Value the code produced.
   * @param {unknown} expected Value that must not be produced.
   * @param {string} [message] Failure message.
   * @returns {void}
   */
  notEqual(actual, expected, message) {
    if (actual === expected) {
      fail(message ?? `expected a value other than ${formatValue(expected)}`);
    }
  },

  /**
   * Passes when actual and expected have the same structure and leaf values (key order is ignored).
   *
   * @param {unknown} actual Value the code produced.
   * @param {unknown} expected Value the test expects.
   * @param {string} [message] Failure message; a default shows both values.
   * @returns {void}
   */
  deepEqual(actual, expected, message) {
    if (!isDeepEqual(actual, expected)) {
      fail(message ?? `expected ${formatValue(expected)}, got ${formatValue(actual)}`);
    }
  },

  /**
   * Passes when fn throws synchronously. An optional expectation narrows it to a class or a message pattern.
   *
   * @param {() => unknown} fn Function expected to throw.
   * @param {Function | RegExp} [expected] Error class (instanceof) or RegExp (matched against the message).
   * @param {string} [message] Failure message when nothing was thrown or the error does not match.
   * @returns {void}
   * @throws {AssertionError} When fn does not throw or the error does not match the expectation.
   */
  throws(fn, expected, message) {
    let threw = false;
    let error;
    try {
      fn();
    } catch (caught) {
      threw = true;
      error = caught;
    }
    if (!threw) fail(message ?? 'expected the function to throw, but it returned normally');
    checkError(error, expected, message);
  },

  /**
   * Passes when the promise (or the promise returned by fn) rejects. An optional expectation works as in throws.
   *
   * @param {Promise<unknown> | (() => Promise<unknown>)} target A promise, or a function returning one.
   * @param {Function | RegExp} [expected] Error class or message pattern.
   * @param {string} [message] Failure message when the promise resolves or the error does not match.
   * @returns {Promise<void>}
   * @throws {AssertionError} When the promise resolves or the rejection does not match the expectation.
   */
  async rejects(target, expected, message) {
    let rejected = false;
    let error;
    try {
      await (typeof target === 'function' ? target() : target);
    } catch (caught) {
      rejected = true;
      error = caught;
    }
    if (!rejected) fail(message ?? 'expected the promise to reject, but it resolved');
    checkError(error, expected, message);
  },

  /**
   * Passes when the text matches the pattern.
   *
   * @param {string} text Text the code produced.
   * @param {RegExp} pattern Pattern the text must match.
   * @param {string} [message] Failure message; a default shows the text and the pattern.
   * @returns {void}
   */
  match(text, pattern, message) {
    if (!pattern.test(text)) {
      fail(message ?? `expected ${formatValue(text)} to match ${pattern}`);
    }
  },
};

/**
 * Writes one line of output. gjs provides a global `print`; node uses `console.log`.
 *
 * @param {string} line Text to print without a trailing newline.
 * @returns {void}
 */
function writeLine(line) {
  const printLine = globalThis.print ?? console.log;
  printLine(line);
}

/**
 * Runs one registered test and prints PASS or FAIL with the reason.
 *
 * @param {{ name: string, fn: () => unknown }} entry The registered test.
 * @returns {Promise<boolean>} true when the test passed.
 */
async function runOne({ name, fn }) {
  try {
    await fn();
    writeLine(`PASS ${name}`);
    return true;
  } catch (error) {
    writeLine(`FAIL ${name}`);
    writeLine(`  ${error?.name ?? 'Error'}: ${error?.message ?? formatValue(error)}`);
    return false;
  }
}

/**
 * Runs every registered test in order and prints a summary line.
 *
 * @returns {Promise<{ passed: number, failed: number }>} How many tests passed and failed.
 * @example
 * const { failed } = await run();
 */
export async function run() {
  let passed = 0;
  let failed = 0;
  for (const entry of registry) {
    if (await runOne(entry)) {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  writeLine(`${passed} passed, ${failed} failed`);
  return { passed, failed };
}
