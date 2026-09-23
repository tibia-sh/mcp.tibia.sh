/**
 * The served-artifact check: does an MCP endpoint serve the server and the index this repo pins?
 *
 *   node scripts/served-artifact.ts <url> [--wait-seconds <n>] [--expect-commit <sha>]
 *
 * Client 2.0.0 connects to the URL twice, once with default options (the 2025 era) and once with
 * versionNegotiation in auto mode (the 2026 era). Each era must list the tools named in TOOL_NAMES of the
 * pinned @tibia.sh/tibiawiki-mcp, identify itself with that pinned version, and answer tibia_search from the
 * index in the pinned @tibia.sh/tibiawiki-data. Both artifact checks are needed: a server-only bump leaves the
 * index time unchanged, and a data bump leaves the server version unchanged. No response may carry mcp-session-id,
 * because the server is stateless.
 *
 * The CLI makes one attempt, or with --wait-seconds repeats attempts 10 s apart and starts none after
 * n seconds. Each attempt has 60 s, so the CLI ends within n + 60 s. With --expect-commit, an attempt
 * also needs the x-deploy-commit header of the landing page at / to equal the given commit. The CLI exits
 * 0 on the first attempt without mismatches, 1 with the last attempt's reasons, and 2 on a usage error.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ClientOptions } from '@modelcontextprotocol/client';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { TOOL_NAMES } from '@tibia.sh/tibiawiki-mcp/dist/server.js';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import packageJson from '../package.json' with { type: 'json' };

export type ServedArtifact = { serverVersion: string; indexGeneratedAt: string; toolNames: string[] };

export type EraReport = {
  era: 'default' | 'auto';
  protocolVersion: string;
  /** The names tools/list served, sorted. */
  toolNames: string[];
  artifact: Omit<ServedArtifact, 'toolNames'>;
  responsesSeen: number;
  sessionIdsSeen: string[];
};

type Era = EraReport['era'];

/** The client options of each era, in the order probe() connects them. */
const ERAS: ReadonlyArray<readonly [Era, ClientOptions]> = [
  ['default', {}],
  ['auto', { versionNegotiation: { mode: 'auto' } }],
];

/** The protocol version each era must negotiate. */
const PROTOCOL_VERSIONS: Readonly<Record<Era, string>> = { default: '2025-11-25', auto: '2026-07-28' };

/** How long one CLI attempt may take. */
const ATTEMPT_MS = 60_000;
/** The pause between the end of a failed attempt and the start of the next one. */
const ATTEMPT_INTERVAL_MS = 10_000;

const USAGE = 'usage: node scripts/served-artifact.ts <url> [--wait-seconds <n>] [--expect-commit <sha>]';

/**
 * What the endpoint must serve: the @tibia.sh/tibiawiki-mcp version pinned in package.json and the TOOL_NAMES
 * of the installed copy, and the generate_time of the index in the installed @tibia.sh/tibiawiki-data, opened
 * read-only.
 */
export function expectedArtifact(): ServedArtifact {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM database_info WHERE key = 'generate_time'").get();
    const generateTime = row?.['value'];
    if (typeof generateTime !== 'string') throw new Error(`${DB_PATH} holds no database_info.generate_time`);
    return {
      serverVersion: packageJson.dependencies['@tibia.sh/tibiawiki-mcp'],
      indexGeneratedAt: generateTime,
      toolNames: [...TOOL_NAMES],
    };
  } finally {
    db.close();
  }
}

/** Passes the promise through, and names the era and the step in its rejection. */
function step<T>(era: Era, name: string, promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    throw new Error(`${era}: ${name}: ${describe(error)}`, { cause: error });
  });
}

