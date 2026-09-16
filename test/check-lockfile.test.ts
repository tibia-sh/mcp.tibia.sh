/**
 * The lockfile check's rules, against a fake registry, a fake gh and a fixed clock.
 *
 * The fixtures copy the shapes pnpm 12.4.1 and the npm registry produced on 2026-09-15: a lockfile of two documents,
 * the first recording pnpm's own executable, a packument's `time` map, and the attestations response of
 * @tibia.sh/tibiawiki-mcp@0.6.0, whose provenance bundle gh verifies. The fake registry rejects every URL it was
 * not given, and the fake gh every workflow, so a rule that looks up the wrong document fails its test.
 *
 * The real download and gh runner are covered at the end, against a loopback server and shell scripts named gh.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { stringify } from 'yaml';
import { checkLockfile, download, ghVerify, projectDocument } from '../scripts/check-lockfile.ts';
import type { Download, Verify } from '../scripts/check-lockfile.ts';
import type { FetchJson } from '../scripts/registry.ts';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_AGO = new Date(NOW.getTime() - 30 * DAY_MS);

const PROVENANCE = 'https://slsa.dev/provenance/v1';
const PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';

const MCP = '@tibia.sh/tibiawiki-mcp';
const DATA = '@tibia.sh/tibiawiki-data';
const MCP_WORKFLOW = 'tibia-sh/tibiawiki-mcp/.github/workflows/release.yml';
const DATA_WORKFLOW = 'tibia-sh/tibiawiki-data/.github/workflows/release.yml';
/** What package.json pins, as the CLI reads it. */
const PINS = { [MCP]: '0.6.0', [DATA]: '3.0.3' };

/** The sha512 integrity of text, as the registry and the lockfile write it. */
function integrityOf(text: string | Uint8Array): string {
  return `sha512-${createHash('sha512').update(text).digest('base64')}`;
}

/** A lockfile `packages` entry installed from the registry. */
function entry(integrity: string): Record<string, unknown> {
  return { resolution: { integrity } };
}

/** The `packages` key of a registry package. */
function spec(name: string, version: string): string {
  return `${name}@${version}`;
}

/** The first document of pnpm-lock.yaml, which records pnpm's own executable, cut to two of its packages. */
const PACKAGE_MANAGER_DOCUMENT = `lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.4.1
        version: 12.4.1

packages:

  '@pnpm/exe.darwin-arm64@12.4.1':
    resolution: {integrity: sha512-6rkZkT3iGfaxknUdGHraqSWFvTa6N0ajAHluv9Ax0GRWs0sIcGNiFhDopv6xSZCsJZmG483aNS/b6UEDy3blfw==}
    cpu: [arm64]
    os: [darwin]

  pnpm@12.4.1:
    resolution: {integrity: sha512-LoHjmdc/6DkNqyXgaqeIq3pZCCSNL1o3D4K0gRR6ano2e/gEj5pv22Rg8hpm8FQt7bi5TKLIcjWWdBkgsWVtTA==}
    engines: {node: '>=18.*'}
    hasBin: true

snapshots:

  '@pnpm/exe.darwin-arm64@12.4.1':
    optional: true

  pnpm@12.4.1:
    optionalDependencies:
      '@pnpm/exe.darwin-arm64': 12.4.1
`;

/** The importer's dependencies for the given `packages` keys, as pnpm records them. */
function dependenciesOf(packages: Record<string, unknown>): Record<string, unknown> {
  const dependencies = Object.keys(packages).flatMap((key) => {
    const at = key.lastIndexOf('@');
    return at > 0 ? [[key.slice(0, at), { specifier: key.slice(at + 1), version: key.slice(at + 1) }]] : [];
  });
  return Object.fromEntries(dependencies);
}

/** A two-document pnpm-lock.yaml whose project document holds the given `packages` under the given importer. */
function lockfileText(
  packages: Record<string, unknown>,
  importer: unknown = { dependencies: dependenciesOf(packages) },
): string {
  const project = {
    lockfileVersion: '9.0',
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: { '.': importer },
    packages,
    snapshots: Object.fromEntries(Object.keys(packages).map((key) => [key, {}])),
  };
  return `---\n${PACKAGE_MANAGER_DOCUMENT}---\n${stringify(project)}`;
}

