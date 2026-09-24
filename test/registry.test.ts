/**
 * The registry client the lockfile check and the bump script share: the URLs it builds, the provenance entries it
 * picks out of an attestations document, and its bounded fetches, against a loopback server.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import {
  attestationsUrl,
  errorText,
  fetchJson,
  fetchStatus,
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
  /**
   * Serves /ok.json as JSON, /moved.tgz as a redirect to /ok.json, /slow.json after a pause longer than any bound
   * the tests use, and 404 otherwise, and records the method of each request.
   */
  async function serve(work: (origin: string, methods: string[]) => Promise<void>): Promise<void> {
    const methods: string[] = [];
    const server = createServer((request, response) => {
      methods.push(request.method ?? '');
      if (request.url === '/ok.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"name":"left-pad","versions":{"1.3.0":{}}}');
      } else if (request.url === '/moved.tgz') {
        response.writeHead(302, { location: '/ok.json' });
        response.end();
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
      await work(`http://127.0.0.1:${port}`, methods);
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

  test('the status fetch asks with HEAD, follows a redirect, takes any status, and rejects on the bound', async () => {
    await serve(async (origin, methods) => {
      assert.equal(await fetchStatus(`${origin}/ok.json`, 5000), 200);
      assert.equal(await fetchStatus(`${origin}/missing.tgz`, 5000), 404);
      assert.equal(await fetchStatus(`${origin}/moved.tgz`, 5000), 200);
      await assert.rejects(fetchStatus(`${origin}/slow.json`, 100), { message: 'no answer within 0.1 s' });
      assert.deepEqual(methods, ['HEAD', 'HEAD', 'HEAD', 'HEAD', 'HEAD']);
    });
  });

  test('a connection that fails rejects with the network error as its text', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const fetching of [fetchJson, fetchStatus]) {
      await assert.rejects(fetching(`http://127.0.0.1:${port}/ok.json`, 5000), (error: unknown) => {
        assert.match(errorText(error), /^fetch failed: .*ECONNREFUSED/);
        return true;
      });
    }
  });
});
