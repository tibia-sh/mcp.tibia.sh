/**
 * The bump script's rules against a fake registry, a fake clock and a fake command runner, and its CLI against
 * fake git, gh and pnpm scripts on PATH.
 *
 * The fixtures copy the shapes the npm registry and gh 2.100.0 produced on 2026-09-16: a packument's `versions` and
 * `time` maps, the attestations response, what `gh pr list --json number,isCrossRepository` and
 * `gh pr view --json state,autoMergeRequest` print. The fake registry rejects every URL it was not given, and the
 * fake runner records every command, so a rule that reads the wrong document or runs the wrong command fails its
 * test. The commands publish runs are what the token authorizes, so their tests compare the whole recorded list.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { compareWithPin, parseRequest, pin, publish, run, waitForNpm } from '../scripts/bump.ts';
import type { Outcome, Run } from '../scripts/bump.ts';
import { FIRST_PARTY, FIRST_PARTY_SCOPE } from '../scripts/first-party.ts';

const PROVENANCE = 'https://slsa.dev/provenance/v1';
const PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';

const MCP = '@tibia.sh/tibiawiki-mcp';
const DATA = '@tibia.sh/tibiawiki-data';

const SECOND_MS = 1000;

/** A package.json pinning the given versions, as pin reads it. */
function packageJson(pins: Record<string, string>): unknown {
  return { name: 'mcp.tibia.sh', dependencies: pins, devDependencies: { typescript: '7.0.2' } };
}

/** The packument URL of name, with the scope's slash escaped as the registry's own URLs escape it. */
function packumentUrl(name: string): string {
  return `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
}

/** The attestations URL of name@version. */
function attestationsUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace('/', '%2F')}@${version}`;
}

/** The tarball URL the registry lists for name@version under `dist`: the scope in the path, not in the file name. */
function tarballUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;
}

/** A packument listing the given versions, each with its tarball, and a publish time unless timed is false. */
function packument(name: string, versions: string[], timed = true): unknown {
  return {
    name,
    'dist-tags': { latest: versions.at(-1) },
    versions: Object.fromEntries(
      versions.map((version) => [version, { name, version, dist: { tarball: tarballUrl(name, version) } }]),
    ),
    time: {
      created: '2020-01-01T00:00:00.000Z',
      ...(timed ? Object.fromEntries(versions.map((version) => [version, '2026-09-15T10:00:00.000Z'])) : {}),
    },
  };
}

/** An attestations response holding npm's publish attestation, and the provenance unless provenance is false. */
function attestations(provenance = true): unknown {
  const bundle = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', dsseEnvelope: {} };
  return {
    attestations: [
      { predicateType: PUBLISH, bundle },
      ...(provenance ? [{ predicateType: PROVENANCE, bundle }] : []),
    ],
  };
}

/**
 * A fake registry whose fetchJson and fetchStatus answer each URL from its queue, in order, the last one repeating,
 * an Error being a failed fetch: a body for fetchJson, an HTTP status for fetchStatus. Both reject every other URL,
 * answer on a later turn of the event loop, and record the URLs in one list.
 */
