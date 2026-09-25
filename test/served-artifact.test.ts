/**
 * The served-artifact check compares the tool names an endpoint serves with the TOOL_NAMES of the pinned
 * @tibia.sh/tibiawiki-mcp, as sets, so a server release that adds or renames a tool deploys without a change
 * here.
 *
 * The Worker's body cap follows the server's cap, and is never below the pinned server's MAX_BODY_BYTES, so the
 * Worker cannot refuse a request the server accepts.
 */
import { MAX_BODY_BYTES as SERVER_MAX_BODY_BYTES } from '@tibia.sh/tibiawiki-mcp/dist/http.js';
import { TOOL_NAMES } from '@tibia.sh/tibiawiki-mcp/dist/server.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedArtifact, mismatches } from '../scripts/served-artifact.ts';
import type { EraReport } from '../scripts/served-artifact.ts';
import { MAX_BODY_BYTES } from '../src/policy.ts';

const expected = expectedArtifact();

/** A default-era report that passes every check, serving the given tool names. */
function served(toolNames: string[]): EraReport {
  return {
    era: 'default',
    protocolVersion: '2025-11-25',
    toolNames,
    artifact: { serverVersion: expected.serverVersion, indexGeneratedAt: expected.indexGeneratedAt },
    responsesSeen: 1,
    sessionIdsSeen: [],
  };
}

/** The one mismatch line of reports, which must name every one of names. */
function assertOneLineNaming(reports: EraReport[], names: string[]) {
  const lines = mismatches(reports, expected);
  assert.equal(lines.length, 1, `expected one line, got ${JSON.stringify(lines)}`);
  for (const name of names) assert.ok(lines[0]?.includes(name), `${JSON.stringify(lines[0])} does not name ${name}`);
}

test("expectedArtifact() expects the pinned server's TOOL_NAMES", () => {
  assert.deepEqual(expected.toolNames, TOOL_NAMES);
});

test('the pinned names pass in any order', () => {
  assert.deepEqual(mismatches([served([...TOOL_NAMES])], expected), []);
  assert.deepEqual(mismatches([served([...TOOL_NAMES].reverse())], expected), []);
});

test('a missing name gives one line naming it', () => {
  const [missing, ...rest] = TOOL_NAMES;
  assert.ok(missing !== undefined);
  assertOneLineNaming([served(rest)], [missing]);
});

test('an extra name gives one line naming it', () => {
  assertOneLineNaming([served([...TOOL_NAMES, 'tibia_extra'])], ['tibia_extra']);
});

test('a name swapped for another at the same count gives one line naming both', () => {
  const [swapped, ...rest] = TOOL_NAMES;
  assert.ok(swapped !== undefined);
  assertOneLineNaming([served([...rest, 'tibia_extra'])], [swapped, 'tibia_extra']);
});

test("the Worker's body cap is at least the pinned server's", () => {
  assert.ok(
    MAX_BODY_BYTES >= SERVER_MAX_BODY_BYTES,
    `the Worker's cap of ${MAX_BODY_BYTES} bytes is below the server's ${SERVER_MAX_BODY_BYTES}`,
  );
});
