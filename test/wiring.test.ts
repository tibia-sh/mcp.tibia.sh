/**
 * The Worker uses the policy helpers, in the order of spec 5.2's checks.
 *
 * test/policy.test.ts proves each helper. wrangler dev cannot stage a failing container, so no end-to-end test
 * can prove that the Worker retries through forwardWithRetry. This test reads src/worker.ts as text instead,
 * and checks where each helper is first called.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** The helpers, in the order the Worker applies them. */
const HELPERS = [
  'route',
  'checkHeaders',
  'readCapped',
  'checkContentType',
  'checkJsonRpcShape',
  'rateLimitKey',
  'chargeRateLimit',
  'forwardWithRetry',
];

test('src/worker.ts calls every policy helper, first in the order of the checks', () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const firstCalls = HELPERS.map((name) => ({ name, at: source.search(new RegExp(`\\b${name}\\(`)) }));
  assert.deepEqual(
    firstCalls.filter(({ at }) => at === -1).map(({ name }) => name),
    [],
    'src/worker.ts never calls these helpers',
  );
  assert.deepEqual(
    firstCalls.toSorted((a, b) => a.at - b.at).map(({ name }) => name),
    HELPERS,
    'the first calls are out of order',
  );
});
