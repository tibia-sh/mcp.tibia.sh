/**
 * The served-artifact check compares the tool names an endpoint serves with the TOOL_NAMES of the pinned
 * @tibia.sh/tibiawiki-mcp, as sets, so a server release that adds or renames a tool deploys without a change
 * here.
 */
import { TOOL_NAMES } from '@tibia.sh/tibiawiki-mcp/dist/server.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedArtifact, mismatches } from '../scripts/served-artifact.ts';
import type { EraReport } from '../scripts/served-artifact.ts';

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