function fakeRegistry(queues: Record<string, unknown[]>) {
  const requests: string[] = [];
  const remaining = structuredClone(queues);
  const answer = async (url: string): Promise<unknown> => {
    requests.push(url);
    await setImmediate();
    const queue = remaining[url];
    if (queue === undefined || queue.length === 0) throw new Error(`the fake registry has no ${url}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return structuredClone(next);
  };
  const fetchStatus = async (url: string): Promise<number> => {
    const status = await answer(url);
    if (typeof status !== 'number') throw new Error(`the fake registry answers ${url} with a body, not a status`);
    return status;
  };
  return { fetchJson: answer, fetchStatus, requests };
}

/** A fake clock that only moves when something sleeps on it, or a fake advances it, and records each sleep. */
function fakeClock(start = Date.parse('2026-09-15T12:00:00.000Z')) {
  let time = start;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      await setImmediate();
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
    sleeps,
  };
}

type Call = { command: string; args: string[]; timeoutMs: number | undefined };

/** A recorded call as one list, the way the tests spell the expected commands. */
function line(call: Call): string[] {
  return [call.command, ...call.args];
}

/**
 * A fake Run that records each call and answers it with what respond returns for it, on a later turn of the event
 * loop. A field respond leaves out is exit 0 with no output.
 */
function fakeRun(respond: (call: Call) => Partial<Outcome> | undefined = () => undefined) {
  const calls: Call[] = [];
  const run: Run = async (command, args, timeoutMs) => {
    const call = { command, args, timeoutMs };
    calls.push(call);
    await setImmediate();
    return { status: 0, stdout: '', stderr: '', ...respond(call) };
  };
  return { run, calls, lines: () => calls.map(line), bounds: () => calls.map((call) => call.timeoutMs) };
}

/** Whether a call is the given command with the given leading arguments. */
function starts(call: Call, ...expected: string[]): boolean {
  return expected.every((word, index) => line(call)[index] === word);
}

/** The text as a RegExp source matching it literally. */
function literal(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

describe('parseRequest', () => {
  test('a first-party package and an exact version give the branch, the title and the body', () => {
    assert.deepEqual(parseRequest(MCP, '0.6.1'), {
      name: MCP,
      version: '0.6.1',
      branch: 'bump/tibiawiki-mcp-0.6.1',
      title: 'chore(deps): bump @tibia.sh/tibiawiki-mcp to 0.6.1',
      body:
        '`@tibia.sh/tibiawiki-mcp` 0.6.1 is on npm. This pins it and refreshes the lockfile. The pull request ' +
        'merges itself once the required checks pass, and the merge deploys it.\n\nOpened by `bump.yml`.',
    });
    assert.deepEqual(parseRequest(DATA, '10.20.30'), {
      name: DATA,
      version: '10.20.30',
      branch: 'bump/tibiawiki-data-10.20.30',
      title: 'chore(deps): bump @tibia.sh/tibiawiki-data to 10.20.30',
      body:
        '`@tibia.sh/tibiawiki-data` 10.20.30 is on npm. This pins it and refreshes the lockfile. The pull request ' +
        'merges itself once the required checks pass, and the merge deploys it.\n\nOpened by `bump.yml`.',
    });
  });

  test('every first-party package is under the scope the branch name strips', () => {
    for (const name of FIRST_PARTY.keys()) assert.ok(name.startsWith(FIRST_PARTY_SCOPE), name);
  });

  test('a package outside FIRST_PARTY is refused, naming the allowlist', () => {
    const allowlist = new RegExp(`${MCP}.*${DATA}`);
    for (const pkg of ['@tibia.sh/other', 'left-pad', '@tibia.sh/tibiawiki-mcp/', 'tibiawiki-mcp', '']) {
      assert.throws(() => parseRequest(pkg, '1.0.0'), allowlist, pkg);
    }
  });

  test('a version that is not an exact 1.2.3 is refused, naming the pattern', () => {
    const pattern = /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/;
    for (const version of ['v0.6.0', '0.6', '0.6.0-rc.1', '0.6.0+build', ' 0.6.0', '0.6.0\n', 'latest', '']) {
      assert.throws(() => parseRequest(MCP, version), pattern, JSON.stringify(version));
    }
  });

  test('the package is checked before the version', () => {
    assert.throws(() => parseRequest('@tibia.sh/other', 'v1'), /other/);
  });
});

describe('compareWithPin', () => {
  test('the pinned version is equal, a higher one newer, a lower one older, by number and not by text', () => {
    const pins = packageJson({ [MCP]: '0.9.0', [DATA]: '3.0.3' });
    assert.equal(compareWithPin(parseRequest(MCP, '0.9.0'), pins), 'equal');
    assert.equal(compareWithPin(parseRequest(MCP, '0.10.0'), pins), 'newer');
    assert.equal(compareWithPin(parseRequest(MCP, '0.9.1'), pins), 'newer');
    assert.equal(compareWithPin(parseRequest(MCP, '1.0.0'), pins), 'newer');
    assert.equal(compareWithPin(parseRequest(MCP, '0.8.99'), pins), 'older');
    assert.equal(compareWithPin(parseRequest(DATA, '3.0.3'), pins), 'equal');
    assert.equal(compareWithPin(parseRequest(DATA, '2.99.99'), pins), 'older');
    assert.equal(compareWithPin(parseRequest(DATA, '10.0.0'), pins), 'newer');
  });

  test('the numbers are compared exactly at any size', () => {
    const pins = packageJson({ [MCP]: '9007199254740992.0.0' });
    assert.equal(compareWithPin(parseRequest(MCP, '9007199254740993.0.0'), pins), 'newer');
    assert.equal(compareWithPin(parseRequest(MCP, '9007199254740992.0.0'), pins), 'equal');
    assert.equal(compareWithPin(parseRequest(MCP, '9007199254740991.99999999999999999.0'), pins), 'older');
  });

  test('a package.json that does not pin the package is rejected', () => {
    assert.throws(() => compareWithPin(parseRequest(DATA, '3.0.3'), packageJson({ [MCP]: '0.6.0' })), /no such/);
    assert.throws(() => compareWithPin(parseRequest(MCP, '0.6.0'), { dependencies: [] }), /no such/);
    assert.throws(() => compareWithPin(parseRequest(MCP, '0.6.0'), null), /no such/);
  });

  test('a pin that is not an exact version is rejected, naming the pin', () => {
    const range = packageJson({ [MCP]: '^0.6.0' });
    assert.throws(() => compareWithPin(parseRequest(MCP, '0.6.0'), range), /\^0\.6\.0/);
    assert.throws(() => compareWithPin(parseRequest(MCP, '0.6.0'), { dependencies: { [MCP]: 6 } }), /6/);
  });
});

describe('waitForNpm', () => {
  const request = parseRequest(MCP, '0.6.1');
  const PACKUMENT = packumentUrl(MCP);
  const ATTESTATIONS = attestationsUrl(MCP, '0.6.1');
  const TARBALL = tarballUrl(MCP, '0.6.1');
  /** The tries the wait makes at 15 s apart in 15 min, the first at once and the last at the deadline. */
  const TRIES = 61;
  const OLD = packument(MCP, ['0.6.0']);
  const NEW = packument(MCP, ['0.6.0', '0.6.1']);
  const UNTIMED = packument(MCP, ['0.6.0', '0.6.1'], false);

  /** Runs the wait against a registry answering from queues, on a fake clock. */
  function wait(queues: Record<string, unknown[]>) {
    const registry = fakeRegistry(queues);
    const clock = fakeClock();
    const deps = { fetchJson: registry.fetchJson, fetchStatus: registry.fetchStatus, ...clock };
    return { done: waitForNpm(request, deps), registry, clock };
  }

  test('resolves at once when npm lists the version, holds its provenance and serves its tarball', async () => {
    const { done, registry, clock } = wait({ [PACKUMENT]: [NEW], [ATTESTATIONS]: [attestations()], [TARBALL]: [200] });
    await done;
    assert.deepEqual(registry.requests, [PACKUMENT, ATTESTATIONS, TARBALL]);
    assert.deepEqual(clock.sleeps, []);
  });

  test('polls the packument every 15 s until the version and its time are there, then the attestations', async () => {
    const { done, registry, clock } = wait({
      [PACKUMENT]: [OLD, UNTIMED, NEW],
      [ATTESTATIONS]: [attestations(false), attestations()],
      [TARBALL]: [200],
    });
    await done;
    assert.deepEqual(registry.requests, [PACKUMENT, PACKUMENT, PACKUMENT, ATTESTATIONS, ATTESTATIONS, TARBALL]);
    assert.deepEqual(clock.sleeps, [15 * SECOND_MS, 15 * SECOND_MS, 15 * SECOND_MS]);
  });

  test('then polls the tarball the packument lists every 15 s until it answers 200, reading nothing else', async () => {
    // npm lists a fresh version before its CDN serves the tarball, which answered 404 for five minutes on 0.8.0.
    const { done, registry, clock } = wait({
      [PACKUMENT]: [NEW],
      [ATTESTATIONS]: [attestations()],
      [TARBALL]: [404, new Error('no answer within 10 s'), 404, 200],
    });
    await done;
    assert.deepEqual(registry.requests, [PACKUMENT, ATTESTATIONS, TARBALL, TARBALL, TARBALL, TARBALL]);
    assert.deepEqual(clock.sleeps, [15 * SECOND_MS, 15 * SECOND_MS, 15 * SECOND_MS]);
  });

  test('a packument without a registry tarball for the version is not there yet', async () => {
    const bare = { ...(NEW as object), versions: { '0.6.1': { name: MCP, version: '0.6.1' } } };
    const elsewhere = structuredClone(NEW) as { versions: Record<string, { dist: { tarball: string } }> };
    const moved = { ...elsewhere, versions: { '0.6.1': { dist: { tarball: 'https://example.com/x-0.6.1.tgz' } } } };
    const { done, registry } = wait({
      [PACKUMENT]: [bare, moved, NEW],
      [ATTESTATIONS]: [attestations()],
      [TARBALL]: [200],
    });
    await done;
    assert.deepEqual(registry.requests, [PACKUMENT, PACKUMENT, PACKUMENT, ATTESTATIONS, TARBALL]);
    const never = wait({ [PACKUMENT]: [moved] });
    await assert.rejects(never.done, {
      message: /: the packument names no https:\/\/registry\.npmjs\.org\/ tarball for 0\.6\.1$/,
    });
  });

  test('a fetch that fails, or an answer of another shape, is not there yet, and never an error', async () => {
    const { done, registry, clock } = wait({
      [PACKUMENT]: [new Error('no complete answer within 10 s'), 'not json', null, { versions: '0.6.1' }, NEW],
      [ATTESTATIONS]: [new Error('HTTP 503'), { attestations: {} }, { attestations: [{ bundle: {} }] }, attestations()],
      [TARBALL]: [200],
    });
    await done;
    assert.equal(registry.requests.length, 10);
    assert.equal(clock.sleeps.length, 7);
  });

  test('gives up 15 minutes after the first try, naming what npm still lacks', async () => {
    const { done, registry, clock } = wait({ [PACKUMENT]: [OLD] });
    await assert.rejects(done, {
      message:
        'npm does not serve @tibia.sh/tibiawiki-mcp@0.6.1 with provenance and a downloadable tarball ' +
        '15 minutes after the first try: the packument lists no 0.6.1',
    });
    assert.equal(registry.requests.length, TRIES);
    assert.deepEqual(clock.sleeps, Array(TRIES - 1).fill(15 * SECOND_MS));
  });

  test('the deadline names a missing publish time, provenance or tarball, or a failed fetch', async () => {
    const untimed = wait({ [PACKUMENT]: [UNTIMED] });
    await assert.rejects(untimed.done, { message: /: the packument records no publish time for 0\.6\.1$/ });
    const unattested = wait({ [PACKUMENT]: [NEW], [ATTESTATIONS]: [attestations(false)] });
    await assert.rejects(unattested.done, {
      message: new RegExp(`: the registry holds no ${PROVENANCE} attestation$`),
    });
    assert.equal(unattested.registry.requests.filter((url) => url === PACKUMENT).length, 1);
    assert.equal(unattested.registry.requests.filter((url) => url === ATTESTATIONS).length, TRIES);
    const unreachable = wait({ [PACKUMENT]: [new Error('HTTP 503')] });
    await assert.rejects(unreachable.done, {
      message: new RegExp(`: cannot read ${PACKUMENT.replace(/[.]/g, '\\.')}: HTTP 503$`),
    });
    const undownloadable = wait({ [PACKUMENT]: [NEW], [ATTESTATIONS]: [attestations()], [TARBALL]: [404] });
    await assert.rejects(undownloadable.done, {
      message: new RegExp(`: the tarball ${literal(TARBALL)} answers HTTP 404$`),
    });
    assert.equal(undownloadable.registry.requests.filter((url) => url === ATTESTATIONS).length, 1);
    assert.equal(undownloadable.registry.requests.filter((url) => url === TARBALL).length, TRIES);
    const silent = wait({
      [PACKUMENT]: [NEW],
      [ATTESTATIONS]: [attestations()],
      [TARBALL]: [new Error('no answer within 10 s')],
    });
    await assert.rejects(silent.done, {
      message: new RegExp(`: cannot read ${literal(TARBALL)}: no answer within 10 s$`),
    });
  });

  test('a try at the deadline is still made, and the one after it is not', async () => {
    // The version appears on the try 15 minutes after the first, and the tarball one try later.
    const appearing = [...Array<unknown>(TRIES - 1).fill(OLD), NEW];
    const ready = wait({ [PACKUMENT]: appearing, [ATTESTATIONS]: [attestations()], [TARBALL]: [200] });
    await ready.done;
    assert.equal(ready.clock.sleeps.length, TRIES - 1);
    const late = wait({ [PACKUMENT]: appearing, [ATTESTATIONS]: [attestations()], [TARBALL]: [404, 200] });
    await assert.rejects(late.done, { message: /tarball 15 minutes/ });
    assert.equal(late.registry.requests.filter((url) => url === TARBALL).length, 1);
  });

  test('no try starts after the deadline, even when each try takes time', async () => {
    // Each fetch takes 14 s, so tries start 29 s apart: the 32nd at 899 s ends at 913 s, and the next would start
    // at 928 s. The version appearing on that 32nd try resolves, and appearing one try later does not.
    function slow(queues: Record<string, unknown[]>) {
      const registry = fakeRegistry(queues);
      const clock = fakeClock();
      const fetchJson = async (url: string) => {
        clock.advance(14 * SECOND_MS);
        return registry.fetchJson(url);
      };
      const fetchStatus = async (url: string) => {
        clock.advance(14 * SECOND_MS);
        return registry.fetchStatus(url);
      };
      return { done: waitForNpm(request, { fetchJson, fetchStatus, ...clock }), registry, clock };
    }
    const served = { [ATTESTATIONS]: [attestations()], [TARBALL]: [200] };
    const appearing = [...Array<unknown>(31).fill(OLD), NEW];
    const ready = slow({ [PACKUMENT]: appearing, ...served });
    await ready.done;
    assert.equal(ready.registry.requests.length, 34);
    assert.equal(ready.clock.sleeps.length, 31);
    const late = slow({ [PACKUMENT]: [...Array<unknown>(32).fill(OLD), NEW], ...served });
    await assert.rejects(late.done, { message: /: the packument lists no 0\.6\.1$/ });
    assert.equal(late.registry.requests.length, 32);
    assert.equal(late.clock.sleeps.length, 31);
    assert.equal(late.clock.now() - Date.parse('2026-09-15T12:00:00.000Z'), 913 * SECOND_MS);
  });
});

describe('pin', () => {
  const PINS = { [MCP]: '0.6.0', [DATA]: '3.0.3' };
  const ADD = ['pnpm', 'add', '--save-exact', `${MCP}@0.6.1`];
  const CHECK = ['node', 'scripts/check-lockfile.ts'];
  /** A registry serving MCP 0.6.1 with provenance and its tarball. */
  const SERVING = {
    [packumentUrl(MCP)]: [packument(MCP, ['0.6.0', '0.6.1'])],
    [attestationsUrl(MCP, '0.6.1')]: [attestations()],
    [tarballUrl(MCP, '0.6.1')]: [200],
  };

  type Fakes = {
    pins?: Record<string, string>;
    registry?: Record<string, unknown[]>;
    run?: ReturnType<typeof fakeRun>;
  };

  /** Runs pin for MCP at version with a package.json of the given pins, a registry, and a runner, or defaults. */
  function pinning(version: string, fakes: Fakes = {}) {
    const registry = fakeRegistry(fakes.registry ?? SERVING);
    const runner = fakes.run ?? fakeRun();
    const clock = fakeClock();
    const readPackageJson = () => packageJson(fakes.pins ?? PINS);
    const deps = {
      readPackageJson,
      fetchJson: registry.fetchJson,
      fetchStatus: registry.fetchStatus,
      run: runner.run,
      ...clock,
    };
    return { outcome: pin(parseRequest(MCP, version), deps), registry, run: runner, clock };
  }

  test('the pinned version is already-pinned, and touches neither npm nor pnpm', async () => {
    const { outcome, registry, run: runner, clock } = pinning('0.6.0');
    assert.equal(await outcome, 'already-pinned');
    assert.deepEqual(registry.requests, []);
    assert.deepEqual(runner.calls, []);
    assert.deepEqual(clock.sleeps, []);
  });

  test('a lower version is refused, naming the pin, and touches neither npm nor pnpm', async () => {
    const { outcome, registry, run: runner } = pinning('0.5.9');
    await assert.rejects(outcome, { message: 'refuses to move @tibia.sh/tibiawiki-mcp from 0.6.0 down to 0.5.9' });
    assert.deepEqual(registry.requests, []);
    assert.deepEqual(runner.calls, []);
  });

  test('a package.json without the pin is rejected before anything runs', async () => {
    const { outcome, registry, run: runner } = pinning('0.6.1', { pins: { [DATA]: '3.0.3' } });
    await assert.rejects(outcome, { message: /no such dependency/ });
    assert.deepEqual(registry.requests, []);
    assert.deepEqual(runner.calls, []);
  });

  test('a newer version waits for npm, then runs pnpm add and the lockfile check, and is pinned', async () => {
    const registry = {
      [packumentUrl(MCP)]: [packument(MCP, ['0.6.0']), packument(MCP, ['0.6.0', '0.6.1'])],
      [attestationsUrl(MCP, '0.6.1')]: [attestations()],
      [tarballUrl(MCP, '0.6.1')]: [200],
    };
    const { outcome, run: runner, clock } = pinning('0.6.1', { registry });
    assert.equal(await outcome, 'pinned');
    assert.deepEqual(clock.sleeps, [15 * SECOND_MS]);
    assert.deepEqual(runner.lines(), [ADD, CHECK]);
    assert.deepEqual(runner.bounds(), [undefined, undefined], 'pnpm add and the lockfile check are not bounded');
  });

  test('a pnpm add that fails stops the pin with its stderr, before the lockfile check', async () => {
    const stderr = ' ERR_PNPM_NO_MATCHING_VERSION  No matching version found\n';
    const failing = { status: 1, stdout: 'Progress: resolved 1', stderr };
    const runner = fakeRun((call) => (starts(call, 'pnpm') ? failing : undefined));
    await assert.rejects(pinning('0.6.1', { run: runner }).outcome, {
      message: `pnpm add --save-exact ${MCP}@0.6.1 exited 1: ERR_PNPM_NO_MATCHING_VERSION  No matching version found`,
    });
    assert.deepEqual(runner.lines(), [ADD]);
  });

  test('a lockfile check that fails stops the pin with its stderr', async () => {
    const stderr = `${MCP}@0.6.1: gh attestation verify: Error: verifying with issuer "sigstore.dev"\n`;
    const runner = fakeRun((call) => (starts(call, 'node') ? { status: 1, stderr } : undefined));
    await assert.rejects(pinning('0.6.1', { run: runner }).outcome, {
      message: `node scripts/check-lockfile.ts exited 1: ${stderr.trim()}`,
    });
    assert.deepEqual(runner.lines(), [ADD, CHECK]);
  });

  test('a command killed by a signal, or one that fails without a word, still fails the pin', async () => {
    const killed = fakeRun((call) => (starts(call, 'pnpm') ? { status: null } : undefined));
    await assert.rejects(pinning('0.6.1', { run: killed }).outcome, {
      message: `pnpm add --save-exact ${MCP}@0.6.1 was killed by a signal`,
    });
    const silent = fakeRun((call) => (starts(call, 'node') ? { status: 2 } : undefined));
    await assert.rejects(pinning('0.6.1', { run: silent }).outcome, {
      message: 'node scripts/check-lockfile.ts exited 2',
    });
  });

  test('npm not serving the version in time fails the pin before pnpm runs', async () => {
    const registry = { [packumentUrl(MCP)]: [packument(MCP, ['0.6.0'])] };
    const { outcome, run: runner } = pinning('0.6.1', { registry });
    await assert.rejects(outcome, { message: /npm does not serve/ });
    assert.deepEqual(runner.calls, []);
  });

  test('a tarball npm does not serve yet holds pnpm add back until it answers 200', async () => {
    // pnpm add fetches the tarball the packument lists, and failed with ERR_PNPM_TARBALL_HTTP_STATUS on a 404.
    const registry = { ...SERVING, [tarballUrl(MCP, '0.6.1')]: [404, 404, 200] };
    const { outcome, run: runner, clock } = pinning('0.6.1', { registry });
    assert.equal(await outcome, 'pinned');
    assert.deepEqual(clock.sleeps, [15 * SECOND_MS, 15 * SECOND_MS]);
    assert.deepEqual(runner.lines(), [ADD, CHECK]);
    const missing = pinning('0.6.1', { registry: { ...SERVING, [tarballUrl(MCP, '0.6.1')]: [404] } });
    await assert.rejects(missing.outcome, { message: /: the tarball .* answers HTTP 404$/ });
    assert.deepEqual(missing.run.calls, []);
  });
});

describe('publish', () => {
  const request = parseRequest(MCP, '0.6.1');
  const { branch, title } = request;
  const DIFF = ['git', 'diff', '--quiet', '--', 'package.json', 'pnpm-lock.yaml'];
  const LIST = ['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,isCrossRepository'];
  const VIEW = ['gh', 'pr', 'view', branch, '--json', 'state,autoMergeRequest'];
  const MERGE = ['gh', 'pr', 'merge', '--auto', '--rebase', branch];
  /** What publish runs to open the pull request, in order, once no open one exists. */
  const CREATE = (bodyFile: string) => [
    ['git', 'switch', '-c', branch],
    ['git', 'add', 'package.json', 'pnpm-lock.yaml'],
    [
      'git',
      '-c', 'user.name=github-actions[bot]',
      '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-m', title,
    ],
    ['gh', 'auth', 'setup-git'],
    ['git', 'push', '--force', 'origin', `HEAD:refs/heads/${branch}`],
    ['gh', 'pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile],
  ];
  /** The polls the wait makes at 30 s apart in 30 min. */
  const POLLS = 60;

  /** What gh pr view prints for a pull request in the given state, with auto-merge on or off. */
  function view(state: 'OPEN' | 'CLOSED' | 'MERGED', autoMerge: boolean): string {
    const enabled = { enabledAt: '2026-09-15T12:00:30Z', enabledBy: { login: 'jakubmucha' }, mergeMethod: 'REBASE' };
    const autoMergeRequest = autoMerge ? { commitBody: null, commitHeadline: null, ...enabled } : null;
    return JSON.stringify({ autoMergeRequest, state });
  }
  const OPEN_ON = view('OPEN', true);
  const OPEN_OFF = view('OPEN', false);
  const MERGED = view('MERGED', false);
  const CLOSED = view('CLOSED', false);

  type Fakes = {
    unchanged?: boolean;
    open?: number[];
    forks?: number[];
    views: string[];
    fail?: { call: string[]; stderr: string };
  };

  /**
   * A fake git and gh for publish: git diff finds changes unless unchanged, gh pr list prints the given open pull
   * requests, forks being the ones from another repository, newest first as gh lists them, a higher number being
   * newer, each gh pr view prints the next of views, the last one repeating, gh pr create keeps the body file's
   * content, since publish removes the file, and fail makes the command that starts with call exit 1 with stderr.
   */
  function fakeGitHub(fakes: Fakes) {
    const views = [...fakes.views];
    const created: { bodyFile?: string; body?: string } = {};
    const runner = fakeRun((call) => {
      const { fail, open = [], forks = [] } = fakes;
      if (fail !== undefined && starts(call, ...fail.call)) return { status: 1, stderr: fail.stderr };
      if (starts(call, 'git', 'diff')) return { status: fakes.unchanged ? 0 : 1 };
      if (starts(call, 'gh', 'pr', 'list')) {
        const listed = [
          ...forks.map((number) => ({ isCrossRepository: true, number })),
          ...open.map((number) => ({ isCrossRepository: false, number })),
        ].sort((a, b) => b.number - a.number);
        return { stdout: `${JSON.stringify(listed)}\n` };
      }
      if (starts(call, 'gh', 'pr', 'view')) return { stdout: `${views.length > 1 ? views.shift() : views[0]}\n` };
      if (starts(call, 'gh', 'pr', 'create')) {
        created.bodyFile = call.args[call.args.indexOf('--body-file') + 1];
        created.body = readFileSync(created.bodyFile as string, 'utf8');
        return { stdout: 'https://github.com/tibia-sh/mcp.tibia.sh/pull/11\n' };
      }
      return undefined;
    });
    return { ...runner, created };
  }

  /** Runs publish with the fakes, and a fake clock. */
  function publishing(fakes: Fakes) {
    const github = fakeGitHub(fakes);
    const clock = fakeClock();
    return { outcome: publish(request, { run: github.run, ...clock }), github, clock };
  }

  test('unchanged pins are nothing-to-publish, and nothing else runs', async () => {
    const { outcome, github, clock } = publishing({ unchanged: true, views: [] });
    assert.equal(await outcome, 'nothing-to-publish');
    assert.deepEqual(github.lines(), [DIFF]);
    assert.deepEqual(clock.sleeps, []);
  });

  test('creates the branch, the commit and the pull request, turns auto-merge on, and waits to merge', async () => {
    const { outcome, github, clock } = publishing({ views: [OPEN_OFF, OPEN_ON, MERGED] });
    assert.equal(await outcome, 'merged');
    const { bodyFile, body } = github.created;
    assert.ok(bodyFile !== undefined && bodyFile.startsWith(tmpdir()), `the body file ${bodyFile} is under tmpdir`);
    assert.equal(body, request.body);
    assert.equal(existsSync(bodyFile), false, 'the body file is removed');
    assert.deepEqual(github.lines(), [DIFF, LIST, ...CREATE(bodyFile), VIEW, MERGE, VIEW, VIEW]);
    assert.deepEqual(clock.sleeps, [30 * SECOND_MS, 30 * SECOND_MS]);
    assert.deepEqual(github.bounds(), Array(12).fill(120 * SECOND_MS), 'every git and gh command is bounded');
  });

  test('a pull request found merged before the wait is merged, without enabling auto-merge or waiting', async () => {
    const { outcome, github, clock } = publishing({ open: [11], views: [MERGED] });
    assert.equal(await outcome, 'merged');
    assert.deepEqual(github.lines(), [DIFF, LIST, VIEW]);
    assert.deepEqual(clock.sleeps, []);
  });

  test('a pull request found closed before the wait fails the same way', async () => {
    const { outcome, github } = publishing({ open: [11], views: [CLOSED] });
    await assert.rejects(outcome, { message: `the pull request from ${branch} was closed without merging` });
    assert.deepEqual(github.lines(), [DIFF, LIST, VIEW]);
  });

  test('reuses the open pull request, and leaves auto-merge alone when it is on', async () => {
    const { outcome, github } = publishing({ open: [11], views: [OPEN_ON, MERGED] });
    assert.equal(await outcome, 'merged');
    assert.deepEqual(github.lines(), [DIFF, LIST, VIEW, VIEW]);
    assert.equal(github.created.body, undefined);
  });

  test('reuses the open pull request, and turns auto-merge on when it is off', async () => {
    const { outcome, github } = publishing({ open: [11], views: [OPEN_OFF, MERGED] });
    assert.equal(await outcome, 'merged');
    assert.deepEqual(github.lines(), [DIFF, LIST, VIEW, MERGE, VIEW]);
  });

  test("a fork's open pull request from the branch does not count, and publish opens its own", async () => {
    const { outcome, github } = publishing({ forks: [7], views: [OPEN_OFF, MERGED] });
    assert.equal(await outcome, 'merged');
    const { bodyFile, body } = github.created;
    assert.equal(body, request.body);
    assert.deepEqual(github.lines(), [DIFF, LIST, ...CREATE(bodyFile as string), VIEW, MERGE, VIEW]);
  });

  test("reuses the open pull request from this repository, with a fork's listed before or after it", async () => {
    for (const forks of [[12], [7]]) {
      const { outcome, github } = publishing({ open: [11], forks, views: [OPEN_ON, MERGED] });
      assert.equal(await outcome, 'merged');
      assert.deepEqual(github.lines(), [DIFF, LIST, VIEW, VIEW]);
      assert.equal(github.created.body, undefined);
    }
  });

  test('a pull request found closed fails the wait, naming it', async () => {
    const { outcome, github, clock } = publishing({ open: [11], views: [OPEN_ON, OPEN_ON, CLOSED] });
    await assert.rejects(outcome, { message: `the pull request from ${branch} was closed without merging` });
    assert.deepEqual(github.lines(), [DIFF, LIST, VIEW, VIEW, VIEW]);
    assert.deepEqual(clock.sleeps, [30 * SECOND_MS, 30 * SECOND_MS]);
  });

  test('auto-merge found off during the wait is turned on once more, and fails the wait the second time', async () => {
    const reused = publishing({ open: [11], views: [OPEN_ON, OPEN_OFF, OPEN_ON, OPEN_OFF, OPEN_ON] });
    await assert.rejects(reused.outcome, {
      message: `auto-merge on the pull request from ${branch} was found off a second time`,
    });
    assert.deepEqual(reused.github.lines(), [DIFF, LIST, VIEW, VIEW, MERGE, VIEW, VIEW]);
    // Turning it on before the wait does not count: the wait still turns it on once more.
    const created = publishing({ views: [OPEN_OFF, OPEN_OFF, OPEN_OFF] });
    await assert.rejects(created.outcome, { message: /found off a second time/ });
    const opened = CREATE(created.github.created.bodyFile as string);
    assert.deepEqual(created.github.lines(), [DIFF, LIST, ...opened, VIEW, MERGE, VIEW, MERGE, VIEW]);
  });

  test('the wait ends 30 minutes after it began, naming the pull request', async () => {
    const { outcome, github, clock } = publishing({ open: [11], views: [OPEN_ON] });
    await assert.rejects(outcome, {
      message: `the pull request from ${branch} has not merged 30 minutes after the wait began`,
    });
    assert.deepEqual(github.lines(), [DIFF, LIST, ...Array<string[]>(POLLS + 1).fill(VIEW)]);
    assert.deepEqual(clock.sleeps, Array(POLLS).fill(30 * SECOND_MS));
  });

  test('a merge found at the last poll still resolves merged', async () => {
    const { outcome, clock } = publishing({ open: [11], views: [...Array<string>(POLLS).fill(OPEN_ON), MERGED] });
    assert.equal(await outcome, 'merged');
    assert.equal(clock.sleeps.length, POLLS);
  });

  test('no poll starts after the deadline, even when each poll takes time', async () => {
    // Each view takes 17 s, the one before the wait included, so the wait begins at 17 s and polls start 47 s
    // apart: the 38th at 1786 s ends at 1803 s, and the next would start at 1833 s, past the deadline at 1817 s.
    // A merge on that 38th poll resolves, and one poll later does not.
    function slow(views: string[]) {
      const github = fakeGitHub({ open: [11], views });
      const clock = fakeClock();
      const slowRun: Run = (command, args, timeoutMs) => {
        if (starts({ command, args, timeoutMs }, 'gh', 'pr', 'view')) clock.advance(17 * SECOND_MS);
        return github.run(command, args, timeoutMs);
      };
      return { outcome: publish(request, { run: slowRun, ...clock }), github, clock };
    }
    const merged = slow([...Array<string>(38).fill(OPEN_ON), MERGED]);
    assert.equal(await merged.outcome, 'merged');
    assert.equal(merged.github.lines().filter((call) => call[2] === 'view').length, 39);
    const late = slow([...Array<string>(39).fill(OPEN_ON), MERGED]);
    await assert.rejects(late.outcome, { message: /has not merged 30 minutes after the wait began/ });
    assert.equal(late.github.lines().filter((call) => call[2] === 'view').length, 39);
    assert.equal(late.clock.sleeps.length, 38);
  });

  test('a command that fails stops publish with its stderr, and nothing after it runs', async () => {
    const denied = 'remote: Permission to tibia-sh/mcp.tibia.sh.git denied';
    const push = publishing({ views: [], fail: { call: ['git', 'push'], stderr: `${denied}\n` } });
    await assert.rejects(push.outcome, {
      message: `git push --force origin HEAD:refs/heads/${branch} exited 1: ${denied}`,
    });
    assert.deepEqual(push.github.lines(), [DIFF, LIST, ...CREATE('').slice(0, 5)]);
    assert.equal(push.github.created.body, undefined);
    const merge = publishing({ open: [11], views: [OPEN_OFF], fail: { call: ['gh', 'pr', 'merge'], stderr: 'no\n' } });
    await assert.rejects(merge.outcome, { message: `gh pr merge --auto --rebase ${branch} exited 1: no` });
    assert.deepEqual(merge.github.lines(), [DIFF, LIST, VIEW, MERGE]);
  });

  test('a git diff that fails, rather than finds a change, stops publish', async () => {
    const runner = fakeRun(() => ({ status: 128, stderr: 'fatal: not a git repository\n' }));
    await assert.rejects(publish(request, { run: runner.run, ...fakeClock() }), {
      message: 'git diff --quiet -- package.json pnpm-lock.yaml exited 128: fatal: not a git repository',
    });
    assert.deepEqual(runner.lines(), [DIFF]);
  });

  test('an answer of another shape from gh stops publish, quoting it', async () => {
    const answers = [
      '',
      'not json',
      '{"state":"OPEN"}',
      '{"state":"DRAFT","autoMergeRequest":null}',
      '{"autoMergeRequest":"yes","state":"OPEN"}',
    ];
    for (const printed of answers) {
      const { outcome } = publishing({ open: [11], views: [printed] });
      const quoted = literal(JSON.stringify(`${printed}\n`));
      await assert.rejects(outcome, {
        message: new RegExp(`^gh pr view ${branch} --json state,autoMergeRequest printed ${quoted}, `),
      });
    }
    const lists = [
      '',
      'a pull request',
      '11',
      '{"isCrossRepository":false,"number":11}',
      '[null]',
      '[{"number":11}]',
      '[{"isCrossRepository":false}]',
      '[{"isCrossRepository":"false","number":11}]',
      '[{"isCrossRepository":false,"number":"11"}]',
      '[{"isCrossRepository":false,"number":11},{"isCrossRepository":null,"number":12}]',
    ];
    for (const printed of lists) {
      const listed = fakeRun((call) => (starts(call, 'git', 'diff') ? { status: 1 } : { stdout: `${printed}\n` }));
      const quoted = literal(JSON.stringify(`${printed}\n`));
      await assert.rejects(publish(request, { run: listed.run, ...fakeClock() }), {
        message: new RegExp(`^${literal(LIST.join(' '))} printed ${quoted}, `),
      });
      assert.deepEqual(listed.lines(), [DIFF, LIST]);
    }
  });
});

describe('the real run', () => {
  let scratch: string;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bump-run-test-'));
  });
  after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test('a bounded command that answers in time resolves with its exit status', async () => {
    assert.deepEqual(await run('/bin/sh', ['-c', 'exit 3'], 5 * SECOND_MS), { status: 3, stdout: '', stderr: '' });
  });

  test('a command that gives no answer within the bound is killed, and is gone when the promise settles', async () => {
    // The fake records its pid, ignores SIGTERM, and keeps that disposition through exec, so only a kill ends it.
    // With no arguments it exits at once: macOS scans a new executable on its first run, which can take 200 ms,
    // so the test runs it once before the timed run.
    const pidFile = join(scratch, 'sleeper-pid');
    const sleeper = join(scratch, 'sleeper');
    const script = `#!/bin/sh\n[ $# -eq 0 ] && exit 0\ntrap '' TERM\necho $$ > '${pidFile}'\nexec sleep 30\n`;
    await writeFile(sleeper, script, { mode: 0o755 });
    assert.equal(spawnSync(sleeper, { stdio: 'ignore' }).status, 0);
    await assert.rejects(run(sleeper, ['sleep'], 200), { message: `${sleeper} gave no answer within 0.2 s` });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0, 'the fake recorded its pid');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
});

