/**
 * The lockfile check: is every package the lockfile installs old enough, or first-party with provenance?
 *
 *   node scripts/check-lockfile.ts
 *
 * It reads package-lock.json and judges each registry package once, by name and version:
 * - A package outside @tibia.sh/ passes when the registry's publish time for its version is at least 7 days before
 *   now, the release age .npmrc sets.
 * - An @tibia.sh/ package skips that cooldown, so it passes only when its https://slsa.dev/provenance/v1 attestation
 *   names a workflow repository under https://github.com/tibia-sh/.
 * - An entry that does not resolve to the registry tarball of its own name and version fails, because neither rule
 *   can vouch for what npm would install from it.
 *
 * `npm ci` installs a lockfile without applying min-release-age, and Dependabot's lockfile updates are not proven to
 * honour it, so CI checks the lockfile itself. This check reads what an attestation states. `npm audit signatures`,
 * which CI runs before it, verifies the attestations' signatures.
 *
 * The CLI prints one line per failure and exits 1 if there is any. Otherwise it prints one PASS line and exits 0.
 */
import { readFileSync } from 'node:fs';

const REGISTRY = 'https://registry.npmjs.org/';
const FIRST_PARTY_SCOPE = '@tibia.sh/';
const FIRST_PARTY_REPOSITORIES = 'https://github.com/tibia-sh/';
const PROVENANCE = 'https://slsa.dev/provenance/v1';

/** The release age a package outside @tibia.sh/ needs, as .npmrc's min-release-age=7. */
const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The most registry lookups in flight at once. */
const CONCURRENCY = 8;
/** How long one lookup may take, its body included. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * A registry package name, scoped or not, and a semver version. Neither can hold a `/` beyond the scope's, or begin
 * with a dot, so neither can walk a registry URL over to another document.
 */
const NAME = /^(?:@[a-z0-9~-][\w.~-]*\/)?[a-z0-9~-][\w.~-]*$/i;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/;

type FetchJson = (url: string) => Promise<unknown>;

type Package = { name: string; version: string };

/** The value of an own property of value, or undefined when value is not an object or has no such property. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The registry package a lockfile entry installs, or why it is not one. The name is the entry's `name` for an
 * aliased install, and otherwise the folder after the path's last node_modules/.
 */
function registryPackage(path: string, entry: unknown): Package | string {
  const at = path.lastIndexOf('node_modules/');
  const name = field(entry, 'name') ?? (at === -1 ? undefined : path.slice(at + 'node_modules/'.length));
  if (typeof name !== 'string' || !NAME.test(name)) return `${JSON.stringify(name ?? null)} is not a package name`;
  const version = field(entry, 'version');
  if (typeof version !== 'string' || !VERSION.test(version)) {
    return `${JSON.stringify(version ?? null)} is not a package version`;
  }
  const tarball = `${REGISTRY}${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;
  const resolved = field(entry, 'resolved');
  if (resolved !== tarball) return `it resolves to ${JSON.stringify(resolved ?? null)}, not ${tarball}`;
  return { name, version };
}

function isFirstParty({ name }: Package): boolean {
  return name.startsWith(FIRST_PARTY_SCOPE);
}

/** The registry document a package is judged by: its attestations when first-party, its packument otherwise. */
function lookupUrl(pkg: Package): string {
  return isFirstParty(pkg) ? `${REGISTRY}-/npm/v1/attestations/${pkg.name}@${pkg.version}` : `${REGISTRY}${pkg.name}`;
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
 * Why an attestations response does not show provenance from a tibia-sh repository, or undefined when it does. It
 * needs a provenance attestation, and each one it holds must name such a repository.
 */
function provenanceFailure(response: unknown): string | undefined {
  const attestations = field(response, 'attestations');
  const provenance = Array.isArray(attestations)
    ? attestations.filter((attestation) => field(attestation, 'predicateType') === PROVENANCE)
    : [];
  if (provenance.length === 0) return `the registry holds no ${PROVENANCE} attestation`;
  for (const attestation of provenance) {
    const payload = field(field(field(attestation, 'bundle'), 'dsseEnvelope'), 'payload');
    let statement: unknown;
    try {
      if (typeof payload !== 'string') throw new TypeError('the payload is not a string');
      statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch {
      return 'the provenance attestation carries no base64 JSON statement';
    }
    const parameters = field(field(field(statement, 'predicate'), 'buildDefinition'), 'externalParameters');
    const repository = field(field(parameters, 'workflow'), 'repository');
    if (typeof repository !== 'string' || !repository.startsWith(FIRST_PARTY_REPOSITORIES)) {
      const named = JSON.stringify(repository ?? null);
      return `the provenance names repository ${named}, not one under ${FIRST_PARTY_REPOSITORIES}`;
    }
  }
  return undefined;
}

/** An error's message, followed by its cause's, which is where fetch keeps the network error. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/** Calls work on every item, at most `limit` calls at a time, and settles when all of them have. */
async function forEachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await work(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * The failures of a parsed package-lock.json, one line each: `<name>@<version>: <reason>` for a registry package, and
 * `<install path>: <reason>` for an entry that is not one. The root entry is skipped. Each unique name@version is
 * judged once, and each registry document it needs is fetched once through fetchJson, at most CONCURRENCY at a time.
 * A failed fetch fails the packages judged by that document. It throws when lock has no `packages` object, or when
 * now is not a valid Date.
 */
export async function checkLockfile(lock: unknown, fetchJson: FetchJson, now: Date): Promise<string[]> {
  const entries = field(lock, 'packages');
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new TypeError('the lockfile has no packages object, which lockfileVersion 2 and 3 have');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now is not a valid Date');

  const failures: string[] = [];
  const packages = new Map<string, Package>();
  for (const [path, entry] of Object.entries(entries)) {
    if (path === '') continue;
    const found = registryPackage(path, entry);
    if (typeof found === 'string') failures.push(`${path}: ${found}`);
    else packages.set(`${found.name}@${found.version}`, found);
  }

  const judgedBy = Map.groupBy(packages, ([, pkg]) => lookupUrl(pkg));
  const reasons = new Map<string, string>();
  await forEachLimited([...judgedBy], CONCURRENCY, async ([url, judged]) => {
    let body: unknown;
    try {
      body = await fetchJson(url);
    } catch (error) {
      for (const [spec] of judged) reasons.set(spec, `cannot read ${url}: ${errorText(error)}`);
      return;
    }
    for (const [spec, pkg] of judged) {
      const reason = isFirstParty(pkg) ? provenanceFailure(body) : releaseAgeFailure(body, pkg.version, now);
      if (reason !== undefined) reasons.set(spec, reason);
    }
  });
  for (const spec of packages.keys()) {
    const reason = reasons.get(spec);
    if (reason !== undefined) failures.push(`${spec}: ${reason}`);
  }
  return failures;
}

/** The JSON body of a GET on url, within FETCH_TIMEOUT_MS. It rejects on a status outside 200 to 299. */
async function fetchJson(url: string): Promise<unknown> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (signal.aborted) throw new Error(`no complete answer within ${FETCH_TIMEOUT_MS / 1000} s`);
    throw error;
  }
}

async function main(): Promise<number> {
  const started = performance.now();
  let lookups = 0;
  let failures: string[];
  try {
    const lock: unknown = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const counted: FetchJson = (url) => {
      lookups += 1;
      return fetchJson(url);
    };
    failures = await checkLockfile(lock, counted, new Date());
  } catch (error) {
    console.error(`check-lockfile: ${errorText(error)}`);
    return 1;
  }
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) return 1;
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`check-lockfile: PASS, ${lookups} registry lookups in ${seconds} s`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