/** The parsed project document of a lockfile holding the given `packages`. */
function lock(packages: Record<string, unknown>): unknown {
  return projectDocument(lockfileText(packages));
}

/** The packument URL of name, with the scope's slash escaped as the registry's own URLs escape it. */
function packumentUrl(name: string): string {
  return `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
}

/** The attestations URL of name@version. */
function attestationsUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace('/', '%2F')}@${version}`;
}

/** The tarball URL of name@version, which the registry serves without escaping. */
function tarballUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;
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

/** A Sigstore bundle as the registry serves it, cut to its shape, signing the given statement. */
function bundle(statement: string): Record<string, unknown> {
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: { certificate: { rawBytes: 'fixture' }, tlogEntries: [], timestampVerificationData: {} },
    dsseEnvelope: {
      payload: Buffer.from(statement).toString('base64'),
      payloadType: 'application/vnd.in-toto+json',
      signatures: [{ sig: 'fixture', keyid: '' }],
    },
  };
}

/** npm's publish attestation, which every attested package carries beside its provenance. */
const PUBLISH_ATTESTATION = { predicateType: PUBLISH, bundle: bundle('{"predicateType":"publish"}') };

/** The provenance attestation of name@version, whose bundle gh would verify. */
function provenanceAttestation(name: string, version: string): { predicateType: string; bundle: unknown } {
  const statement = `{"predicateType":"${PROVENANCE}","subject":"${name}@${version}"}`;
  return { predicateType: PROVENANCE, bundle: bundle(statement) };
}

/** The attestations response of name@version: npm's publish attestation and the provenance. */
function attested(name: string, version: string): unknown {
  return { attestations: [PUBLISH_ATTESTATION, provenanceAttestation(name, version)] };
}

/**
 * A fake fetchJson that answers from bodies, where an Error body is a failed fetch. It rejects every other URL,
 * answers on a later turn of the event loop, and records each URL it is asked for and the most fetches in flight.
 */
function fakeRegistry(bodies: Record<string, unknown>) {
  const requests: string[] = [];
  const flight = { now: 0, most: 0 };
  const fetchJson: FetchJson = async (url) => {
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
  };
  return { fetchJson, requests, flight };
}

/**
 * A fake download that writes the body bodies holds for a URL, once a Promise body resolves, and rejects every other
 * URL or an Error body.
 */
function fakeDownloads(bodies: Record<string, string | Error | Promise<string>>) {
  const calls: { url: string; file: string }[] = [];
  const download: Download = async (url, file) => {
    calls.push({ url, file });
    await setImmediate();
    const body = await bodies[url];
    if (body === undefined) throw new Error(`the fake registry has no ${url}`);
    if (body instanceof Error) throw body;
    await writeFile(file, body);
    return integrityOf(body);
  };
  return { download, calls };
}

type VerifyCall = { tarball: string; bundle: string; workflow: string; tarballBody: string; bundleJson: unknown };

/**
 * A fake gh that answers with the verdict verdicts holds for a workflow, undefined being a pass and an Error a gh
 * that cannot run. It rejects every other workflow, and records each call with what its two files held.
 */
function fakeGh(verdicts: Record<string, string | undefined | Error>) {
  const calls: VerifyCall[] = [];
  const verify: Verify = async (input) => {
    const tarballBody = await readFile(input.tarball, 'utf8');
    const bundleJson: unknown = JSON.parse(await readFile(input.bundle, 'utf8'));
    calls.push({ ...input, tarballBody, bundleJson });
    if (!Object.hasOwn(verdicts, input.workflow)) throw new Error(`the fake gh knows no ${input.workflow}`);
    const verdict = verdicts[input.workflow];
    if (verdict instanceof Error) throw verdict;
    return verdict;
  };
  return { verify, calls };
}

/** The `name@version` or `packages` key that each failure line starts with. */
function failed(failures: string[]): string[] {
  return failures.map((line) => line.slice(0, line.indexOf(': ')));
}

let scratch: string;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'check-lockfile-test-'));
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

type Fakes = {
  registry?: ReturnType<typeof fakeRegistry>;
  downloads?: ReturnType<typeof fakeDownloads>;
  gh?: ReturnType<typeof fakeGh>;
  pins?: Record<string, string>;
};

