/**
 * The registry client the lockfile check and the bump script share: the URLs it builds, the provenance entries it
 * picks out of an attestations document, and its bounded fetch, against a loopback server.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import {
  attestationsUrl,
  errorText,
  fetchJson,
  packumentUrl,
  provenanceAttestations,
  PROVENANCE,
} from '../scripts/registry.ts';

describe('the URLs', () => {
  test("a scoped package's slash is escaped, and an unscoped name is used as it is", () => {
    assert.equal(packumentUrl('@tibia.sh/tibiawiki-mcp'), 'https://registry.npmjs.org/@tibia.sh%2Ftibiawiki-mcp');
    assert.equal(packumentUrl('left-pad'), 'https://registry.npmjs.org/left-pad');
    assert.equal(
      attestationsUrl('@tibia.sh/tibiawiki-mcp', '0.6.0'),
      'https://registry.npmjs.org/-/npm/v1/attestations/@tibia.sh%2Ftibiawiki-mcp@0.6.0',
    );
    assert.equal(
      attestationsUrl('left-pad', '1.3.0'),
      'https://registry.npmjs.org/-/npm/v1/attestations/left-pad@1.3.0',
    );
  });
});

describe('the provenance attestations', () => {
  const publish = { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} };
  const bundle = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' };
  const provenance = { predicateType: PROVENANCE, bundle };

  test('are the entries with the provenance predicate type, in order, whatever they carry', () => {
    assert.deepEqual(provenanceAttestations({ attestations: [publish, provenance] }), [provenance]);
    const twice = provenanceAttestations({ attestations: [provenance, publish, provenance] });
    assert.deepEqual(twice, [provenance, provenance]);
    const bare = { predicateType: PROVENANCE };
    assert.deepEqual(provenanceAttestations({ attestations: [bare] }), [bare]);
  });

  test('are none for a document of another shape', () => {
    for (const document of [undefined, null, 'text', [], {}, { attestations: {} }, { attestations: [{}, null, 1] }]) {
      assert.deepEqual(provenanceAttestations(document), [], JSON.stringify(document) ?? 'undefined');
    }
  });
});

describe('the bounded fetch', () => {
  /** Serves /ok.json as JSON, /slow.json after a pause longer than any bound the tests use, and 404 otherwise. */
  async function serve(work: (origin: string) => Promise<void>): Promise<void> {
    const server = createServer((request, response) => {
      if (request.url === '/ok.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"name":"left-pad","versions":{"1.3.0":{}}}');
      } else if (request.url === '/slow.json') {
        setTimeout(() => response.end('{}'), 2000).unref();
      } else {
        response.writeHead(404);
        response.end('not here');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await work(`http://127.0.0.1:${port}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('resolves with the JSON body, rejects on a status outside 200 to 299, and on the bound', async () => {
    await serve(async (origin) => {
      assert.deepEqual(await fetchJson(`${origin}/ok.json`, 5000), { name: 'left-pad', versions: { '1.3.0': {} } });
      await assert.rejects(fetchJson(`${origin}/missing.json`, 5000), { message: 'HTTP 404' });
      await assert.rejects(fetchJson(`${origin}/slow.json`, 100), { message: 'no complete answer within 0.1 s' });
    });
  });

  test('a connection that fails rejects with the network error as its text', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await assert.rejects(fetchJson(`http://127.0.0.1:${port}/ok.json`, 5000), (error: unknown) => {
      assert.match(errorText(error), /^fetch failed: .*ECONNREFUSED/);
      return true;
    });
  });
});
