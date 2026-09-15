/**
 * The landing page's content: the URL to add, both source repos, the privacy note, the deployed versions and the
 * attribution.
 *
 * The versions come from package.json and the attribution from the installed server, so a Dependabot bump that
 * changes either one fails here until the page follows.
 */
import { ATTRIBUTION } from '@tibia.sh/tibiawiki-mcp/dist/server.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import packageJson from '../package.json' with { type: 'json' };
import { landingPage } from '../src/landing.ts';

/** Fails with the missing text, not the whole page. */
function assertContains(text: string): void {
  assert.ok(landingPage().includes(text), `the landing page does not contain ${JSON.stringify(text)}`);
}

test('it gives the URL to add and links both source repos', () => {
  assertContains('https://mcp.tibia.sh/wiki');
  assertContains('href="https://github.com/tibia-sh/tibiawiki-mcp"');
  assertContains('href="https://github.com/tibia-sh/mcp.tibia.sh"');
});

test("it carries the privacy note's three statements", () => {
  assertContains('Cloudflare processes every request. Your IP address is used for rate limiting.');
  assertContains(
    "Cloudflare's analytics may keep sampled request details, such as your IP address, under Cloudflare's own policies.",
  );
  assertContains(
    'This service writes no request logs. It writes only startup, sleep and error lines, with no data from your requests, and keeps them for 7 days.',
  );
});

test('it shows the server and data versions that package.json pins', () => {
  const pins = packageJson.dependencies;
  assertContains(`@tibia.sh/tibiawiki-mcp@${pins['@tibia.sh/tibiawiki-mcp']}`);
  assertContains(`@tibia.sh/tibiawiki-data@${pins['@tibia.sh/tibiawiki-data']}`);
});

test("it quotes the first two sentences of the server's ATTRIBUTION", () => {
  // A sentence ends at a period followed by a space. The periods inside the URL are followed by letters.
  const sentences = ATTRIBUTION.split(/(?<=\.) /);
  assert.ok(sentences.length >= 2, `ATTRIBUTION has fewer than two sentences: ${JSON.stringify(ATTRIBUTION)}`);
  assertContains(sentences.slice(0, 2).join(' '));
});