/** The check's dependencies from the given fakes, each defaulting to one that answers nothing. */
function depsOf(fakes: Fakes = {}) {
  return {
    fetchJson: (fakes.registry ?? fakeRegistry({})).fetchJson,
    download: (fakes.downloads ?? fakeDownloads({})).download,
    verify: (fakes.gh ?? fakeGh({})).verify,
    scratch,
    pins: fakes.pins ?? PINS,
  };
}

/** Runs the check over the given `packages` with the given fakes. */
function check(packages: Record<string, unknown>, fakes: Fakes = {}) {
  return checkLockfile(lock(packages), depsOf(fakes), NOW);
}

/** The fakes that let name@version pass every first-party check. */
function goodFirstParty(name: string, version: string, workflow: string) {
  const body = `tarball of ${name}@${version}`;
  return {
    entry: entry(integrityOf(body)),
    registry: { [attestationsUrl(name, version)]: attested(name, version) },
    downloads: { [tarballUrl(name, version)]: body },
    gh: { [workflow]: undefined },
  };
}

describe('the project document', () => {
  test('the document recording the package manager is skipped, and its packages are never looked up', async () => {
    const packages = { 'left-pad@1.3.0': entry(integrityOf('left-pad')) };
    const text = lockfileText(packages);
    assert.equal(text.split('\n---\n').length, 2);
    const document = projectDocument(text);
    assert.deepEqual(Object.keys(document as Record<string, unknown>), [
      'lockfileVersion',
      'settings',
      'importers',
      'packages',
      'snapshots',
    ]);
    const registry = fakeRegistry({
      [packumentUrl('left-pad')]: packument('left-pad', { '1.3.0': MONTH_AGO }),
    });
    const verdict = await checkLockfile(document, depsOf({ registry }), NOW);
    assert.deepEqual(verdict, { failures: [], verified: [] });
    assert.deepEqual(registry.requests, [packumentUrl('left-pad')]);
  });

  test('a document is the project when its importer . has dependencies or devDependencies', () => {
    const devOnly = projectDocument(lockfileText({}, { devDependencies: {} }));
    assert.deepEqual((devOnly as { importers: unknown }).importers, { '.': { devDependencies: {} } });
  });

  test('a lockfile without a project document, or with two, is rejected', () => {
    assert.throws(() => projectDocument(`---\n${PACKAGE_MANAGER_DOCUMENT}`), /0 .*documents/);
    assert.throws(() => projectDocument(''), /0 .*documents/);
    const project = lockfileText({}).split('\n---\n')[1] ?? '';
    assert.throws(() => projectDocument(`${lockfileText({})}---\n${project}`), /2 .*documents/);
  });

  test('text that is not YAML is rejected', () => {
    assert.throws(() => projectDocument('importers: [unclosed'), /YAML/);
    assert.throws(() => projectDocument('importers:\n  .: {dependencies: {}}\nimporters: {}\n'), /YAML/);
  });

  test('entries in the flow style pnpm writes are read', async () => {
    const mcp = goodFirstParty(MCP, '0.6.0', MCP_WORKFLOW);
    const text = `---
${PACKAGE_MANAGER_DOCUMENT}---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@tibia.sh/tibiawiki-mcp':
        specifier: 0.6.0
        version: 0.6.0
      zod:
        specifier: 4.5.4
        version: 4.5.4

packages:

  '@tibia.sh/tibiawiki-mcp@0.6.0':
    resolution: {integrity: ${integrityOf('tarball of @tibia.sh/tibiawiki-mcp@0.6.0')}}
    engines: {node: '>=22'}
    hasBin: true

  zod@4.5.4:
    resolution: {integrity: ${integrityOf('zod')}}
    peerDependencies:
      '@types/node': '*'

snapshots:

  '@tibia.sh/tibiawiki-mcp@0.6.0': {}

  zod@4.5.4: {}
`;
    const registry = fakeRegistry({ ...mcp.registry, [packumentUrl('zod')]: packument('zod', { '4.5.4': MONTH_AGO }) });
    const downloads = fakeDownloads(mcp.downloads);
    const gh = fakeGh(mcp.gh);
    const verdict = await checkLockfile(projectDocument(text), depsOf({ registry, downloads, gh }), NOW);
    assert.deepEqual(verdict, { failures: [], verified: [spec(MCP, '0.6.0')] });
    assert.deepEqual(registry.requests.toSorted(), [attestationsUrl(MCP, '0.6.0'), packumentUrl('zod')]);
  });
});