/** Connects one era's client, observes what it is served, and closes the client on every path. */
async function probeEra(url: URL, signal: AbortSignal, era: Era, options: ClientOptions): Promise<EraReport> {
  let responsesSeen = 0;
  const sessionIdsSeen: string[] = [];
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      // The transport aborts its own requests when it closes, so its signal stays beside the caller's.
      const signals = init?.signal ? [init.signal, signal] : [signal];
      const response = await fetch(input, { ...init, signal: AbortSignal.any(signals) });
      responsesSeen += 1;
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId !== null) sessionIdsSeen.push(sessionId);
      return response;
    },
  });
  const client = new Client({ name: 'mcp.tibia.sh served-artifact', version: '1.0.0' }, options);
  try {
    await step(era, 'connect', client.connect(transport, { signal }));
    // Read before close(), which forgets both.
    const protocolVersion = client.getNegotiatedProtocolVersion();
    const serverVersion = client.getServerVersion()?.version;
    if (protocolVersion === undefined) throw new Error(`${era}: connect negotiated no protocol version`);
    if (serverVersion === undefined) throw new Error(`${era}: the handshake carried no serverInfo`);

    const { tools } = await step(era, 'tools/list', client.listTools(undefined, { signal }));
    const search = { name: 'tibia_search', arguments: { query: 'Dragon', limit: 1 } };
    const result = await step(era, 'tibia_search', client.callTool(search, { signal }));
    if (result.isError === true) {
      const text = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ');
      throw new Error(`${era}: tibia_search answered with an error: ${text}`);
    }
    const structured: unknown = result.structuredContent;
    const indexGeneratedAt =
      typeof structured === 'object' && structured !== null && 'indexGeneratedAt' in structured
        ? structured.indexGeneratedAt
        : undefined;
    if (typeof indexGeneratedAt !== 'string') {
      throw new Error(`${era}: tibia_search answered without a string structuredContent.indexGeneratedAt`);
    }

    return {
      era,
      protocolVersion,
      toolNames: tools.map((tool) => tool.name).sort(),
      artifact: { serverVersion, indexGeneratedAt },
      responsesSeen,
      sessionIdsSeen,
    };
  } finally {
    await client.close();
  }
}

/** Probes the eras one after the other, and yields each era's report as soon as it has one. */
async function* probeEras(url: URL, signal: AbortSignal): AsyncGenerator<EraReport> {
  for (const [era, options] of ERAS) yield await probeEra(url, signal, era, options);
}

/**
 * Connects client 2.0.0 to the MCP endpoint at url in both eras, one after the other, and reports what
 * each was served. Every fetch the transports make carries signal.
 */
export async function probe(url: URL, signal: AbortSignal): Promise<EraReport[]> {
  const reports: EraReport[] = [];
  for await (const report of probeEras(url, signal)) reports.push(report);
  return reports;
}

/** One line per failed condition, each naming its era. None when every report serves the expected artifact. */
export function mismatches(reports: EraReport[], expected: ServedArtifact): string[] {
  const quote = (value: unknown) => JSON.stringify(value);
  const expectedNames = new Set(expected.toolNames);
  return reports.flatMap(({ era, protocolVersion, toolNames, artifact, responsesSeen, sessionIdsSeen }) => {
    const lines: string[] = [];
    const servedNames = new Set(toolNames);
    const missing = expected.toolNames.filter((name) => !servedNames.has(name));
    const extra = toolNames.filter((name) => !expectedNames.has(name));
    if (missing.length > 0 || extra.length > 0) {
      lines.push(`${era}: tools/list is missing ${quote(missing)} and serves extra ${quote(extra)}`);
    }
    if (responsesSeen === 0) {
      lines.push(`${era}: no HTTP response was observed, so the mcp-session-id check proves nothing`);
    }
    if (sessionIdsSeen.length > 0) {
      lines.push(`${era}: responses carried mcp-session-id ${quote(sessionIdsSeen)}, expected none`);
    }
    if (artifact.serverVersion !== expected.serverVersion) {
      lines.push(`${era}: serverInfo.version is ${quote(artifact.serverVersion)}, expected ${quote(expected.serverVersion)}`);
    }
    if (artifact.indexGeneratedAt !== expected.indexGeneratedAt) {
      lines.push(
        `${era}: indexGeneratedAt is ${quote(artifact.indexGeneratedAt)}, expected ${quote(expected.indexGeneratedAt)}`,
      );
    }
    if (protocolVersion !== PROTOCOL_VERSIONS[era]) {
      lines.push(`${era}: negotiated protocol ${quote(protocolVersion)}, expected ${quote(PROTOCOL_VERSIONS[era])}`);
    }
    return lines;
  });
}

/** The x-deploy-commit header of the landing page at the root of url's origin, or null when it has none. */
export async function deployedCommit(url: URL, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(new URL('/', url), { headers: { accept: 'text/html' }, signal });
  await response.body?.cancel();
  return response.headers.get('x-deploy-commit');
}

/**
 * An error's message followed by the messages of its causes, which is where fetch keeps the network error.
 * A cause whose message the text already quotes, as step() quotes its cause, is not repeated.
 */
function describe(error: unknown): string {
  let text = '';
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (!text.includes(message)) text = text === '' ? message : `${text}: ${message}`;
    current = current instanceof Error ? current.cause : undefined;
  }
  return text;
}

/** The observed values of one attempt, one line per era and one for the commit, and its reasons to fail. */
type Attempt = { observed: string[]; reasons: string[] };

