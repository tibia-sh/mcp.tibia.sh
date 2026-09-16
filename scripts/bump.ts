/**
 * The receiver of a first-party release: pins the version, and gets the pull request that pins it merged.
 *
 *   node scripts/bump.ts pin <package> <version>
 *   node scripts/bump.ts publish <package> <version>
 *
 * bump.yml runs the two in turn, on the tip of main, with the package and version a release workflow dispatched.
 * Both validate first: the package must be one first-party.ts registers, and the version an exact 1.2.3.
 *
 * `pin` reads the pin in package.json. The same version ends it with `bump: already-pinned`. A lower one fails it,
 * since a release never moves the endpoint back. A newer one waits until npm serves the version with a publish
 * time and a provenance attestation, polling every 15 seconds for 10 minutes, then runs
 * `pnpm add --save-exact <package>@<version>` and `node scripts/check-lockfile.ts`, so a version whose provenance
 * does not verify never reaches a pull request. It needs no credentials.
 *
 * `publish` ends with `bump: nothing-to-publish` when package.json and pnpm-lock.yaml are unchanged. Otherwise it
 * reuses the open pull request from bump/<name>-<version>, or creates that branch, commits the two files as
 * github-actions[bot], force-pushes the branch and opens the pull request. It turns auto-merge on when it is off,
 * then reads the pull request's state every 30 seconds for 30 minutes: merged ends it with `bump: merged`, closed
 * fails it, auto-merge found off is turned on once more and fails it the second time, and the deadline fails it,
 * so a stalled pull request is a red run. It runs gh and git as found on PATH, in the repository root, with the
 * environment as it is: the workflow puts the token in GH_TOKEN for this command only, and nothing here reads it.
 * Each git and gh command has 120 seconds to answer. pnpm and the lockfile check have no bound of their own, since
 * a cold store or a slow registry can take them minutes, and the workflow's own timeout bounds the run.
 *
 * Every outcome prints one `bump: <outcome>` line on stdout and exits 0. Any failure prints `bump: <reason>` on
 * stderr and exits 1. The commands' own output is shown as they run.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
} from './registry.ts';
import type { FetchJson } from './registry.ts';

/** The repository root, which every command runs in, wherever the script was started from. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** An exact version, as npm names a release and package.json pins it. */
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** How often npm is asked for the version, and for how long since the first try. */
const NPM_POLL_MS = 15_000;
const NPM_DEADLINE_MS = 10 * 60_000;
/** How long one registry request may take. */
const FETCH_TIMEOUT_MS = 10_000;
/** How long one git or gh command may take. */
const COMMAND_TIMEOUT_MS = 120_000;
/** How often the pull request is read while waiting for the merge, and for how long since the wait began. */
const MERGE_POLL_MS = 30_000;
const MERGE_DEADLINE_MS = 30 * 60_000;

const USAGE = 'usage: node scripts/bump.ts <pin|publish> <package> <version>';

/** A validated release to pin: the package, the version, and the branch, title and body of its pull request. */
export type Request = { name: string; version: string; branch: string; title: string; body: string };

/** What a command printed, and its exit status, null when a signal ended it. */
export type Outcome = { status: number | null; stdout: string; stderr: string };
/**
 * Runs a command with its arguments, without a shell, and resolves once it has ended. With timeoutMs, a command
 * that has not ended by then is killed, and the run rejects.
 */
export type Run = (command: string, args: string[], timeoutMs?: number) => Promise<Outcome>;
/** The time and the pauses of a wait, which the tests fake. */
export type Clock = { sleep: (ms: number) => Promise<void>; now: () => number };

/**
 * The request for pkg at version. It throws with the reason when pkg is not a package FIRST_PARTY registers, or
 * version is not an exact 1.2.3, which is all the validation the payload gets before it reaches a command line.
 */
export function parseRequest(pkg: string, version: string): Request {
  if (!FIRST_PARTY.has(pkg)) {
    const allowed = [...FIRST_PARTY.keys()].join(' or ');
    throw new Error(`the package must be ${allowed}, and this run has ${JSON.stringify(pkg)}`);
  }
  if (!VERSION.test(version)) {
    const pattern = `${VERSION.source} (1.2.3, no v)`;
    throw new Error(`the version must match ${pattern}, and this run has ${JSON.stringify(version)}`);
  }
  // Every FIRST_PARTY package is under FIRST_PARTY_SCOPE, and the branch carries the name without it.
  const unscoped = pkg.slice(FIRST_PARTY_SCOPE.length);
  return {
    name: pkg,
    version,
    branch: `bump/${unscoped}-${version}`,
    title: `chore(deps): bump ${pkg} to ${version}`,
    body:
      `\`${pkg}\` ${version} is on npm. This pins it and refreshes the lockfile. The pull request merges itself ` +
      'once the required checks pass, and the merge deploys it.\n\nOpened by `bump.yml`.',
  };
}

