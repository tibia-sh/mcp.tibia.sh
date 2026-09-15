/**
 * The image end to end: build it for linux/amd64, run it, and check what it serves over HTTP.
 *
 * - Client 2.0.0 must find the pinned server version and index in both protocol eras
 *   (scripts/served-artifact.ts).
 * - The server must run as the unprivileged node user.
 * - A stateless request must replay harmlessly, which is what lets the Worker retry a failed container
 *   fetch. The replayed requests are the ones client 2.0.0 sends, captured through its transport's fetch
 *   option.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ClientOptions } from '@modelcontextprotocol/client';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expectedArtifact, mismatches, probe } from '../scripts/served-artifact.ts';

const IMAGE = 'mcp-tibia-sh:test';
/** Named before it starts, so cleanup can remove it even when `docker run` is interrupted before printing an ID. */
const CONTAINER = `mcp-tibia-sh-test-${randomUUID()}`;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/**
 * How long the server may take to answer GET /ping, and how long each request below may take. An amd64
 * image runs emulated on an arm64 host, several times slower than natively.
 */
const PING_WAIT_MS = 60_000;
const REQUEST_MS = 60_000;

const execFileAsync = promisify(execFile);

/** Runs a docker command from the repo root. A failure's message carries the command's stderr. */
function docker(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Set just before `docker run`, from when there may be a container to remove. */
let runStarted = false;
/** The container's MCP endpoint, once GET /ping has answered. */
let mcpUrl: URL | undefined;

/**
 * Stops and removes the container, if `docker run` was started. Removing a container that does not exist
 * succeeds. Synchronous, so a signal handler can use it.
 */
function removeContainer(): void {
  if (runStarted) execFileSync('docker', ['rm', '--force', CONTAINER], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// A signal ends this process without running after(), so it removes the container itself. Ctrl-C sends
// SIGINT here, and the test runner passes SIGTERM on.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.once(signal, () => {
    try {
      removeContainer();
    } finally {
      process.exit(code);
    }
  });
}

before(async () => {
  await docker('build', '--platform', 'linux/amd64', '-t', IMAGE, '.');
  runStarted = true;
  await docker('run', '--detach', '--name', CONTAINER, '--platform', 'linux/amd64', '-p', '127.0.0.1::8080', IMAGE);
  const { stdout } = await docker('port', CONTAINER, '8080/tcp');
  const port = /^127\.0\.0\.1:(\d+)$/m.exec(stdout)?.[1];
  assert.ok(port, `docker port printed no 127.0.0.1 binding for 8080/tcp: ${stdout}`);
  await waitForPing(new URL(`http://127.0.0.1:${port}/ping`));
  mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);
});

after(removeContainer);

/** Polls GET /ping until it answers 200, or fails with the last outcome and the container's logs. */
async function waitForPing(url: URL): Promise<void> {
  const deadline = Date.now() + PING_WAIT_MS;
  let last = 'no request finished';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      await response.body?.cancel();
      if (response.status === 200) return;
      last = `status ${response.status}`;
    } catch (error) {
      last = String(error instanceof Error && error.cause !== undefined ? error.cause : error);
    }
    await delay(500);
  }
  const logs = await docker('logs', CONTAINER);
  throw new Error(
    `GET ${url} did not answer 200 within ${PING_WAIT_MS / 1000} s (last: ${last}). ` +
      `Container logs:\n${logs.stdout}${logs.stderr}`,
  );
}

/** The running container's MCP endpoint. */
function endpoint(): URL {
  assert.ok(mcpUrl, 'the container is not serving');
  return mcpUrl;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

test('both protocol eras serve the pinned server version and index', async () => {
  assert.deepEqual(mismatches(await probe(endpoint(), AbortSignal.timeout(REQUEST_MS)), expectedArtifact()), []);
});

test('the server runs as uid 1000', async () => {
  assert.equal((await docker('exec', CONTAINER, 'id', '-u')).stdout, '1000\n');
});

/** A POST as client 2.0.0 sent it: its headers and its JSON-RPC body. */
type CapturedRequest = { headers: [string, string][]; body: string };

/** The POSTs client 2.0.0 sends while it connects with options, keyed by JSON-RPC method. */
async function captureConnect(options: ClientOptions): Promise<Map<string, CapturedRequest>> {
  const captured = new Map<string, CapturedRequest>();
  // connect() sends notifications/initialized without its signal, so every fetch carries this one as well.
  const signal = AbortSignal.timeout(REQUEST_MS);
  const transport = new StreamableHTTPClientTransport(endpoint(), {
    fetch: async (input, init) => {
      if (init?.method === 'POST') {
        const body = init.body;
        assert.ok(typeof body === 'string', 'client 2.0.0 sends a JSON-RPC body as a string');
        const message: unknown = JSON.parse(body);
        assert.ok(isObject(message) && 'method' in message && typeof message.method === 'string', `no method: ${body}`);
        captured.set(message.method, { headers: [...new Headers(init.headers)], body });
      }
      return fetch(input, { ...init, signal: AbortSignal.any(init?.signal ? [init.signal, signal] : [signal]) });
    },
  });
  const client = new Client({ name: 'mcp.tibia.sh replay', version: '1.0.0' }, options);
  try {
    await client.connect(transport, { signal });
  } finally {
    await client.close();
  }
  return captured;
}

/** Sends a captured request again with raw fetch, and reads the whole response. */
async function replay(requests: Map<string, CapturedRequest>, method: string) {
  const request = requests.get(method);
  assert.ok(request, `client 2.0.0 sent no ${method} while connecting`);
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  return { response, text: await response.text() };
}

/** The result of a successful JSON-RPC response. */
function resultOf(message: unknown): object {
  assert.ok(
    isObject(message) && 'result' in message && isObject(message.result),
    `not a JSON-RPC result: ${JSON.stringify(message)}`,
  );
  return message.result;
}

/** The JSON-RPC message of a one-event text/event-stream body, parsed from its data: line. */
function eventStreamMessage(text: string): unknown {
  const [line, ...more] = text.split(/\r?\n/).filter((candidate) => candidate.startsWith('data:'));
  assert.ok(line !== undefined && more.length === 0, `expected exactly one data: line, got: ${text}`);
  return JSON.parse(line.slice('data:'.length));
}

test('a legacy initialize replays harmlessly', async () => {
  const requests = await captureConnect({});
  const answers = [await replay(requests, 'initialize'), await replay(requests, 'initialize')];
  const [first, second] = answers.map(({ response, text }) => {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), null);
    const result = resultOf(eventStreamMessage(text));
    assert.ok('serverInfo' in result && isObject(result.serverInfo), `initialize answered without serverInfo: ${text}`);
    return result.serverInfo;
  });
  assert.deepEqual(second, first);
});

test('a legacy notifications/initialized replays harmlessly', async () => {
  const requests = await captureConnect({});
  const answers = [
    await replay(requests, 'notifications/initialized'),
    await replay(requests, 'notifications/initialized'),
  ];
  assert.deepEqual(
    answers.map(({ response }) => response.status),
    [202, 202],
  );
});

test('a modern server/discover replays harmlessly', async () => {
  const requests = await captureConnect({ versionNegotiation: { mode: 'auto' } });
  const answers = [await replay(requests, 'server/discover'), await replay(requests, 'server/discover')];
  assert.deepEqual(
    answers.map(({ response }) => response.status),
    [200, 200],
  );
  const [first, second] = answers.map(({ text }) => resultOf(JSON.parse(text)));
  assert.deepEqual(second, first);
});