/**
 * One attempt within ATTEMPT_MS. A timeout, a connection error or any thrown error fails it with its
 * reason, and keeps what the attempt observed and found before it.
 */
async function attempt(url: URL, expected: ServedArtifact, expectCommit: string | undefined): Promise<Attempt> {
  const signal = AbortSignal.timeout(ATTEMPT_MS);
  const observed: string[] = [];
  const reasons: string[] = [];
  const failure = (error: unknown) =>
    signal.aborted ? `no complete answer within ${ATTEMPT_MS / 1000} s: ${describe(error)}` : describe(error);
  try {
    for await (const report of probeEras(url, signal)) {
      const { era, protocolVersion, toolNames, artifact, responsesSeen, sessionIdsSeen } = report;
      observed.push(
        `${era}: protocol ${JSON.stringify(protocolVersion)}, ${toolNames.length} tools, ` +
          `serverInfo.version ${JSON.stringify(artifact.serverVersion)}, ` +
          `indexGeneratedAt ${JSON.stringify(artifact.indexGeneratedAt)}, ` +
          `${responsesSeen} responses, mcp-session-id ${JSON.stringify(sessionIdsSeen)}`,
      );
      reasons.push(...mismatches([report], expected));
    }
  } catch (error) {
    reasons.push(failure(error));
  }
  // An attempt that ran out of time cannot fetch the commit either.
  if (expectCommit !== undefined && !signal.aborted) {
    try {
      const commit = await deployedCommit(url, signal);
      observed.push(`x-deploy-commit ${JSON.stringify(commit)}`);
      if (commit !== expectCommit) {
        reasons.push(`x-deploy-commit is ${JSON.stringify(commit)}, expected ${JSON.stringify(expectCommit)}`);
      }
    } catch (error) {
      reasons.push(`x-deploy-commit: ${failure(error)}`);
    }
  }
  return { observed, reasons };
}

type Options = { url: URL; waitSeconds: number; expectCommit: string | undefined };

/** The CLI's arguments. Throws an error naming what is wrong with them. */
function parseOptions(args: string[]): Options {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { 'wait-seconds': { type: 'string' }, 'expect-commit': { type: 'string' } },
  });
  const [target, ...extra] = positionals;
  const url = target === undefined ? null : URL.parse(target);
  if (url === null || extra.length > 0 || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error('expected exactly one http or https URL');
  }
  const wait = values['wait-seconds'] ?? '0';
  if (!/^\d+$/.test(wait)) throw new Error(`--wait-seconds takes a whole number of seconds, got ${JSON.stringify(wait)}`);
  const expectCommit = values['expect-commit'];
  if (expectCommit === '') throw new Error('--expect-commit takes a commit, got an empty value');
  return { url, waitSeconds: Number(wait), expectCommit };
}

async function main(args: string[]): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(args);
  } catch (error) {
    console.error(`served-artifact: ${describe(error)}\n${USAGE}`);
    return 2;
  }
  let expected: ServedArtifact;
  try {
    expected = expectedArtifact();
  } catch (error) {
    console.error(`served-artifact: cannot read the pinned artifact: ${describe(error)}`);
    return 1;
  }
  const { url, waitSeconds, expectCommit } = options;
  console.log(
    `expected at ${url}: serverInfo.version ${JSON.stringify(expected.serverVersion)}, ` +
      `indexGeneratedAt ${JSON.stringify(expected.indexGeneratedAt)}` +
      (expectCommit === undefined ? '' : `, x-deploy-commit ${JSON.stringify(expectCommit)}`),
  );
  const started = performance.now();
  const lastStart = started + waitSeconds * 1000;
  for (let number = 1; ; number += 1) {
    console.log(`attempt ${number} at ${Math.round((performance.now() - started) / 1000)} s:`);
    const { observed, reasons } = await attempt(url, expected, expectCommit);
    for (const line of observed) console.log(`  ${line}`);
    if (reasons.length === 0) {
      console.log(`PASS on attempt ${number}`);
      return 0;
    }
    // The next attempt starts 10 s from now, and only if that is no later than the last allowed start. The
    // clock is read again after the pause, because a late timer or a suspended process can overshoot it.
    if (performance.now() + ATTEMPT_INTERVAL_MS <= lastStart) {
      for (const reason of reasons) console.log(`  not yet: ${reason}`);
      await delay(ATTEMPT_INTERVAL_MS);
      if (performance.now() <= lastStart) continue;
    }
    console.error(`FAIL: attempt ${number} was the last, and these are its reasons:`);
    for (const reason of reasons) console.error(`  ${reason}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
