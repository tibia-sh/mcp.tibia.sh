/**
 * The wrangler config check:
 *
 *   node scripts/check-config.ts
 *
 * It runs `npx wrangler types --check`, then `npx wrangler deploy --dry-run`, both without Cloudflare credentials,
 * and passes their output through. It exits 1 if either exits non-zero or prints a line containing [WARNING], and
 * 0 otherwise.
 *
 * - wrangler only warns about an unknown config key, so a warning fails the check.
 * - `types --check` fails when worker-configuration.d.ts no longer matches the config.
 * - The dry run bundles the Worker and builds the image, so it needs Docker. It never authenticates.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The two commands, in the order they run. */
const COMMANDS = [
  ['types', '--check'],
  ['deploy', '--dry-run'],
];

/** The variables no child process gets: every CLOUDFLARE_* and CF_* one, and wrangler's two own credentials. */
const WITHHELD = /^(?:CLOUDFLARE_|CF_)|^(?:WRANGLER_R2_SQL_AUTH_TOKEN|WRANGLER_CF_AUTHORIZATION_TOKEN)$/;

/**
 * The environment for every process these scripts and tests start: this process's environment without any
 * Cloudflare credential, with wrangler's telemetry and its cf.json fetch turned off, and with wrangler's default
 * log level, so an inherited WRANGLER_LOG cannot hide a warning or the "Ready on" line.
 *
 * - Dropping every CLOUDFLARE_* and CF_* variable covers CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *   CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL, and the deprecated CF_API_TOKEN, CF_ACCOUNT_ID, CF_API_KEY and
 *   CF_EMAIL that wrangler 4.129.1 still reads. WRANGLER_R2_SQL_AUTH_TOKEN and WRANGLER_CF_AUTHORIZATION_TOKEN are
 *   the credentials it reads under its own prefix.
 * - wrangler also loads .env and .env.local from the repo root into its own environment, so no credential may be
 *   kept in those files. None of the commands run here authenticates.
 */
export function credentialFreeEnv(): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([name]) => !WITHHELD.test(name));
  return {
    ...Object.fromEntries(kept),
    WRANGLER_SEND_METRICS: 'false',
    DO_NOT_TRACK: '1',
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    WRANGLER_LOG: 'log',
  };
}

type Outcome = { code: number | null; signal: NodeJS.Signals | null; warnings: string[] };

/**
 * Runs `npx wrangler <args>` from the repo root, passing its output through. It resolves with how the process
 * ended and the lines of its output that contain [WARNING]. wrangler colours that label even when its output is
 * piped, so lines are matched without their control sequences.
 */
function runWrangler(args: string[]): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', ...args], {
      cwd: REPO_ROOT,
      env: credentialFreeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      process.stdout.write(chunk);
      output.stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      process.stderr.write(chunk);
      output.stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const lines = `${output.stdout}\n${output.stderr}`.split(/\r?\n/).map((line) => stripVTControlCharacters(line));
      resolve({ code, signal, warnings: lines.filter((line) => line.includes('[WARNING]')) });
    });
  });
}

async function main(): Promise<number> {
  const commands = COMMANDS.map((args) => ({ args, name: `wrangler ${args.join(' ')}` }));
  const failures: string[] = [];
  for (const { args, name } of commands) {
    let outcome: Outcome;
    try {
      outcome = await runWrangler(args);
    } catch (error) {
      failures.push(`${name} did not start: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (outcome.code !== 0) failures.push(`${name} exited with ${outcome.code ?? outcome.signal}`);
    for (const warning of outcome.warnings) failures.push(`${name} printed: ${warning.trim()}`);
  }
  if (failures.length > 0) {
    console.error('check-config: FAIL');
    for (const failure of failures) console.error(`  ${failure}`);
    return 1;
  }
  console.log(`check-config: PASS, ${commands.map(({ name }) => name).join(' and ')} exited 0 without warnings`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
