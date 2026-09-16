/**
 * The lockfile check: is every package pnpm-lock.yaml installs old enough, or first-party with verified provenance?
 *
 *   node scripts/check-lockfile.ts
 *
 * It reads the project document of pnpm-lock.yaml and judges each registry package once, by name and version:
 * - A package outside @tibia.sh/ passes when the registry's publish time for its version is at least 7 days before
 *   now, the release age pnpm-workspace.yaml sets. pnpm applies that age when it resolves a version and checks the
 *   lockfile against it again when it installs, memoized per lockfile, and it never verifies provenance, so CI
 *   judges the lockfile itself on every run.
 * - An @tibia.sh/ package skips that cooldown, so it passes only when first-party.ts registers its release
 *   workflow, the lockfile holds it at one version, the one package.json pins, its registry tarball has the
 *   integrity the lockfile records, the registry holds exactly one provenance attestation for it, and
 *   `gh attestation verify` accepts that attestation for that tarball as signed by that workflow on main, in a
 *   tibia-sh repository, on a GitHub-hosted runner. npm attaches one provenance attestation to a version, so a
 *   second one is a change to fail closed on.
 * - An entry that is not a registry package of its own name and version fails, because neither rule can vouch for
 *   what pnpm would install from it.
 *
 * pnpm-lock.yaml holds two YAML documents. The first records pnpm's own executable, the version package.json's
 * packageManager field pins by hand, and this check skips it: the release age guards what the project resolves,
 * and a package manager pinned by hand is not that. The second is the project's, and is what this check reads.
 *
 * `pnpm audit signatures`, which CI runs before this check, verifies the registry's signature on every package.
 * That proves the registry served the tarballs it published, not who built them. The provenance attestation names
 * the workflow that built a first-party tarball, and this check has gh verify it against the workflow first-party.ts
 * registers, so a first-party version published from anywhere else fails here.
 *
 * The CLI prints one line per failure and exits 1 if there is any. Otherwise it prints one PASS line, naming the
 * first-party entries gh verified, and exits 0. It needs gh on PATH, and no gh login.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { stripVTControlCharacters } from 'node:util';
import { parseAllDocuments } from 'yaml';
import packageJson from '../package.json' with { type: 'json' };
import { FIRST_PARTY, FIRST_PARTY_SCOPE } from './first-party.ts';
import {
  attestationsUrl,
  errorText,
  fetchJson,
  field,
  isMapping,
  packumentUrl,
  provenanceAttestations,
  PROVENANCE,
  REGISTRY,
} from './registry.ts';
import type { FetchJson } from './registry.ts';

/** The GitHub owner whose repositories may build a first-party package. */
const OWNER = 'tibia-sh';
/** The ref a first-party release workflow must have run on. */
const SOURCE_REF = 'refs/heads/main';

/** The release age a package outside @tibia.sh/ needs, as pnpm-workspace.yaml's minimumReleaseAge of 10080 minutes. */
const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The most registry lookups in flight at once. A first-party lookup includes its download and its gh run. */
const CONCURRENCY = 8;
/** How long one lookup may take, its body included. */
const FETCH_TIMEOUT_MS = 20_000;
/** How long one tarball download may take. The data tarball was 5 MB on 2026-09-15. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** How long one gh run may take. It fetches Sigstore's trust root, and verifies the bundle offline. */
const GH_TIMEOUT_MS = 60_000;

/**
 * A registry package name, scoped or not, and a semver version. Neither can hold a `/` beyond the scope's, or begin
 * with a dot, so neither can walk a registry URL or a scratch path over to somewhere else.
 */
const NAME = /^(?:@[a-z0-9~-][\w.~-]*\/)?[a-z0-9~-][\w.~-]*$/i;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/;
/** A sha512 integrity as the registry and pnpm write it: the digest's 64 bytes in base64. */
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** Downloads url to file, and resolves with the sha512 integrity string of what it wrote. */
export type Download = (url: string, file: string) => Promise<string>;
/** Why gh rejected the tarball with the bundle, or undefined when it verified it. */
export type Verify = (input: { tarball: string; bundle: string; workflow: string }) => Promise<string | undefined>;

/**
 * What the check needs beside the lockfile: the registry, gh, a directory to keep tarballs and bundles in, and the
 * versions package.json pins.
 */
