/**
 * The lockfile check's rules, against a fake registry and a fixed clock.
 *
 * The fixtures copy the shapes the npm registry served on 2026-09-15: a packument's `time` map, and the attestations
 * response of @tibia.sh/tibiawiki-mcp@0.5.0, whose provenance statement travels base64-encoded in a DSSE envelope.
 * The fake registry rejects every URL it was not given, so a rule that looks up the wrong document fails its test.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { checkLockfile } from '../scripts/check-lockfile.ts';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_AGO = new Date(NOW.getTime() - 30 * DAY_MS);

const PROVENANCE = 'https://slsa.dev/provenance/v1';
const PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';

/** The tarball URL npm records as `resolved` for a registry package. */
function tarball(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;
}

/** A lockfile entry installed from the registry. */
function entry(name: string, version: string): Record<string, unknown> {
  return { version, resolved: tarball(name, version), integrity: 'sha512-fixture', license: 'MIT' };
}

/** A lockfileVersion 3 lockfile holding the root entry and the given entries, keyed by install path. */
function lockfile(packages: Record<string, unknown>): unknown {
  return {
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture', version: '1.0.0', license: 'MIT' }, ...packages },
  };
}

/** The packument URL of name. */
function packumentUrl(name: string): string {
  return `https://registry.npmjs.org/${name}`;
}