/** The version package.json pins name at. It throws when there is no such dependency, or the pin is not exact. */
function pinOf(packageJson: unknown, name: string): string {
  const pinned = field(field(packageJson, 'dependencies'), name);
  if (pinned === undefined) throw new Error(`package.json pins no such dependency as ${name}`);
  if (typeof pinned !== 'string' || !VERSION.test(pinned)) {
    throw new Error(`package.json pins ${name} at ${JSON.stringify(pinned)}, not an exact version`);
  }
  return pinned;
}

/** The major, minor and patch of a version VERSION has matched, exact at any size. */
function parts(version: string): [bigint, bigint, bigint] {
  const [major = '', minor = '', patch = ''] = version.split('.');
  return [BigInt(major), BigInt(minor), BigInt(patch)];
}

/**
 * Whether the requested version is the one packageJson pins, newer than it, or older, comparing the three numbers
 * in turn. It throws when packageJson pins no such dependency, or pins it at something other than an exact version.
 */
export function compareWithPin(request: Request, packageJson: unknown): 'equal' | 'newer' | 'older' {
  const requested = parts(request.version);
  const pinned = parts(pinOf(packageJson, request.name));
  for (const index of [0, 1, 2] as const) {
    if (requested[index] !== pinned[index]) return requested[index] > pinned[index] ? 'newer' : 'older';
  }
  return 'equal';
}

/**
 * Pauses for interval before the next try, and resolves with whether that try may start: the deadline has not
 * passed. It resolves false without pausing when the pause alone would cross the deadline, and reads the clock
 * again after the pause, since a late timer or a suspended process can overshoot it.
 */
async function pauseBefore(deadline: number, interval: number, clock: Clock): Promise<boolean> {
  if (clock.now() + interval > deadline) return false;
  await clock.sleep(interval);
  return clock.now() <= deadline;
}

/** Why a packument does not list version with a publish time, or undefined when it does. */
function packumentLacks(packument: unknown, version: string): string | undefined {
  if (field(field(packument, 'versions'), version) === undefined) return `the packument lists no ${version}`;
  if (field(field(packument, 'time'), version) === undefined) {
    return `the packument records no publish time for ${version}`;
  }
  return undefined;
}

/** Why an attestations response holds no provenance attestation, or undefined when it holds at least one. */
function attestationsLack(response: unknown): string | undefined {
  return provenanceAttestations(response).length > 0 ? undefined : `the registry holds no ${PROVENANCE} attestation`;
}

/**
 * What the document at url lacks by judge, or undefined when nothing. A fetch that fails, which includes one that
 * timed out, is a document that lacks everything, since npm may not be serving the release yet.
 */
async function lacks(
  fetchJson: FetchJson,
  url: string,
  judge: (body: unknown) => string | undefined,
): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await fetchJson(url);
  } catch (error) {
    return `cannot read ${url}: ${errorText(error)}`;
  }
  return judge(body);
}

/**
 * Resolves once npm serves the request's version: its packument lists the version with a publish time, and its
 * attestations document holds a provenance attestation. It tries every NPM_POLL_MS, the packument until that is
 * there and the attestations from then on, and no try starts later than NPM_DEADLINE_MS after the first: once the
 * next one would, it rejects naming what npm still lacks.
 */
export async function waitForNpm(request: Request, deps: { fetchJson: FetchJson } & Clock): Promise<void> {
  const packument = packumentUrl(request.name);
  const attestations = attestationsUrl(request.name, request.version);
  const deadline = deps.now() + NPM_DEADLINE_MS;
  let published = false;
  for (;;) {
    let reason: string | undefined;
    if (!published) {
      reason = await lacks(deps.fetchJson, packument, (body) => packumentLacks(body, request.version));
      published = reason === undefined;
    }
    if (published) reason = await lacks(deps.fetchJson, attestations, attestationsLack);
    if (reason === undefined) return;
    if (!(await pauseBefore(deadline, NPM_POLL_MS, deps))) {
      throw new Error(
        `npm does not serve ${request.name}@${request.version} with provenance ` +
          `${NPM_DEADLINE_MS / 60_000} minutes after the first try: ${reason}`,
      );
    }
  }
}

/** How a command that did not exit 0 ended: its command line, its exit, and its stderr, which is where it says why. */
function failure(command: string, args: string[], outcome: Outcome): Error {
  const ending = outcome.status === null ? 'was killed by a signal' : `exited ${outcome.status}`;
  const stderr = outcome.stderr.trim();
  return new Error(`${[command, ...args].join(' ')} ${ending}${stderr === '' ? '' : `: ${stderr}`}`);
}