export type Dependencies = {
  fetchJson: FetchJson;
  download: Download;
  verify: Verify;
  scratch: string;
  pins: Record<string, string>;
};

/** The failures, one line each, and the first-party entries gh verified, both in lockfile order. */
export type Verdict = { failures: string[]; verified: string[] };

/** A registry package the lockfile installs: its `packages` key, and what the key and the entry hold. */
type Package = { spec: string; name: string; version: string; integrity: string };

/**
 * The registry package a `packages` entry installs, or why it is not one. The key must be `<name>@<version>`, and
 * the entry must resolve by a sha512 integrity alone, which is how pnpm records a package it fetched from the
 * registry. A git, tarball or directory resolution carries other keys.
 */
function registryPackage(key: string, entry: unknown): Package | string {
  const at = key.lastIndexOf('@');
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  if (at < 1 || !NAME.test(name) || !VERSION.test(version)) return 'the key is not a package name and version';
  const resolution = field(entry, 'resolution');
  const integrity = field(resolution, 'integrity');
  if (
    !isMapping(resolution) ||
    Object.keys(resolution).length !== 1 ||
    typeof integrity !== 'string' ||
    !INTEGRITY.test(integrity)
  ) {
    return `it resolves by ${JSON.stringify(resolution ?? null)}, not by a sha512 integrity alone`;
  }
  return { spec: key, name, version, integrity };
}

/** The registry document a package is judged by: its attestations when first-party, its packument otherwise. */
function lookupUrl(pkg: Package): string {
  return FIRST_PARTY.has(pkg.name) ? attestationsUrl(pkg.name, pkg.version) : packumentUrl(pkg.name);
}

/** Why a packument does not show version published at least MIN_AGE_MS before now, or undefined when it does. */
function releaseAgeFailure(packument: unknown, version: string, now: Date): string | undefined {
  const published = field(field(packument, 'time'), version);
  if (published === undefined) return `the registry records no publish time for ${version}`;
  const publishedMs = typeof published === 'string' ? Date.parse(published) : Number.NaN;
  if (Number.isNaN(publishedMs)) return `the registry's publish time ${JSON.stringify(published)} is not a date`;
  if (now.getTime() - publishedMs < MIN_AGE_MS) {
    return `published ${published}, less than 7 days before ${now.toISOString()}`;
  }
  return undefined;
}

/**
 * Why a first-party package fails before any lookup: it is under the scope with no registered release workflow,
 * package.json does not pin it, the lockfile holds it at a second version, or its version is not the pin.
 * Undefined for a package the release age judges, and for a registered one that is the single copy at its pin.
 */
function offlineFailure(pkg: Package, packages: Package[], pins: Record<string, string>): string | undefined {
  if (!FIRST_PARTY.has(pkg.name)) {
    return pkg.name.startsWith(FIRST_PARTY_SCOPE) ? 'no release workflow is registered for it' : undefined;
  }
  const pin = Object.hasOwn(pins, pkg.name) ? pins[pkg.name] : undefined;
  if (pin === undefined) return 'package.json pins no such dependency';
  const versions = packages.filter((other) => other.name === pkg.name).map((other) => other.version);
  if (versions.length > 1) return `the lockfile holds it at ${versions.join(' and ')}, and package.json pins ${pin}`;
  if (pkg.version !== pin) return `package.json pins ${pin}, not ${pkg.version}`;
  return undefined;
}

/** The bundle of the one provenance attestation in an attestations response, or why there is not one. */
function provenanceBundle(response: unknown): Record<string, unknown> | string {
  const provenance = provenanceAttestations(response);
  if (provenance.length === 0) return `the registry holds no ${PROVENANCE} attestation`;
  if (provenance.length > 1) return `the registry holds ${provenance.length} ${PROVENANCE} attestations, not one`;
  const bundle = field(provenance[0], 'bundle');
  return isMapping(bundle) ? bundle : 'the provenance attestation carries no bundle';
}

/**
 * Why the registry's provenance does not vouch for pkg's tarball, or undefined when gh verified it. The tarball is
 * downloaded into deps.scratch and must have the lockfile's integrity, and gh must accept the attestation's bundle,
 * written beside it, as workflow's signature over it. The files are named after the `packages` key, with the
 * scope's slash escaped as the registry escapes it.
 */