describe('lockfile entries', () => {
  test('an entry that is not a registry package of its own name and version fails without a lookup', async () => {
    const registry = fakeRegistry({});
    const verdict = await check(
      {
        'left-pad': entry(integrityOf('left-pad')),
        'left-pad@1.3.0': {
          resolution: { integrity: integrityOf('left-pad'), tarball: tarballUrl('evil-pad', '0.0.1') },
        },
        'is-odd@3.0.1': {
          resolution: { type: 'git', repo: 'https://github.com/someone/is-odd.git', commit: '0123abc' },
        },
        'no-resolution@1.0.0': { engines: { node: '>=20' } },
        'sha1@1.0.0': { resolution: { integrity: 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=' } },
        'sha512-short@1.0.0': { resolution: { integrity: 'sha512-fixture' } },
        '@tibia.sh/../escape@1.0.0': entry(integrityOf('escape')),
        'from-git@https://codeload.github.com/someone/from-git/tar.gz/0123abc': entry(integrityOf('from-git')),
        'link@link:../packages/link': { resolution: { directory: '../packages/link', type: 'directory' } },
      },
      { registry },
    );
    assert.deepEqual(verdict.verified, []);
    assert.deepEqual(failed(verdict.failures), [
      'left-pad',
      'left-pad@1.3.0',
      'is-odd@3.0.1',
      'no-resolution@1.0.0',
      'sha1@1.0.0',
      'sha512-short@1.0.0',
      '@tibia.sh/../escape@1.0.0',
      'from-git@https://codeload.github.com/someone/from-git/tar.gz/0123abc',
      'link@link:../packages/link',
    ]);
    assert.match(verdict.failures[1] ?? '', /evil-pad/);
    assert.deepEqual(registry.requests, []);
  });

  test('a document without a packages mapping, or an invalid now, is rejected', async () => {
    const deps = depsOf();
    await assert.rejects(checkLockfile({ lockfileVersion: '9.0', importers: {} }, deps, NOW), /packages/);
    await assert.rejects(checkLockfile({ packages: [] }, deps, NOW), /packages/);
    await assert.rejects(checkLockfile(null, deps, NOW), /packages/);
    await assert.rejects(checkLockfile(lock({}), deps, new Date(Number.NaN)), /now/);
  });
});

describe('a package outside @tibia.sh/ needs 7 days since its release', () => {
  test('exactly 7 days passes', async () => {
    const registry = fakeRegistry({
      [packumentUrl('left-pad')]: packument('left-pad', { '1.3.0': new Date(NOW.getTime() - 7 * DAY_MS) }),
    });
    const verdict = await check({ 'left-pad@1.3.0': entry(integrityOf('left-pad')) }, { registry });
    assert.deepEqual(verdict, { failures: [], verified: [] });
    assert.deepEqual(registry.requests, [packumentUrl('left-pad')]);
  });

  test('6 days 23 hours fails', async () => {
    const registry = fakeRegistry({
      [packumentUrl('left-pad')]: packument('left-pad', { '1.3.0': new Date(NOW.getTime() - 7 * DAY_MS + HOUR_MS) }),
    });
    const { failures } = await check({ 'left-pad@1.3.0': entry(integrityOf('left-pad')) }, { registry });
    assert.deepEqual(failed(failures), ['left-pad@1.3.0']);
    assert.match(failures[0] ?? '', /2026-09-08T13:00:00\.000Z/);
  });

  test('a missing time entry fails', async () => {
    const registry = fakeRegistry({
      [packumentUrl('left-pad')]: packument('left-pad', { '1.2.0': MONTH_AGO }),
      [packumentUrl('is-odd')]: { name: 'is-odd', 'dist-tags': {}, versions: {} },
    });
    const { failures } = await check(
      { 'left-pad@1.3.0': entry(integrityOf('left-pad')), 'is-odd@3.0.1': entry(integrityOf('is-odd')) },
      { registry },
    );
    assert.deepEqual(failed(failures), ['left-pad@1.3.0', 'is-odd@3.0.1']);
  });

  test('a scope that only begins with @tibia.sh is not first-party', async () => {
    const name = '@tibia.sh-mirror/tibiawiki-mcp';
    const registry = fakeRegistry({ [packumentUrl(name)]: packument(name, { '0.6.0': NOW }) });
    const { failures } = await check({ [spec(name, '0.6.0')]: entry(integrityOf(name)) }, { registry });
    assert.deepEqual(failed(failures), [spec(name, '0.6.0')]);
    assert.deepEqual(registry.requests, [packumentUrl(name)]);
  });
});

describe('an @tibia.sh/ package needs one copy, at its pin, with provenance gh verifies', () => {
  test('a good entry passes, and gh gets its tarball, its bundle and its workflow', async () => {
    const mcp = goodFirstParty(MCP, '0.6.0', MCP_WORKFLOW);
    const data = goodFirstParty(DATA, '3.0.3', DATA_WORKFLOW);
    const registry = fakeRegistry({ ...mcp.registry, ...data.registry });
    const downloads = fakeDownloads({ ...mcp.downloads, ...data.downloads });
    const gh = fakeGh({ ...mcp.gh, ...data.gh });
    const packages = { [spec(MCP, '0.6.0')]: mcp.entry, [spec(DATA, '3.0.3')]: data.entry };
    const verdict = await check(packages, { registry, downloads, gh });
    assert.deepEqual(verdict, { failures: [], verified: [spec(MCP, '0.6.0'), spec(DATA, '3.0.3')] });
    assert.deepEqual(registry.requests.toSorted(), [attestationsUrl(DATA, '3.0.3'), attestationsUrl(MCP, '0.6.0')]);
    assert.deepEqual(
      downloads.calls.map(({ url }) => url).toSorted(),
      [tarballUrl(DATA, '3.0.3'), tarballUrl(MCP, '0.6.0')],
    );
    const calls = gh.calls.toSorted((a, b) => a.workflow.localeCompare(b.workflow));
    assert.deepEqual(
      calls.map(({ tarball, bundle: bundleFile, workflow }) => ({ workflow, tarball, bundle: bundleFile })),
      [
        {
          workflow: DATA_WORKFLOW,
          tarball: join(scratch, '@tibia.sh%2Ftibiawiki-data@3.0.3.tgz'),
          bundle: join(scratch, '@tibia.sh%2Ftibiawiki-data@3.0.3.bundle.json'),
        },
        {
          workflow: MCP_WORKFLOW,
          tarball: join(scratch, '@tibia.sh%2Ftibiawiki-mcp@0.6.0.tgz'),
          bundle: join(scratch, '@tibia.sh%2Ftibiawiki-mcp@0.6.0.bundle.json'),
        },
      ],
    );
    assert.deepEqual(
      calls.map(({ tarballBody, bundleJson }) => ({ tarballBody, bundleJson })),
      [
        { tarballBody: `tarball of ${DATA}@3.0.3`, bundleJson: provenanceAttestation(DATA, '3.0.3').bundle },
        { tarballBody: `tarball of ${MCP}@0.6.0`, bundleJson: provenanceAttestation(MCP, '0.6.0').bundle },
      ],
    );
  });

  test('a package with no registered release workflow fails without a lookup', async () => {
    const registry = fakeRegistry({});
    const { failures } = await check(
      { '@tibia.sh/other@1.0.0': entry(integrityOf('other')) },
      { registry, pins: { ...PINS, '@tibia.sh/other': '1.0.0' } },
    );
    assert.deepEqual(failures, ['@tibia.sh/other@1.0.0: no release workflow is registered for it']);
    assert.deepEqual(registry.requests, []);
  });

  test('a package at two versions fails both copies without a lookup', async () => {
    const registry = fakeRegistry({});
    const { failures } = await check(
      { [spec(DATA, '3.0.2')]: entry(integrityOf('older')), [spec(DATA, '3.0.3')]: entry(integrityOf('newer')) },
      { registry },
    );
    assert.deepEqual(failures, [
      `${DATA}@3.0.2: the lockfile holds it at 3.0.2 and 3.0.3, and package.json pins 3.0.3`,
      `${DATA}@3.0.3: the lockfile holds it at 3.0.2 and 3.0.3, and package.json pins 3.0.3`,
    ]);
    assert.deepEqual(registry.requests, []);
  });

  test('a version other than the pin fails without a lookup', async () => {
    const registry = fakeRegistry({});
    const { failures } = await check({ [spec(MCP, '0.5.0')]: entry(integrityOf('mcp')) }, { registry });
    assert.deepEqual(failures, [`${MCP}@0.5.0: package.json pins 0.6.0, not 0.5.0`]);
    assert.deepEqual(registry.requests, []);
  });

  test('a package that package.json does not pin fails without a lookup', async () => {
    const registry = fakeRegistry({});
    const { failures } = await check(
      { [spec(MCP, '0.6.0')]: entry(integrityOf('mcp')) },
      { registry, pins: { [DATA]: '3.0.3' } },
    );
    assert.deepEqual(failures, [`${MCP}@0.6.0: package.json pins no such dependency`]);
    assert.deepEqual(registry.requests, []);
  });

  test('no provenance attestation with a bundle fails before any download', async () => {
    const registry = fakeRegistry({
      [attestationsUrl(MCP, '0.6.0')]: { attestations: [PUBLISH_ATTESTATION] },
      [attestationsUrl(DATA, '3.0.3')]: { attestations: [PUBLISH_ATTESTATION, { predicateType: PROVENANCE }] },
    });
    const downloads = fakeDownloads({});
    const { failures } = await check(
      { [spec(MCP, '0.6.0')]: entry(integrityOf('mcp')), [spec(DATA, '3.0.3')]: entry(integrityOf('data')) },
      { registry, downloads },
    );
    assert.deepEqual(failures, [
      `${MCP}@0.6.0: the registry holds no ${PROVENANCE} attestation`,
      `${DATA}@3.0.3: the provenance attestation carries no bundle`,
    ]);
    assert.deepEqual(downloads.calls, []);
  });

  test('two provenance attestations fail, because one bundle is what gh verifies', async () => {
    const twice = provenanceAttestation(MCP, '0.6.0');
    const registry = fakeRegistry({ [attestationsUrl(MCP, '0.6.0')]: { attestations: [twice, twice] } });
    const downloads = fakeDownloads({});
    const { failures } = await check({ [spec(MCP, '0.6.0')]: entry(integrityOf('mcp')) }, { registry, downloads });
    assert.deepEqual(failures, [`${MCP}@0.6.0: the registry holds 2 ${PROVENANCE} attestations, not one`]);
    assert.deepEqual(downloads.calls, []);
  });

  test('a tarball whose integrity is not the lockfile entry fails before gh runs', async () => {
    const mcp = goodFirstParty(MCP, '0.6.0', MCP_WORKFLOW);
    const registry = fakeRegistry(mcp.registry);
    const downloads = fakeDownloads({ [tarballUrl(MCP, '0.6.0')]: 'another tarball' });
    const gh = fakeGh(mcp.gh);
    const { failures } = await check({ [spec(MCP, '0.6.0')]: mcp.entry }, { registry, downloads, gh });
    assert.deepEqual(failures, [
      `${MCP}@0.6.0: the registry tarball has integrity ${integrityOf('another tarball')}, ` +
        `not the lockfile's ${integrityOf('tarball of @tibia.sh/tibiawiki-mcp@0.6.0')}`,
    ]);
    assert.deepEqual(gh.calls, []);
  });

  test('a download that fails fails the entry', async () => {
    const mcp = goodFirstParty(MCP, '0.6.0', MCP_WORKFLOW);
    const registry = fakeRegistry(mcp.registry);
    const downloads = fakeDownloads({ [tarballUrl(MCP, '0.6.0')]: new Error('HTTP 503') });
    const gh = fakeGh(mcp.gh);
    const { failures } = await check({ [spec(MCP, '0.6.0')]: mcp.entry }, { registry, downloads, gh });
    assert.deepEqual(failures, [`${MCP}@0.6.0: cannot download ${tarballUrl(MCP, '0.6.0')}: HTTP 503`]);
    assert.deepEqual(gh.calls, []);
  });

  test("gh's rejection fails the entry with its reason", async () => {
    const mcp = goodFirstParty(MCP, '0.6.0', MCP_WORKFLOW);
    const data = goodFirstParty(DATA, '3.0.3', DATA_WORKFLOW);
    const registry = fakeRegistry({ ...mcp.registry, ...data.registry });
    const downloads = fakeDownloads({ ...mcp.downloads, ...data.downloads });
    const reason = 'Error: expected SourceRepositoryRef to be refs/heads/main, got refs/heads/dev';
    const gh = fakeGh({ [MCP_WORKFLOW]: reason, [DATA_WORKFLOW]: undefined });
    const packages = { [spec(MCP, '0.6.0')]: mcp.entry, [spec(DATA, '3.0.3')]: data.entry };
    const verdict = await check(packages, { registry, downloads, gh });
    assert.deepEqual(verdict, {
      failures: [`${MCP}@0.6.0: gh attestation verify: ${reason}`],
      verified: [spec(DATA, '3.0.3')],
    });
  });

  test('a gh that cannot run rejects the whole check, once every lookup in flight has settled', async () => {
    const mcp = goodFirstParty(MCP, '0.6.0', MCP_WORKFLOW);
    const data = goodFirstParty(DATA, '3.0.3', DATA_WORKFLOW);
    const registry = fakeRegistry({ ...mcp.registry, ...data.registry });
    // The data tarball arrives only when the test lets it, after gh has failed to start for the mcp one.
    const dataTarball = Promise.withResolvers<string>();
    const downloads = fakeDownloads({ ...mcp.downloads, [tarballUrl(DATA, '3.0.3')]: dataTarball.promise });
    const gh = fakeGh({ [MCP_WORKFLOW]: new Error('gh cannot start: ENOENT'), [DATA_WORKFLOW]: undefined });
    const events: string[] = [];
    const download: Download = async (url, file) => {
      const integrity = await downloads.download(url, file);
      events.push(`downloaded ${url}`);
      return integrity;
    };
    const verify: Verify = (input) => {
      events.push(`verify ${input.workflow}`);
      return gh.verify(input);
    };
    const packages = { [spec(MCP, '0.6.0')]: mcp.entry, [spec(DATA, '3.0.3')]: data.entry };
    const pending = checkLockfile(lock(packages), { ...depsOf({ registry }), download, verify }, NOW).catch(
      (error: unknown) => {
        events.push('rejected');
        throw error;
      },
    );
    pending.catch(() => undefined);
    while (!gh.calls.some((call) => call.workflow === MCP_WORKFLOW)) await setImmediate();
    await setImmediate();
    assert.deepEqual(events, [`downloaded ${tarballUrl(MCP, '0.6.0')}`, `verify ${MCP_WORKFLOW}`]);
    dataTarball.resolve(`tarball of ${DATA}@3.0.3`);
    await assert.rejects(pending, { message: 'gh cannot start: ENOENT' });
    assert.deepEqual(events, [
      `downloaded ${tarballUrl(MCP, '0.6.0')}`,
      `verify ${MCP_WORKFLOW}`,
      `downloaded ${tarballUrl(DATA, '3.0.3')}`,
      `verify ${DATA_WORKFLOW}`,
      'rejected',
    ]);
    assert.deepEqual(
      gh.calls.map(({ workflow, tarballBody, bundleJson }) => ({ workflow, tarballBody, bundleJson })),
      [
        {
          workflow: MCP_WORKFLOW,
          tarballBody: `tarball of ${MCP}@0.6.0`,
          bundleJson: provenanceAttestation(MCP, '0.6.0').bundle,
        },
        {
          workflow: DATA_WORKFLOW,
          tarballBody: `tarball of ${DATA}@3.0.3`,
          bundleJson: provenanceAttestation(DATA, '3.0.3').bundle,
        },
      ],
    );
  });
});

describe('fetching', () => {
  test('a failed fetch fails that entry only', async () => {
    const registry = fakeRegistry({
      [packumentUrl('left-pad')]: new Error('socket hang up'),
      [packumentUrl('is-odd')]: packument('is-odd', { '3.0.1': MONTH_AGO }),
    });
    const { failures } = await check(
      { 'left-pad@1.3.0': entry(integrityOf('left-pad')), 'is-odd@3.0.1': entry(integrityOf('is-odd')) },
      { registry },
    );
    assert.deepEqual(failed(failures), ['left-pad@1.3.0']);
    assert.match(failures[0] ?? '', /socket hang up/);
  });

  test('two versions of a package are judged by one fetch of its packument', async () => {
    const registry = fakeRegistry({
      [packumentUrl('is-odd')]: packument('is-odd', { '3.0.0': MONTH_AGO, '3.0.1': NOW }),
    });
    const { failures } = await check(
      { 'is-odd@3.0.0': entry(integrityOf('3.0.0')), 'is-odd@3.0.1': entry(integrityOf('3.0.1')) },
      { registry },
    );
    assert.deepEqual(failed(failures), ['is-odd@3.0.1']);
    assert.deepEqual(registry.requests, [packumentUrl('is-odd')]);
  });

  test('at most 8 fetches run at a time', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `package-${index}`);
    const registry = fakeRegistry(
      Object.fromEntries(names.map((name) => [packumentUrl(name), packument(name, { '1.0.0': MONTH_AGO })])),
    );
    const packages = Object.fromEntries(names.map((name) => [spec(name, '1.0.0'), entry(integrityOf(name))]));
    const verdict = await check(packages, { registry });
    assert.deepEqual(verdict, { failures: [], verified: [] });
    assert.equal(registry.requests.length, 20);
    assert.equal(registry.flight.most, 8);
  });
});