/** Runs the command through run and resolves with what it printed once it exited 0. Any other end throws. */
async function succeed(run: Run, command: string, args: string[]): Promise<Outcome> {
  const outcome = await run(command, args);
  if (outcome.status !== 0) throw failure(command, args, outcome);
  return outcome;
}

/** The Run with every command bounded at timeoutMs. */
function bounded(run: Run, timeoutMs: number): Run {
  return (command, args) => run(command, args, timeoutMs);
}

/**
 * Pins the request's version. The pinned version resolves already-pinned without a lookup. An older one throws,
 * since the trigger never downgrades. A newer one waits for npm, runs pnpm add, which pins it and refreshes the
 * lockfile, then the lockfile check on the result, and resolves pinned. A command that does not exit 0 throws
 * with its stderr, so a version whose provenance does not verify never reaches a pull request.
 */
export async function pin(
  request: Request,
  deps: { readPackageJson: () => unknown; fetchJson: FetchJson; run: Run } & Clock,
): Promise<'pinned' | 'already-pinned'> {
  const packageJson = deps.readPackageJson();
  const comparison = compareWithPin(request, packageJson);
  if (comparison === 'equal') return 'already-pinned';
  if (comparison === 'older') {
    throw new Error(
      `refuses to move ${request.name} from ${pinOf(packageJson, request.name)} down to ${request.version}`,
    );
  }
  await waitForNpm(request, deps);
  await succeed(deps.run, 'pnpm', ['add', '--save-exact', `${request.name}@${request.version}`]);
  await succeed(deps.run, 'node', ['scripts/check-lockfile.ts']);
  return 'pinned';
}

/** The state of a pull request as gh names it, and whether auto-merge is on. */
type PullRequest = { state: 'OPEN' | 'CLOSED' | 'MERGED'; autoMerge: boolean };

/** Whether the pull request from branch has merged, which ends the wait. A closed one, which never will, throws. */
function hasMerged(pullRequest: PullRequest, branch: string): boolean {
  if (pullRequest.state === 'CLOSED') throw new Error(`the pull request from ${branch} was closed without merging`);
  return pullRequest.state === 'MERGED';
}

/** What gh printed, quoted, for an answer of another shape than the command's. */
function unexpected(command: string[], stdout: string): Error {
  return new Error(`${command.join(' ')} printed ${JSON.stringify(stdout)}, which is not what it answers with`);
}

/** Whether an open pull request from branch exists, by gh, whose answer is the numbers of the open ones. */
async function hasOpenPullRequest(run: Run, branch: string): Promise<boolean> {
  const command = ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[].number'];
  const { stdout } = await succeed(run, 'gh', command);
  const numbers = stdout.trim() === '' ? [] : stdout.trim().split('\n');
  if (!numbers.every((number) => /^\d+$/.test(number))) throw unexpected(['gh', ...command], stdout);
  return numbers.length > 0;
}

