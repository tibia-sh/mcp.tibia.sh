/**
 * The MCP Server Card of the endpoint, served at /wiki/server-card: the experimental extension
 * io.modelcontextprotocol/server-card (SEP-2127), a document a client or a crawler reads before it connects.
 *
 * name, description, repository and remotes mirror server.json in tibia-sh/tibiawiki-mcp, the registry listing,
 * which the npm package does not ship, so they are literals here. version is package.json's exact pin of
 * @tibia.sh/tibiawiki-mcp, read when the Worker is bundled the way src/landing.ts reads it, and the number the
 * running server reports as its own. The $schema value is the identifier the schema's pattern requires, whether
 * or not the URL resolves. Nothing in the card comes from a request or from the environment.
 */
import packageJson from '../package.json' with { type: 'json' };

/** The card's media type, from the extension. */
export const SERVER_CARD_TYPE = 'application/mcp-server-card+json';

/** The card's Cache-Control: an hour, shared, as the extension recommends. */
export const SERVER_CARD_CACHE_CONTROL = 'public, max-age=3600';

/** The card, serialized once. */
export const SERVER_CARD: string = JSON.stringify({
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'sh.tibia/tibiawiki-mcp',
  version: packageJson.dependencies['@tibia.sh/tibiawiki-mcp'],
  description: 'TibiaWiki knowledge base: attribute queries over creatures, items, NPCs, quests and spells',
  websiteUrl: 'https://mcp.tibia.sh',
  repository: { url: 'https://github.com/tibia-sh/tibiawiki-mcp', source: 'github' },
  remotes: [{ type: 'streamable-http', url: 'https://mcp.tibia.sh/wiki' }],
});
