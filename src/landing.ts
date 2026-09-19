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
<meta name="color-scheme" content="light">
<meta name="description" content="A free MCP server that lets your AI assistant answer questions about Tibia from TibiaWiki. No account, nothing to install.">
<title>Ask your AI about Tibia - mcp.tibia.sh</title>
<style>
:root {
  --night: #050b18; --sky: #24365f; --parchment: #fdf1dc; --row: #f1e0c6; --row-alt: #d4c0a1; --ink: #2b1b0b;
  --brown: #5a2800; --link: #004294; --gold: #b9995a; --frame: #1c1407; --cream: #f5e7c3;
  --console: #0e1116; --say: #f2e266; --look: #5bdb6e; --npc: #86d9ee; --system: #9aa4ae;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; color: var(--ink); font: 0.9rem/1.65 Verdana, Geneva, "DejaVu Sans", sans-serif;
  background: var(--night) radial-gradient(ellipse 90rem 40rem at 50% -8rem, var(--sky) 0%, #0b1730 55%, var(--night) 100%) no-repeat; }
header, main, footer { max-width: 44rem; margin: 0 auto; }
header { padding: 3.5rem 1.25rem 2rem; color: var(--cream); }
h1 { font: normal clamp(2.1rem, 6vw, 3.1rem)/1.15 Georgia, "Times New Roman", serif; letter-spacing: -0.01em; margin: 0 0 1rem; color: #f3d98b; text-shadow: 0 2px 0 #000; text-wrap: balance; }
.lede { font-size: 1.05rem; max-width: 36rem; margin: 0; }
main { background: var(--parchment); padding: 0 1.25rem 1.5rem; box-shadow: 0 0 0 2px var(--frame), 0 0 0 5px var(--gold), 0 0 0 7px var(--frame), 0 1.5rem 3rem #000; }
h2, .headline { margin: 0 -1.25rem 1rem; padding: 0.4rem 1.25rem; color: var(--cream); border-top: 1px solid var(--gold); border-bottom: 1px solid var(--gold); text-shadow: 0 1px 0 #000; }
h2 { font: small-caps normal 1.3rem/1.3 Georgia, "Times New Roman", serif; letter-spacing: 0.03em; margin-top: 2rem; background: linear-gradient(#3f6e2e, #1d4519); }
.headline { font-size: 0.85rem; font-weight: bold; background: linear-gradient(#7a1418, #4d0a0d); }
.headline span { font-weight: normal; font-size: 0.75rem; }
p, ul, ol { margin: 0 0 1rem; }
ul, ol { padding-left: 1.25rem; }
li { margin-bottom: 0.35rem; }
a { color: var(--link); font-weight: bold; text-underline-offset: 0.15em; }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.95em; }
pre { background: var(--row); border: 1px solid var(--row-alt); padding: 0.75rem 0.9rem; overflow-x: auto; margin: 0.5rem 0 0; }
.console { background: var(--console); color: var(--system); margin: 0 0 0.5rem; padding: 1rem 1.1rem; font-size: 0.85rem; line-height: 1.7; border: 2px solid #3b424c; box-shadow: inset 0 0 0 1px #000; }
.console p { margin: 0; }
.console .say { color: var(--say); }
.console .look { color: var(--look); }
.console .npc { color: var(--npc); }
.console .indent { padding-left: 2.9rem; }
.note { color: var(--brown); font-size: 0.8rem; }
.address { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.5rem 0 1.25rem; }
.address code { flex: 1 1 16rem; background: #fff; border: 1px solid var(--row-alt); padding: 0.6rem 0.8rem; font-size: 1rem; overflow-wrap: anywhere; }
.address button { font: bold 0.9rem Verdana, Geneva, sans-serif; color: #ffd800; text-shadow: 0 1px 0 #000; background: linear-gradient(#2f62e0, #0a2a90); border: 2px solid var(--frame); box-shadow: 0 0 0 1px var(--gold); padding: 0.55rem 1rem; cursor: pointer; }
.address button:hover { background: linear-gradient(#3d72f0, #12369f); }
details { background: var(--row); padding: 0.55rem 0.75rem; border: 1px solid var(--row-alt); border-bottom: 0; }
details:nth-of-type(even) { background: var(--row-alt); }
details:last-of-type { border-bottom: 1px solid var(--row-alt); }
summary { cursor: pointer; font-weight: bold; color: var(--brown); }
details > *:not(summary) { margin-top: 0.6rem; margin-bottom: 0.25rem; }
footer { padding: 1.75rem 1.25rem 3rem; color: #a9b3c6; font-size: 0.8rem; }
footer a { color: #9fc0ff; font-weight: normal; }
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
<header>
<h1>Ask your AI about Tibia</h1>
<p class="lede">mcp.tibia.sh connects AI assistants to TibiaWiki. They stop guessing and look things up: drop rates, prices, creature weaknesses, quest rewards.</p>
</header>
<main>
<p class="headline"><span>Sep 14 2026 -</span> What drops a dragon shield?</p>
<div class="console">
<p class="say">14:02 You: What drops a dragon shield, and how likely is it?</p>
<p>14:02 Your assistant asks TibiaWiki.</p>
<p class="look">14:02 You see a dragon shield.</p>
<p class="npc indent">It drops most often from Eldritch Dragon Lord (25.93%), Grand Mother Foulscale (5%), Inkwing (2.61%), Dragolisk (0.61%) and Dragon (0.30%).</p>
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
<li>You get about 300 messages a minute, which is plenty for a conversation. If you use claude.ai, you share Anthropic's addresses with its other users, so you share one allowance with them.</li>
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
  }).catch(function () {
    event.target.textContent = 'Select the address to copy it';
  });
});
</script>
</body>
</html>
`;
}
