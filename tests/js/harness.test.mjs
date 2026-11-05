/**
 * Self-test of the JavaScript test harness: checks that each assertion passes on a match and fails on a mismatch.
 *
 * Runs first in tests/js/run.mjs so a broken harness is visible before any feature test. Uses only the
 * harness API, so it runs unchanged under gjs and node.
 */
import { assert, test } from './harness.mjs';

/**
 * Runs an assertion that is expected to fail and returns the error it raised.
 *
 * @param {() => unknown} assertion Function that calls one assertion on bad input.
 * @returns {Error} The error the assertion threw.
 * @throws {Error} When the assertion passes, so the self-test itself fails.
 */
function failureOf(assertion) {
  try {
    assertion();
  } catch (error) {
    return error;
  }
  throw new Error('expected the assertion to fail, but it passed');
}

test('assert.ok passes for a truthy value', () => {
  assert.ok('text');
});

test('assert.ok fails for a falsy value and reports an AssertionError', () => {
  assert.equal(failureOf(() => assert.ok(0)).name, 'AssertionError');
});

test('assert.equal treats 1 and "1" as different values', () => {
  assert.equal(failureOf(() => assert.equal(1, '1')).name, 'AssertionError');
});

test('assert.notEqual fails when the two values are strictly equal', () => {
  assert.equal(failureOf(() => assert.notEqual(2, 2)).name, 'AssertionError');
});

test('assert.deepEqual ignores key order in nested objects', () => {
  assert.deepEqual({ a: [1, { b: 2, c: 3 }] }, { a: [1, { c: 3, b: 2 }] });
});

test('assert.deepEqual fails when a nested leaf differs', () => {
  assert.equal(failureOf(() => assert.deepEqual({ a: [1, 2] }, { a: [1, 3] })).name, 'AssertionError');
});

test('assert.deepEqual fails when an array is compared with an object of the same keys', () => {
  assert.equal(failureOf(() => assert.deepEqual([], {})).name, 'AssertionError');
});

test('assert.throws passes when the function throws the expected class', () => {
  assert.throws(() => JSON.parse('{'), SyntaxError);
});

test('assert.throws matches the error message against a RegExp', () => {
  assert.throws(() => {
    throw new Error('Příliš žluťoučký kůň');
  }, /žluťoučký/);
});

test('assert.throws fails when the function returns normally', () => {
  assert.equal(failureOf(() => assert.throws(() => 1)).name, 'AssertionError');
});

test('assert.throws fails when the error has the wrong class', () => {
  assert.equal(failureOf(() => assert.throws(() => JSON.parse('{'), RangeError)).name, 'AssertionError');
});

test('assert.rejects passes when the promise rejects', async () => {
  await assert.rejects(async () => {
    throw new Error('boom');
  }, /boom/);
});

test('assert.rejects fails when the promise resolves', async () => {
  let error;
  try {
    await assert.rejects(() => Promise.resolve('fine'));
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.name, 'AssertionError');
});

test('assert.match passes when the text matches the pattern', () => {
  assert.match('vocab.a1.progress', /^vocab\./);
});

test('assert.match fails when the text does not match the pattern', () => {
  assert.equal(failureOf(() => assert.match('vocab-en.words', /^vocab\./)).name, 'AssertionError');
});