describe('the CLI', () => {
  const SCRIPT = fileURLToPath(new URL('../scripts/bump.ts', import.meta.url));
  const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
  const USAGE = 'bump: usage: node scripts/bump.ts <pin|publish> <package> <version>\n';
  /** What package.json pins @tibia.sh/tibiawiki-mcp at, which is what the CLI reads. */
  const PINS = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const PINNED = PINS.dependencies[MCP] as string;

  let scratch: string;
  let bin: string;
  let empty: string;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bump-test-'));
    bin = join(scratch, 'bin');
    empty = join(scratch, 'empty');
    await mkdir(bin);
    await mkdir(empty);
    // The fakes log each call to FAKE_LOG, and their working directory to FAKE_CWD when that is set. git diff
    // exits FAKE_DIFF_STATUS, and says so on stdout, when that is set. gh records the GH_TOKEN it was given in
    // FAKE_TOKEN_SEEN, gh pr list fails with FAKE_LIST_FAIL on stderr and otherwise lists no pull request, and
    // gh pr view prints FAKE_VIEW, when those are set. None of them touches the network or the repository.
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh
printf 'git %s\\n' "$*" >> "$FAKE_LOG"
[ -n "\${FAKE_CWD-}" ] && printf '%s\\n' "$PWD" >> "$FAKE_CWD"
if [ "$1" = diff ] && [ -n "\${FAKE_DIFF_STATUS-}" ]; then
  printf 'fake git: %s\\n' "$*"
  exit "$FAKE_DIFF_STATUS"
fi
exit 0
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, 'gh'),
      `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$FAKE_LOG"
[ -n "\${FAKE_CWD-}" ] && printf '%s\\n' "$PWD" >> "$FAKE_CWD"
[ -n "\${FAKE_TOKEN_SEEN-}" ] && printf '%s\\n' "\${GH_TOKEN-unset}" > "$FAKE_TOKEN_SEEN"
if [ "$1 $2" = "pr list" ]; then
  if [ -n "\${FAKE_LIST_FAIL-}" ]; then
    printf '%s\\n' "$FAKE_LIST_FAIL" >&2
    exit 1
  fi
  printf '[]\\n'
fi
if [ "$1 $2" = "pr view" ] && [ -n "\${FAKE_VIEW-}" ]; then
  printf '%s\\n' "$FAKE_VIEW"
fi
if [ "$1 $2" = "pr create" ]; then
  printf 'https://github.com/tibia-sh/mcp.tibia.sh/pull/11\\n'
fi
exit 0
`,
      { mode: 0o755 },
    );
    await writeFile(join(bin, 'pnpm'), `#!/bin/sh\nprintf 'pnpm %s\\n' "$*" >> "$FAKE_LOG"\nexit 0\n`, { mode: 0o755 });
  });
  after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  let runs = 0;
  /**
   * Runs the CLI with the given arguments, the fakes on PATH and nothing else in the environment but env, from
   * the scratch directory, since the script must not depend on where it is run from.
   */
  function cli(args: string[], env: Record<string, string> = {}, path = bin) {
    runs += 1;
    const log = join(scratch, `log-${runs}`);
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: scratch,
      env: { PATH: path, FAKE_LOG: log, ...env },
      encoding: 'utf8',
    });
    return { ...result, log: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
  }

  test('the source reads no environment variable: the token reaches gh and git as inherited', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    assert.doesNotMatch(source, /process\.env/);
    assert.doesNotMatch(source, /GITHUB_/);
  });

  test('a missing or unknown action, or a stray argument, is a usage error', () => {
    for (const args of [[], ['pin'], ['pin', MCP], ['bump', MCP, '0.6.0'], ['pin', MCP, '0.6.0', 'extra']]) {
      const result = cli(args);
      assert.equal(result.status, 1, args.join(' '));
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, USAGE);
    }
  });

  test('a package outside the allowlist, or a version off the pattern, exits 1 before anything runs', () => {
    const other = cli(['pin', '@tibia.sh/other', '1.0.0']);
    assert.equal(other.status, 1);
    assert.equal(other.stdout, '');
    assert.equal(other.stderr, `bump: the package must be ${MCP} or ${DATA}, and this run has "@tibia.sh/other"\n`);
    const tagged = cli(['publish', MCP, 'v0.6.0']);
    assert.equal(tagged.status, 1);
    assert.equal(
      tagged.stderr,
      'bump: the version must match ^[0-9]+\\.[0-9]+\\.[0-9]+$ (1.2.3, no v), and this run has "v0.6.0"\n',
    );
    assert.equal(other.log() + tagged.log(), '');
  });

  test('pin of the pinned version prints already-pinned and exits 0 without running anything', () => {
    const result = cli(['pin', MCP, PINNED]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'bump: already-pinned\n');
    assert.equal(result.stderr, '');
    assert.equal(result.log(), '');
  });

  test('pin of a lower version refuses the downgrade and exits 1', () => {
    const result = cli(['pin', MCP, '0.0.0']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `bump: refuses to move ${MCP} from ${PINNED} down to 0.0.0\n`);
    assert.equal(result.log(), '');
  });

  test('publish with nothing changed prints nothing-to-publish and exits 0, showing what git printed', () => {
    const cwdFile = join(scratch, 'cwd-seen');
    const result = cli(['publish', MCP, '9.9.9'], { FAKE_DIFF_STATUS: '0', FAKE_CWD: cwdFile });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'fake git: diff --quiet -- package.json pnpm-lock.yaml\nbump: nothing-to-publish\n');
    assert.equal(result.stderr, '');
    assert.equal(result.log(), 'git diff --quiet -- package.json pnpm-lock.yaml\n');
    assert.equal(readFileSync(cwdFile, 'utf8'), `${resolve(REPO_ROOT)}\n`, 'git ran in the repo root, not the cwd');
  });

  test('publish of a change opens the pull request and prints merged with exit 0 once gh shows it merged', () => {
    const cwdFile = join(scratch, 'cwd-seen-merged');
    const branch = 'bump/tibiawiki-mcp-9.9.9';
    const title = `chore(deps): bump ${MCP} to 9.9.9`;
    const result = cli(['publish', MCP, '9.9.9'], {
      FAKE_DIFF_STATUS: '1',
      FAKE_VIEW: '{"autoMergeRequest":null,"state":"MERGED"}',
      FAKE_CWD: cwdFile,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.stdout.split('\n'), [
      'fake git: diff --quiet -- package.json pnpm-lock.yaml',
      '[]',
      'https://github.com/tibia-sh/mcp.tibia.sh/pull/11',
      '{"autoMergeRequest":null,"state":"MERGED"}',
      'bump: merged',
      '',
    ]);
    const logged = result.log().trimEnd().split('\n');
    assert.deepEqual(logged.slice(0, 7), [
      'git diff --quiet -- package.json pnpm-lock.yaml',
      `gh pr list --head ${branch} --state open --json number,isCrossRepository`,
      `git switch -c ${branch}`,
      'git add package.json pnpm-lock.yaml',
      'git -c user.name=github-actions[bot] -c user.email=41898282+github-actions[bot]@users.noreply.github.com ' +
        `commit -m ${title}`,
      'gh auth setup-git',
      `git push --force origin HEAD:refs/heads/${branch}`,
    ]);
    const create = `gh pr create --base main --head ${branch} --title ${title} --body-file `;
    assert.match(logged[7] ?? '', new RegExp(`^${literal(create)}.+/body\\.md$`));
    assert.deepEqual(logged.slice(8), [`gh pr view ${branch} --json state,autoMergeRequest`]);
    assert.deepEqual(new Set(readFileSync(cwdFile, 'utf8').trimEnd().split('\n')), new Set([resolve(REPO_ROOT)]));
  });

  test('a command that fails ends the CLI with its stderr, after showing it, and gh got the token unread', () => {
    const tokenSeen = join(scratch, 'token-seen');
    const complaint = 'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.';
    const list = 'gh pr list --head bump/tibiawiki-mcp-9.9.9 --state open --json number,isCrossRepository';
    const result = cli(['publish', MCP, '9.9.9'], {
      FAKE_DIFF_STATUS: '1',
      FAKE_LIST_FAIL: complaint,
      FAKE_TOKEN_SEEN: tokenSeen,
      GH_TOKEN: 'ghp_fake_token_of_this_test',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'fake git: diff --quiet -- package.json pnpm-lock.yaml\n');
    assert.equal(result.stderr, `${complaint}\nbump: ${list} exited 1: ${complaint}\n`);
    assert.equal(result.log(), `git diff --quiet -- package.json pnpm-lock.yaml\n${list}\n`);
    assert.equal(readFileSync(tokenSeen, 'utf8'), 'ghp_fake_token_of_this_test\n');
    assert.doesNotMatch(result.stdout + result.stderr, /ghp_fake/);
  });

  test('a command that cannot start ends the CLI naming it', () => {
    const result = cli(['publish', MCP, '9.9.9'], {}, empty);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'bump: git cannot start: ENOENT\n');
  });
});