async function provenanceFailure(
  pkg: Package,
  workflow: string,
  response: unknown,
  deps: Dependencies,
): Promise<string | undefined> {
  const bundle = provenanceBundle(response);
  if (typeof bundle === 'string') return bundle;
  const stem = join(deps.scratch, pkg.spec.replace('/', '%2F'));
  const url = `${REGISTRY}${pkg.name}/-/${pkg.name.slice(pkg.name.lastIndexOf('/') + 1)}-${pkg.version}.tgz`;
  let integrity: string;
  try {
    integrity = await deps.download(url, `${stem}.tgz`);
  } catch (error) {
    return `cannot download ${url}: ${errorText(error)}`;
  }
  if (integrity !== pkg.integrity) {
    return `the registry tarball has integrity ${integrity}, not the lockfile's ${pkg.integrity}`;
  }
  await writeFile(`${stem}.bundle.json`, JSON.stringify(bundle));
  const reason = await deps.verify({ tarball: `${stem}.tgz`, bundle: `${stem}.bundle.json`, workflow });
  return reason === undefined ? undefined : `gh attestation verify: ${reason}`;
}

/**
 * Calls work on every item, at most `limit` calls at a time, and settles when all of them have. A rejection
 * surfaces only once the other calls in flight have settled too, so nothing is still running when the caller
 * acts on it.
 */
async function forEachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await work(item);
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
}

/**
 * The project document of pnpm-lock.yaml, parsed: the one document whose importer `.` has dependencies or
 * devDependencies. The document that records the package manager has packageManagerDependencies there instead.
 * It throws when the text is not valid YAML, or when there is not exactly one project document.
 */
export function projectDocument(lockfileText: string): unknown {
  const projects: unknown[] = [];
  for (const document of parseAllDocuments(lockfileText)) {
    const problem = document.errors[0];
    if (problem !== undefined) {
      // The first line of the message, without the code frame yaml appends to it.
      throw new Error(`the lockfile is not valid YAML: ${problem.message.replace(/\n[\s\S]*/, '')}`);
    }
    const parsed: unknown = document.toJS();
    const importer = field(field(parsed, 'importers'), '.');
    if (field(importer, 'dependencies') !== undefined || field(importer, 'devDependencies') !== undefined) {
      projects.push(parsed);
    }
  }
  if (projects.length !== 1) {
    throw new Error(
      `the lockfile holds ${projects.length} documents whose importer . has dependencies or devDependencies, not one`,
    );
  }
  return projects[0];
}

/**
 * The verdict on a parsed project document: one failure line `<name>@<version>: <reason>` for a registry package,
 * and `<packages key>: <reason>` for an entry that is not one. Each package is judged once. A first-party package
 * that fails before any lookup gets none. Each registry document the rest need is fetched once through
 * deps.fetchJson, at most CONCURRENCY lookups at a time, and a failed fetch fails the packages judged by that
 * document. It throws when lock has no `packages` mapping, when now is not a valid Date, and when deps.verify
 * rejects, which is how a gh that cannot run ends the check.
 */
export async function checkLockfile(lock: unknown, deps: Dependencies, now: Date): Promise<Verdict> {
  const entries = field(lock, 'packages');
  if (!isMapping(entries)) throw new TypeError('the lockfile document has no packages mapping');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now is not a valid Date');

  const failures: string[] = [];
  const packages: Package[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    const found = registryPackage(key, entry);
    if (typeof found === 'string') failures.push(`${key}: ${found}`);
    else packages.push(found);
  }

  const reasons = new Map<string, string>();
  for (const pkg of packages) {
    const reason = offlineFailure(pkg, packages, deps.pins);
    if (reason !== undefined) reasons.set(pkg.spec, reason);
  }

  const judgedBy = Map.groupBy(packages.filter((pkg) => !reasons.has(pkg.spec)), lookupUrl);
  const verified = new Set<string>();
  await forEachLimited([...judgedBy], CONCURRENCY, async ([url, judged]) => {
    let body: unknown;
    try {
      body = await deps.fetchJson(url);
    } catch (error) {
      for (const pkg of judged) reasons.set(pkg.spec, `cannot read ${url}: ${errorText(error)}`);
      return;
    }
    for (const pkg of judged) {
      const firstParty = FIRST_PARTY.get(pkg.name);
      const reason =
        firstParty === undefined
          ? releaseAgeFailure(body, pkg.version, now)
          : await provenanceFailure(pkg, firstParty.workflow, body, deps);
      if (reason !== undefined) reasons.set(pkg.spec, reason);
      else if (firstParty !== undefined) verified.add(pkg.spec);
    }
  });
  for (const pkg of packages) {
    const reason = reasons.get(pkg.spec);
    if (reason !== undefined) failures.push(`${pkg.spec}: ${reason}`);
  }
  return { failures, verified: packages.filter((pkg) => verified.has(pkg.spec)).map((pkg) => pkg.spec) };
}