describe('the real download', () => {
  test('streams the body to the file and resolves with its sha512 integrity', async () => {
    const body = randomBytes(1 << 20);
    const server = createServer((request, response) => {
      if (request.url === '/ok.tgz') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(body);
      } else {
        response.writeHead(404);
        response.end('not here');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const file = join(scratch, 'ok.tgz');
      assert.equal(await download(`http://127.0.0.1:${port}/ok.tgz`, file), integrityOf(body));
      assert.ok((await readFile(file)).equals(body));
      await assert.rejects(download(`http://127.0.0.1:${port}/missing.tgz`, join(scratch, 'missing.tgz')), /HTTP 404/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('the real gh runner', () => {
  const input = { tarball: '/scratch/pkg.tgz', bundle: '/scratch/pkg.bundle.json', workflow: MCP_WORKFLOW };

  /** A script that runs the given shell lines in place of gh. */
  async function scriptedGh(name: string, lines: string): Promise<string> {
    const gh = join(scratch, `${name}-gh`);
    await writeFile(gh, `#!/bin/sh\n${lines}\n`, { mode: 0o755 });
    return gh;
  }

  test('runs gh attestation verify with the policy on its command line, and a zero exit verifies', async () => {
    const argsFile = join(scratch, 'gh-args');
    const gh = await scriptedGh('zero', `printf '%s\\n' "$@" > '${argsFile}'\nexit 0`);
    assert.equal(await ghVerify(gh)(input), undefined);
    assert.deepEqual((await readFile(argsFile, 'utf8')).trimEnd().split('\n'), [
      'attestation',
      'verify',
      '/scratch/pkg.tgz',
      '--bundle',
      '/scratch/pkg.bundle.json',
      '--digest-alg',
      'sha512',
      '--owner',
      'tibia-sh',
      '--signer-workflow',
      MCP_WORKFLOW,
      '--source-ref',
      'refs/heads/main',
      '--deny-self-hosted-runners',
      '--predicate-type',
      PROVENANCE,
    ]);
  });

  test('a non-zero exit returns the last non-empty line of stderr, or the exit code', async () => {
    const talkative = await scriptedGh(
      'one',
      `printf 'to stdout\\n'\nprintf '\\nError: verifying with issuer "sigstore.dev"\\n\\n' >&2\nexit 1`,
    );
    assert.equal(await ghVerify(talkative)(input), 'Error: verifying with issuer "sigstore.dev"');
    const silent = await scriptedGh('two', 'exit 2');
    assert.equal(await ghVerify(silent)(input), 'gh exited 2');
  });

  test('a gh that cannot start rejects', async () => {
    await assert.rejects(ghVerify(join(scratch, 'no-such-gh'))(input), { message: 'gh cannot start: ENOENT' });
  });

  test('a gh that gives no verdict in time is killed, and is gone when the verdict resolves', async () => {
    // The fake records its pid, ignores SIGTERM, and keeps that disposition through exec, so only a kill ends it.
    // With no arguments it exits at once: macOS scans a new executable on its first run, which can take 200 ms,
    // so the test runs it once before the timed run.
    const pidFile = join(scratch, 'sleeper-pid');
    const sleeper = await scriptedGh(
      'sleeper',
      `[ $# -eq 0 ] && exit 0\ntrap '' TERM\necho $$ > '${pidFile}'\nexec sleep 30`,
    );
    assert.equal(spawnSync(sleeper, { stdio: 'ignore' }).status, 0);
    assert.equal(await ghVerify(sleeper, 200)(input), 'no verdict from gh within 0.2 s');
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(pid > 0, 'the fake gh recorded its pid');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
});