/** The attestations URL of name@version. */
function attestationsUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/-/npm/v1/attestations/${name}@${version}`;
}

/** A packument whose `time` records each version's publish time. */
function packument(name: string, published: Record<string, Date>): unknown {
  const times = Object.entries(published).map(([version, date]) => [version, date.toISOString()]);
  return {
    name,
    'dist-tags': {},
    versions: {},
    time: { created: '2020-01-01T00:00:00.000Z', ...Object.fromEntries(times) },
  };
}

/** One attestation as the registry lists it, carrying payload as its DSSE envelope's base64 payload. */
function attestation(predicateType: string, payload: string): unknown {
  return {
    predicateType,
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      dsseEnvelope: {
        payload: Buffer.from(payload).toString('base64'),
        payloadType: 'application/vnd.in-toto+json',
        signatures: [{ sig: 'fixture', keyid: '' }],
      },
    },
  };
}

/** An attestation whose payload is the in-toto statement of predicate. */
function statement(predicateType: string, predicate: unknown): unknown {
  const body = { _type: 'https://in-toto.io/Statement/v1', subject: [], predicateType, predicate };
  return attestation(predicateType, JSON.stringify(body));
}

/** npm's publish attestation, which every attested package carries beside its provenance. */
const PUBLISH_ATTESTATION = statement(PUBLISH, {
  name: 'fixture',
  version: '1.0.0',
  registry: 'https://registry.npmjs.org',
});

/** The attestations response of a package built by a workflow in repository. */
function attestedFrom(repository: string): unknown {
  const provenance = statement(PROVENANCE, {
    buildDefinition: {
      buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: { workflow: { ref: 'refs/heads/main', repository, path: '.github/workflows/release.yml' } },
    },
  });
  return { attestations: [PUBLISH_ATTESTATION, provenance] };
}

/**
 * A fake fetchJson that answers from bodies, where an Error body is a failed fetch. It rejects every other URL,
 * answers on a later turn of the event loop, and records each URL it is asked for and the most fetches in flight.
 */
function fakeRegistry(bodies: Record<string, unknown>) {
  const requests: string[] = [];
  const flight = { now: 0, most: 0 };
  async function fetchJson(url: string): Promise<unknown> {
    requests.push(url);
    flight.now += 1;
    flight.most = Math.max(flight.most, flight.now);
    try {
      await setImmediate();
      if (!Object.hasOwn(bodies, url)) throw new Error(`the fake registry has no ${url}`);
      const body = bodies[url];
      if (body instanceof Error) throw body;
      return structuredClone(body);
    } finally {
      flight.now -= 1;
    }
  }
  return { fetchJson, requests, flight };
}

/** The `name@version` or install path that each failure line starts with. */
function failed(failures: string[]): string[] {
  return failures.map((line) => line.slice(0, line.indexOf(': ')));
}

describe('a package outside @tibia.sh/ needs 7 days since its release', () => {
  test('exactly 7 days passes', async () => {
    const lock = lockfile({ 'node_modules/left-pad': entry('left-pad', '1.3.0') });
    const registry = fakeRegistry({
      [packumentUrl('left-pad')]: packument('left-pad', { '1.3.0': new Date(NOW.getTime() - 7 * DAY_MS) }),
    });
    assert.deepEqual(await checkLockfile(lock, registry.fetchJson, NOW), []);
    assert.deepEqual(registry.requests, [packumentUrl('left-pad')]);
  });

  test('6 days 23 hours fails', async () => {
    const lock = lockfile({ 'node_modules/left-pad': entry('left-pad', '1.3.0') });
    const registry = fakeRegistry({
      [packumentUrl('left-pad')]: packument('left-pad', { '1.3.0': new Date(NOW.getTime() - 7 * DAY_MS + HOUR_MS) }),
    });
    const failures = await checkLockfile(lock, registry.fetchJson, NOW);
    assert.deepEqual(failed(failures), ['left-pad@1.3.0']);
    assert.match(failures[0] ?? '', /2026-09-08T13:00:00\.000Z/);
  });

  test('a missing time entry fails', async () => {
    const lock = lockfile({
      'node_modules/left-pad': entry('left-pad', '1.3.0'),
      'node_modules/is-odd': entry('is-odd', '3.0.1'),
    });
    const registry = fakeRegistry({
      [packumentUrl('left-pad')]: packument('left-pad', { '1.2.0': MONTH_AGO }),
      [packumentUrl('is-odd')]: { name: 'is-odd', 'dist-tags': {}, versions: {} },
    });
    const failures = await checkLockfile(lock, registry.fetchJson, NOW);
    assert.deepEqual(failed(failures), ['left-pad@1.3.0', 'is-odd@3.0.1']);
  });

  test('a scope that only begins with @tibia.sh is not first-party', async () => {
    const name = '@tibia.sh-mirror/tibiawiki-mcp';
    const lock = lockfile({ [`node_modules/${name}`]: entry(name, '0.5.0') });
    const registry = fakeRegistry({ [packumentUrl(name)]: packument(name, { '0.5.0': NOW }) });
    const failures = await checkLockfile(lock, registry.fetchJson, NOW);
    assert.deepEqual(failed(failures), [`${name}@0.5.0`]);
    assert.deepEqual(registry.requests, [packumentUrl(name)]);
  });
});

describe('an @tibia.sh/ package needs provenance from a tibia-sh repository', () => {
  const MCP = '@tibia.sh/tibiawiki-mcp';
  const DATA = '@tibia.sh/tibiawiki-data';
  const firstParty = () =>
    lockfile({ [`node_modules/${MCP}`]: entry(MCP, '0.5.0'), [`node_modules/${DATA}`]: entry(DATA, '3.0.3') });

  test('provenance from tibia-sh passes, however new the release', async () => {
    const registry = fakeRegistry({
      [attestationsUrl(MCP, '0.5.0')]: attestedFrom('https://github.com/tibia-sh/tibiawiki-mcp'),
      [attestationsUrl(DATA, '3.0.3')]: attestedFrom('https://github.com/tibia-sh/tibiawiki-data'),
    });
    assert.deepEqual(await checkLockfile(firstParty(), registry.fetchJson, NOW), []);
    assert.deepEqual(registry.requests.toSorted(), [attestationsUrl(DATA, '3.0.3'), attestationsUrl(MCP, '0.5.0')]);
  });

  test('provenance from another owner fails', async () => {
    const registry = fakeRegistry({
      [attestationsUrl(MCP, '0.5.0')]: attestedFrom('https://github.com/someone-else/tibiawiki-mcp'),
      [attestationsUrl(DATA, '3.0.3')]: attestedFrom('https://github.com/tibia-sh-fork/tibiawiki-data'),
    });
    const failures = await checkLockfile(firstParty(), registry.fetchJson, NOW);
    assert.deepEqual(failed(failures), [`${MCP}@0.5.0`, `${DATA}@3.0.3`]);
    assert.match(failures[0] ?? '', /someone-else/);
  });

  test('no provenance attestation fails', async () => {
    const registry = fakeRegistry({
      [attestationsUrl(MCP, '0.5.0')]: { attestations: [PUBLISH_ATTESTATION] },
      [attestationsUrl(DATA, '3.0.3')]: { attestations: [] },
    });
    const failures = await checkLockfile(firstParty(), registry.fetchJson, NOW);
    assert.deepEqual(failed(failures), [`${MCP}@0.5.0`, `${DATA}@3.0.3`]);
  });

  test('a provenance payload that is not a JSON statement fails', async () => {
    const registry = fakeRegistry({
      [attestationsUrl(MCP, '0.5.0')]: { attestations: [PUBLISH_ATTESTATION, attestation(PROVENANCE, 'not json')] },
      [attestationsUrl(DATA, '3.0.3')]: attestedFrom('https://github.com/tibia-sh/tibiawiki-data'),
    });
    const failures = await checkLockfile(firstParty(), registry.fetchJson, NOW);
    assert.deepEqual(failed(failures), [`${MCP}@0.5.0`]);
  });
});

describe('fetching', () => {
  test('a failed fetch fails that entry only', async () => {
    const lock = lockfile({
      'node_modules/left-pad': entry('left-pad', '1.3.0'),
      'node_modules/is-odd': entry('is-odd', '3.0.1'),
    });
    const registry = fakeRegistry({
      [packumentUrl('left-pad')]: new Error('socket hang up'),
      [packumentUrl('is-odd')]: packument('is-odd', { '3.0.1': MONTH_AGO }),
    });
    const failures = await checkLockfile(lock, registry.fetchJson, NOW);
    assert.deepEqual(failed(failures), ['left-pad@1.3.0']);
    assert.match(failures[0] ?? '', /socket hang up/);
  });

  test('duplicate name@version entries are fetched once', async () => {
    const lock = lockfile({
      'node_modules/a': entry('a', '1.0.0'),
      'node_modules/a/node_modules/is-odd': entry('is-odd', '3.0.1'),
      'node_modules/b': entry('b', '1.0.0'),
      'node_modules/b/node_modules/is-odd': entry('is-odd', '3.0.1'),
    });
    const registry = fakeRegistry({
      [packumentUrl('a')]: packument('a', { '1.0.0': MONTH_AGO }),
      [packumentUrl('b')]: packument('b', { '1.0.0': MONTH_AGO }),
      [packumentUrl('is-odd')]: packument('is-odd', { '3.0.1': NOW }),
    });
    const failures = await checkLockfile(lock, registry.fetchJson, NOW);
    assert.deepEqual(failed(failures), ['is-odd@3.0.1']);
    assert.deepEqual(registry.requests.toSorted(), [packumentUrl('a'), packumentUrl('b'), packumentUrl('is-odd')]);
  });

  test('at most 8 fetches run at a time', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `package-${index}`);
    const lock = lockfile(Object.fromEntries(names.map((name) => [`node_modules/${name}`, entry(name, '1.0.0')])));
    const registry = fakeRegistry(
      Object.fromEntries(names.map((name) => [packumentUrl(name), packument(name, { '1.0.0': MONTH_AGO })])),
    );
    assert.deepEqual(await checkLockfile(lock, registry.fetchJson, NOW), []);
    assert.equal(registry.requests.length, 20);
    assert.equal(registry.flight.most, 8);
  });
});

describe('lockfile entries', () => {
  test('the root entry is not a package to check', async () => {
    const registry = fakeRegistry({});
    assert.deepEqual(await checkLockfile(lockfile({}), registry.fetchJson, NOW), []);
    assert.deepEqual(registry.requests, []);
  });

  test('an aliased entry is checked under the name it was installed from', async () => {
    const lock = lockfile({
      'node_modules/string-width-cjs': { ...entry('string-width', '4.2.3'), name: 'string-width' },
    });
    const registry = fakeRegistry({ [packumentUrl('string-width')]: packument('string-width', { '4.2.3': NOW }) });
    const failures = await checkLockfile(lock, registry.fetchJson, NOW);
    assert.deepEqual(failed(failures), ['string-width@4.2.3']);
  });

  test('an entry that does not resolve to its own registry tarball fails without a lookup', async () => {
    const lock = lockfile({
      'node_modules/from-git': { version: '1.0.0', resolved: 'git+ssh://git@github.com/someone/from-git.git#0123abc' },
      'node_modules/left-pad': { ...entry('left-pad', '1.3.0'), resolved: tarball('evil-pad', '0.0.1') },
      'node_modules/no-resolved': { version: '1.0.0' },
      'node_modules/no-version': { resolved: tarball('no-version', '1.0.0') },
      'node_modules/escape': { ...entry('@tibia.sh/../escape', '1.0.0'), name: '@tibia.sh/../escape' },
      'packages/workspace': { resolved: 'packages/workspace', link: true },
    });
    const registry = fakeRegistry({});
    const failures = await checkLockfile(lock, registry.fetchJson, NOW);
    assert.deepEqual(failed(failures), [
      'node_modules/from-git',
      'node_modules/left-pad',
      'node_modules/no-resolved',
      'node_modules/no-version',
      'node_modules/escape',
      'packages/workspace',
    ]);
    assert.deepEqual(registry.requests, []);
  });

  test('a lockfile without a packages object, or an invalid now, is rejected', async () => {
    const { fetchJson } = fakeRegistry({});
    await assert.rejects(checkLockfile({ lockfileVersion: 1, dependencies: {} }, fetchJson, NOW), /packages/);
    await assert.rejects(checkLockfile(null, fetchJson, NOW), /packages/);
    await assert.rejects(checkLockfile(lockfile({}), fetchJson, new Date(Number.NaN)), /now/);
  });
});