/**
 * Streams a GET on url to file within DOWNLOAD_TIMEOUT_MS, and resolves with the sha512 integrity of what it
 * wrote. It rejects on a status outside 200 to 299.
 */
export async function download(url: string, file: string): Promise<string> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    if (response.body === null) throw new Error('the response has no body');
    const hash = createHash('sha512');
    await pipeline(
      response.body,
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(file),
    );
    return `sha512-${hash.digest('base64')}`;
  } catch (error) {
    if (signal.aborted) throw new Error(`no complete download within ${DOWNLOAD_TIMEOUT_MS / 1000} s`);
    throw error;
  }
}

/**
 * A Verify that runs `gh attestation verify` as command, with the policy on its command line: the bundle must
 * sign the tarball's sha512, from workflow in an OWNER repository at SOURCE_REF on a GitHub-hosted runner, as a
 * PROVENANCE predicate. gh prints nothing on success and one Error line to stderr on failure, so a non-zero exit
 * resolves with the last non-empty line of stderr, or the exit code when there is none. A run longer than
 * timeoutMs gets SIGKILL, which it cannot ignore, and resolves with that. Every verdict waits for the process to
 * be gone and its stderr to end. It rejects when the command cannot start, as when gh is not on PATH.
 */
export function ghVerify(command = 'gh', timeoutMs = GH_TIMEOUT_MS): Verify {
  return ({ tarball, bundle, workflow }) =>
    new Promise((resolve, reject) => {
      const args = [
        'attestation', 'verify', tarball,
        '--bundle', bundle,
        '--digest-alg', 'sha512',
        '--owner', OWNER,
        '--signer-workflow', workflow,
        '--source-ref', SOURCE_REF,
        '--deny-self-hosted-runners',
        '--predicate-type', PROVENANCE,
      ];
      const child = spawn(command, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        signal: AbortSignal.timeout(timeoutMs),
        killSignal: 'SIGKILL',
      });
      let stderr = '';
      let timedOut = false;
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        // The abort has sent the kill. The verdict follows on close, once the process has exited.
        if (error.name === 'AbortError') timedOut = true;
        else reject(new Error(`gh cannot start: ${error.code ?? error.message}`));
      });
      child.on('close', (code, signal) => {
        if (timedOut) {
          resolve(`no verdict from gh within ${timeoutMs / 1000} s`);
        } else if (code === 0) {
          resolve(undefined);
        } else if (code === null) {
          resolve(`gh was killed by ${signal}`);
        } else {
          const lines = stripVTControlCharacters(stderr)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== '');
          resolve(lines.at(-1) ?? `gh exited ${code}`);
        }
      });
    });
}

async function main(): Promise<number> {
  const started = performance.now();
  let lookups = 0;
  let verdict: Verdict;
  const scratch = await mkdtemp(join(tmpdir(), 'check-lockfile-'));
  try {
    const lock = projectDocument(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'));
    const counted: FetchJson = (url) => {
      lookups += 1;
      return fetchJson(url, FETCH_TIMEOUT_MS);
    };
    const deps = { fetchJson: counted, download, verify: ghVerify(), scratch, pins: packageJson.dependencies };
    verdict = await checkLockfile(lock, deps, new Date());
  } catch (error) {
    console.error(`check-lockfile: ${errorText(error)}`);
    return 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  for (const failure of verdict.failures) console.error(failure);
  if (verdict.failures.length > 0) return 1;
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `check-lockfile: PASS, ${lookups} registry lookups in ${seconds} s, ` +
      `provenance verified for ${verdict.verified.join(', ')}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
