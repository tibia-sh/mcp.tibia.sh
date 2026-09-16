/**
 * The server card's content: the registry listing's literals with the version package.json pins, and the two
 * rules of the extension's schema that a changed literal could break.
 *
 * The version comes from package.json, so a pin bump that the card does not follow fails here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import packageJson from '../package.json' with { type: 'json' };
import { SERVER_CARD } from '../src/server-card.ts';

/** The card as a client reads it, parsed afresh. */
function card(): Record<string, unknown> {
  return JSON.parse(SERVER_CARD);
}

test('it is the registry listing with the pinned server version, in the schema order', () => {
  assert.deepEqual(card(), {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: 'sh.tibia/tibiawiki-mcp',
    version: packageJson.dependencies['@tibia.sh/tibiawiki-mcp'],
    description: 'TibiaWiki knowledge base: attribute queries over creatures, items, NPCs, quests and spells',
    websiteUrl: 'https://mcp.tibia.sh',
    repository: { url: 'https://github.com/tibia-sh/tibiawiki-mcp', source: 'github' },
    remotes: [{ type: 'streamable-http', url: 'https://mcp.tibia.sh/wiki' }],
  });
  assert.deepEqual(Object.keys(card()), [
    '$schema',
    'name',
    'version',
    'description',
    'websiteUrl',
    'repository',
    'remotes',
  ]);
});

test("it keeps the schema's rules: a reverse-DNS name with one slash, and a description of 1 to 100 characters", () => {
  const { name, description } = card();
  assert.match(String(name), /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.equal(typeof description, 'string');
  const length = String(description).length;
  assert.ok(length >= 1 && length <= 100, `the description has ${length} characters`);
});