/** The pull request from branch as gh sees it. It throws when gh answers with another shape. */
async function viewPullRequest(run: Run, branch: string): Promise<PullRequest> {
  const command = ['pr', 'view', branch, '--json', 'state,autoMergeRequest'];
  const { stdout } = await succeed(run, 'gh', command);
  let view: unknown;
  try {
    view = JSON.parse(stdout);
  } catch {
    view = undefined;
  }
  const state = field(view, 'state');
  const autoMergeRequest = field(view, 'autoMergeRequest');
  if (
    (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') ||
    (autoMergeRequest !== null && !isMapping(autoMergeRequest))
  ) {
    throw unexpected(['gh', ...command], stdout);
  }
  return { state, autoMerge: autoMergeRequest !== null };
}

/** Turns auto-merge on for the pull request from branch, with a rebase merge, which the ruleset's checks gate. */
function turnOnAutoMerge(run: Run, branch: string): Promise<unknown> {
  return succeed(run, 'gh', ['pr', 'merge', '--auto', '--rebase', branch]);
}

/**
 * Creates the request's branch at HEAD with the pinned package.json and pnpm-lock.yaml committed as
 * github-actions[bot], force-pushes it, since the bump/ namespace belongs to this workflow and a closed pull
 * request can leave an old branch behind, and opens the pull request. gh takes the body from a file under the
 * temporary directory, removed afterwards, and it and git take the token from the environment, through
 * `gh auth setup-git`.
 */
async function openPullRequest(run: Run, request: Request): Promise<void> {
  const { branch, title } = request;
  await succeed(run, 'git', ['switch', '-c', branch]);
  await succeed(run, 'git', ['add', 'package.json', 'pnpm-lock.yaml']);
  await succeed(run, 'git', [
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', title,
  ]);
  await succeed(run, 'gh', ['auth', 'setup-git']);
  await succeed(run, 'git', ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
  const scratch = await mkdtemp(join(tmpdir(), 'bump-'));
  try {
    const bodyFile = join(scratch, 'body.md');
    await writeFile(bodyFile, request.body);
    await succeed(run, 'gh', [
      'pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile,
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Gets the pinned package.json and pnpm-lock.yaml merged. Unchanged files resolve nothing-to-publish. Otherwise an
 * open pull request from the request's branch is reused, or one is opened, and it is read: merged already resolves
 * merged, closed throws, and auto-merge is turned on when it is off. Then the wait begins: every MERGE_POLL_MS the
 * pull request is read again. Merged resolves merged. Closed throws. Auto-merge found off is turned on once more,
 * and throws the second time. No poll starts later than MERGE_DEADLINE_MS after the wait began: once the next one
 * would, it throws naming the pull request. Every git and gh command has COMMAND_TIMEOUT_MS to answer, and a
 * command that does not exit 0 throws with its stderr.
 */
export async function publish(
  request: Request,
  deps: { run: Run } & Clock,
): Promise<'merged' | 'nothing-to-publish'> {
  const { branch } = request;
  const run = bounded(deps.run, COMMAND_TIMEOUT_MS);
  const diffArgs = ['diff', '--quiet', '--', 'package.json', 'pnpm-lock.yaml'];
  const diff = await run('git', diffArgs);
  if (diff.status === 0) return 'nothing-to-publish';
  // git diff --quiet exits 1 for a difference, and any other end is git failing.
  if (diff.status !== 1) throw failure('git', diffArgs, diff);
  if (!(await hasOpenPullRequest(run, branch))) await openPullRequest(run, request);
  const found = await viewPullRequest(run, branch);
  if (hasMerged(found, branch)) return 'merged';
  if (!found.autoMerge) await turnOnAutoMerge(run, branch);
  const deadline = deps.now() + MERGE_DEADLINE_MS;
  let turnedOnAgain = false;
  while (await pauseBefore(deadline, MERGE_POLL_MS, deps)) {
    const pullRequest = await viewPullRequest(run, branch);
    if (hasMerged(pullRequest, branch)) return 'merged';
    if (!pullRequest.autoMerge) {
      if (turnedOnAgain) {
        throw new Error(`auto-merge on the pull request from ${branch} was found off a second time`);
      }
      await turnOnAutoMerge(run, branch);
      turnedOnAgain = true;
    }
  }
  throw new Error(
    `the pull request from ${branch} has not merged ${MERGE_DEADLINE_MS / 60_000} minutes after the wait began`,
  );
}

/**
 * Runs a command with its arguments, without a shell, in REPO_ROOT, with the environment as it is, and resolves
 * once it has ended with its exit status, null when a signal ended it, and what it printed. Its output is also
 * shown as it arrives, so the log carries pnpm's, the lockfile check's, git's and gh's own lines. With timeoutMs,
 * a command still running by then gets SIGKILL, which it cannot ignore, and the run rejects once it is gone. It
 * rejects at once when the command cannot start, as when it is not on PATH.
 */
export function run(command: string, args: string[], timeoutMs?: number): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    let signal: AbortSignal | undefined;
    let noAnswer: string | undefined;
    if (timeoutMs !== undefined) {
      signal = AbortSignal.timeout(timeoutMs);
      noAnswer = `${command} gave no answer within ${timeoutMs / 1000} s`;
    }
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      // The bound has sent the kill. The rejection follows on close, once the process is gone.
      if (error.name === 'AbortError') killed = true;
      else reject(new Error(`${command} cannot start: ${error.code ?? error.message}`));
    });
    child.on('close', (status) => {
      if (killed) reject(new Error(noAnswer));
      else resolve({ status, stdout, stderr });
    });
  });
}

/** This repository's package.json, parsed. */
function readPackageJson(): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
}

async function main(args: string[]): Promise<number> {
  const [action, pkg, version, ...extra] = args;
  try {
    const known = action === 'pin' || action === 'publish';
    if (!known || pkg === undefined || version === undefined || extra.length > 0) throw new Error(USAGE);
    const request = parseRequest(pkg, version);
    const clock: Clock = { sleep: (ms) => delay(ms), now: Date.now };
    const outcome =
      action === 'pin'
        ? await pin(request, { readPackageJson, fetchJson: (url) => fetchJson(url, FETCH_TIMEOUT_MS), run, ...clock })
        : await publish(request, { run, ...clock });
    console.log(`bump: ${outcome}`);
    return 0;
  } catch (error) {
    console.error(`bump: ${errorText(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
