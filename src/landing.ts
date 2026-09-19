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
<meta name="description" content="A free MCP server that lets your AI assistant answer questions about Tibia from TibiaWiki. No account, nothing to install.">
<title>Ask your AI about Tibia - mcp.tibia.sh</title>
<style>
:root {
  --page: #eceef0; --ink: #18202b; --muted: #55606e; --link: #1d4e9e; --rule: #c9ced4; --field: #ffffff;
  --console: #0e1116; --say: #f2e266; --look: #5bdb6e; --npc: #86d9ee; --system: #9aa4ae;
}
@media (prefers-color-scheme: dark) {
  :root { --page: #12161c; --ink: #e6e9ed; --muted: #9aa4ae; --link: #8fb8ff; --rule: #2c333d; --field: #0e1116; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 0.95rem/1.65 Verdana, Geneva, "DejaVu Sans", sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 3.5rem 1.25rem 2rem; }
h1, h2 { font-family: Georgia, "Times New Roman", serif; font-weight: normal; line-height: 1.15; }
h1 { font-size: clamp(2.1rem, 6vw, 3.1rem); letter-spacing: -0.01em; margin: 0 0 1rem; text-wrap: balance; }
h2 { font-size: 1.5rem; margin: 3.25rem 0 0.75rem; }
p, ul, ol { margin: 0 0 1rem; }
ul, ol { padding-left: 1.25rem; }
li { margin-bottom: 0.35rem; }
a { color: var(--link); text-underline-offset: 0.15em; }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; }
pre { background: var(--field); border: 1px solid var(--rule); padding: 0.75rem 0.9rem; overflow-x: auto; margin: 0.5rem 0 1rem; }
.lede { font-size: 1.1rem; max-width: 34rem; }
.console { background: var(--console); color: var(--system); margin: 2rem 0 0.5rem; padding: 1rem 1.1rem; font-size: 0.85rem; line-height: 1.7; border: 2px solid #3b424c; box-shadow: inset 0 0 0 1px #000; }
.console p { margin: 0; }
.console .say { color: var(--say); }
.console .look { color: var(--look); }
.console .npc { color: var(--npc); }
.console .indent { padding-left: 2.9rem; }
.note { color: var(--muted); font-size: 0.85rem; }
.address { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.5rem 0 1.25rem; }
.address code { flex: 1 1 16rem; background: var(--field); border: 1px solid var(--rule); padding: 0.6rem 0.8rem; font-size: 1rem; overflow-wrap: anywhere; }
.address button { font: inherit; color: var(--page); background: var(--ink); border: 0; padding: 0.6rem 1rem; cursor: pointer; }
details { border-top: 1px solid var(--rule); padding: 0.6rem 0; }
details:last-of-type { border-bottom: 1px solid var(--rule); }
summary { cursor: pointer; font-weight: bold; }
details > *:not(summary) { margin-top: 0.6rem; }
footer { max-width: 40rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: 0.85rem; }
@media (prefers-reduced-motion: no-preference) {
  .console p { opacity: 0; animation: appear 0.25s ease-out forwards; }
  .console p:nth-child(1) { animation-delay: 0.3s; }
  .console p:nth-child(2) { animation-delay: 1.1s; }
  .console p:nth-child(3) { animation-delay: 1.9s; }
  .console p:nth-child(4) { animation-delay: 2.2s; }
  .console p:nth-child(5) { animation-delay: 2.5s; }
  .console p:nth-child(6) { animation-delay: 2.8s; }
  @keyframes appear { to { opacity: 1; } }
}
</style>
</head>
<body>
<main>
<h1>Ask your AI about Tibia</h1>
<p class="lede">mcp.tibia.sh connects AI assistants to TibiaWiki. They stop guessing and look things up: drop rates, prices, creature weaknesses, quest rewards.</p>

<div class="console" role="img" aria-label="An example. You ask what drops a dragon shield and how likely it is. The assistant asks TibiaWiki and answers: Eldritch Dragon Lord 25.93%, Grand Mother Foulscale 5%, Inkwing 2.61%, Dragolisk 0.61%, Dragon 0.30%. No NPC sells it and no quest rewards it.">
<p class="say">14:02 You: What drops a dragon shield, and how likely is it?</p>
<p>14:02 Your assistant asks TibiaWiki.</p>
<p class="look">14:02 You see a dragon shield.</p>
<p class="npc indent">It drops from Eldritch Dragon Lord (25.93%), Grand Mother Foulscale (5%), Inkwing (2.61%), Dragolisk (0.61%) and Dragon (0.30%).</p>
<p class="npc indent">No NPC sells it, and no quest rewards it.</p>
<p class="indent">Source: tibia.fandom.com/wiki/Dragon_Shield</p>
</div>
<p class="note">An example, with the numbers TibiaWiki held on 14 September 2026.</p>

<h2>Add it to your assistant</h2>
<p>It is free, and needs no account and nothing installed. Give your assistant this address:</p>
<div class="address"><code id="address">https://mcp.tibia.sh/wiki</code><button type="button" id="copy">Copy address</button></div>

<details>
<summary>claude.ai and the Claude apps</summary>
<ol>
<li>Open Settings, then Connectors.</li>
<li>Choose Add custom connector.</li>
<li>Name it TibiaWiki, paste the address and add it.</li>
</ol>
</details>
<details>
<summary>Claude Code</summary>
<pre>claude mcp add --transport http tibiawiki https://mcp.tibia.sh/wiki</pre>
</details>
<details>
<summary>Cursor</summary>
<p>Add this to <code>.cursor/mcp.json</code>:</p>
<pre>{
  "mcpServers": {
    "tibiawiki": { "url": "https://mcp.tibia.sh/wiki" }
  }
}</pre>
</details>
<details>
<summary>Anything else that speaks MCP</summary>
<p>Add the address wherever your client asks for a remote MCP server. It speaks Streamable HTTP and needs no authentication.</p>
</details>

<h2>Things to ask</h2>
<ul>
<li>Which creatures are weak to fire and give over 500 experience?</li>
<li>Where do I buy a steel helmet, and for how much?</li>
<li>What does a Dragon Lord drop, and what is it immune to?</li>
<li>Which two-handed swords can I use at level 100 or below?</li>
<li>What do I get for the Annihilator Quest, and what guards it?</li>
</ul>
<p>It knows creatures, items, NPCs, quests and spells.</p>

<h2>Good to know</h2>
<ul>
<li>The answers come from a snapshot of TibiaWiki, refreshed when the wiki changes. It is not live game or server state, and every answer says when the snapshot was taken.</li>
<li>You get about 300 requests a minute. That is plenty for a conversation.</li>
<li>You can run the same server on your own machine, offline. <a href="https://github.com/tibia-sh/tibiawiki-mcp">github.com/tibia-sh/tibiawiki-mcp</a> shows how.</li>
</ul>

<h2>What happens to your requests</h2>
<ul>
<li>Cloudflare processes every request. Your IP address is used for rate limiting.</li>
<li>Cloudflare's analytics may keep sampled request details, such as your IP address, under Cloudflare's own policies.</li>
<li>This service writes no request logs. It writes only startup, sleep and error lines, with no data from your requests, and keeps them for 7 days.</li>
</ul>
</main>
<footer>
<p>Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by CipSoft; game content and images are copyright CipSoft GmbH. This site is not affiliated with CipSoft.</p>
<p><code>/wiki</code> runs <code>${SERVER}</code> with the index from <code>${DATA}</code>. The server's source is at <a href="https://github.com/tibia-sh/tibiawiki-mcp">github.com/tibia-sh/tibiawiki-mcp</a>. This deployment's source is at <a href="https://github.com/tibia-sh/mcp.tibia.sh">github.com/tibia-sh/mcp.tibia.sh</a>.</p>
</footer>
<script>
document.getElementById('copy').addEventListener('click', function (event) {
  navigator.clipboard.writeText(document.getElementById('address').textContent).then(function () {
    event.target.textContent = 'Copied';
  });
});
</script>
</body>
</html>
`;
}
