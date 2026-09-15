/**
 * The landing page, served for HTML requests on / and /wiki without waking the container.
 *
 * The versions are package.json's exact pins, read when the Worker is bundled, so the page names what the image
 * was built from. The attribution quotes the first two sentences of the server's ATTRIBUTION, which
 * test/landing.test.ts compares with the installed server. The Worker cannot import the server module, which
 * loads node:sqlite.
 */
import packageJson from '../package.json' with { type: 'json' };

const SERVER = `@tibia.sh/tibiawiki-mcp@${packageJson.dependencies['@tibia.sh/tibiawiki-mcp']}`;
const DATA = `@tibia.sh/tibiawiki-data@${packageJson.dependencies['@tibia.sh/tibiawiki-data']}`;

/** The whole page, as HTML. */
export function landingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>mcp.tibia.sh</title>
<style>body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; }</style>
</head>
<body>
<h1>mcp.tibia.sh</h1>
<p>mcp.tibia.sh hosts MCP servers for Tibia. It runs one server today:</p>
<ul>
<li><code>/wiki</code> is the TibiaWiki MCP server. It answers attribute queries over creatures, items, NPCs, quests and spells from a snapshot of TibiaWiki.</li>
</ul>
<p>To use it, add <code>https://mcp.tibia.sh/wiki</code> to your MCP client as a remote MCP server. It needs no authentication.</p>
<p><code>/wiki</code> runs <code>${SERVER}</code> with the index from <code>${DATA}</code>.</p>
<p>The server's source is at <a href="https://github.com/tibia-sh/tibiawiki-mcp">github.com/tibia-sh/tibiawiki-mcp</a>. This deployment's source is at <a href="https://github.com/tibia-sh/mcp.tibia.sh">github.com/tibia-sh/mcp.tibia.sh</a>.</p>
<p>Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by CipSoft; game content and images are copyright CipSoft GmbH.</p>
<p>What happens to your requests:</p>
<ul>
<li>Cloudflare processes every request. Your IP address is used for rate limiting.</li>
<li>Cloudflare's analytics may keep sampled request details, such as your IP address, under Cloudflare's own policies.</li>
<li>This service writes no request logs. It writes only error lines without data from your requests, and keeps them for 7 days.</li>
</ul>
</body>
</html>
`;
}
