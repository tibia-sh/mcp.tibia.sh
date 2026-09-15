/**
 * The Worker end to end, in `wrangler dev` with local containers.
 *
 * - Everything the Worker answers itself leaves the container asleep: the landing page, 404, 405, 403, 413, 415
 *   and 400. The 403, 413 and 415 requests also break later rules, so they prove the order of the checks too. The
 *   test counts this session's dev containers when wrangler is ready and after those checks.
 * - MCP requests reach the container, which serves the pinned artifact. A chunked request reaches it as well,
 *   which proves that the forwarded request carries Content-Length (spec 12, item 4).
 * - The rate limit is charged once per JSON-RPC message.
 *
 * wrangler runs without Cloudflare credentials, and keeps its local state in a directory of its own. Miniflare
 * stores the rate limiter's count there, so a session that shared .wrangler/state with an earlier one in the same
 * minute would start with the limit spent.
 *
 * When wrangler stops, it removes its dev containers but leaves their -proxy sidecars running and the image it
 * built. Cleanup stops wrangler, then removes this session's containers and sidecars, its dev image and its state
 * directory: after the tests, after a failed setup, when wrangler exited by itself, and on SIGINT or SIGTERM.
 *
 * Run it without another wrangler dev session of this Worker beside it. Both sessions' containers get the same
 * names, so workerd replaces the other session's containers, and wrangler removes its older dev image tag.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { after, afterEach, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { credentialFreeEnv } from '../scripts/check-config.ts';
import { deployedCommit, expectedArtifact, mismatches, probe } from '../scripts/served-artifact.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** How long wrangler dev may take to build the image and print "Ready on". A cold CI runner pulls both images. */
const READY_MS = 300_000;
/** How long each request may take, a container's cold start included. */
const REQUEST_MS = 60_000;
/** How long wrangler's processes may take to exit after SIGINT, and then after SIGKILL. */
const STOP_MS = 15_000;
/** How long one docker command may take, so a stuck daemon fails the setup or the cleanup instead of hanging it. */
const DOCKER_MS = 60_000;
/** The repository wrangler dev tags this Worker's container image with: the class name in lowercase. */
const DEV_IMAGE = 'cloudflare-dev/tibiawikimcp';
/**
 * How workerd names this Worker's dev containers and their sidecars: workerd-<Worker>-<class>-<Durable Object ID>,
 * and the same with -proxy.
 */
const DEV_CONTAINER_NAME = 'workerd-mcp-tibia-sh-TibiaWikiMcp-';

/** The headers of a legacy MCP POST. The server answers 406 unless Accept holds both media types. */
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const TOOLS_LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
/** One byte over the Worker's body cap, and never more (see the 413 test). */
const OVERSIZED = new Uint8Array(65_537).fill(0x20);

let wrangler: ChildProcessByStdio<null, Readable, Readable> | undefined;
let spawnError: Error | undefined;
/** The directory wrangler keeps this session's local state in. */
let stateDir: string | undefined;
/** Everything wrangler printed, for failure messages. */
let output = '';
/** The dev server, once wrangler is ready. */
let origin: URL | undefined;
/** The container IDs and dev image tags that existed before wrangler started. None of them is this session's. */
let containersBefore: Set<string> | undefined;
let imageTagsBefore: Set<string> | undefined;
/** This session's dev containers when wrangler became ready. */
let containersAtReady: string[] | undefined;
let anyTestFailed = false;

/**
 * Runs a docker command from the repo root and returns its trimmed stdout. A failure's message carries the
 * command's stderr. Synchronous, so the signal handlers can use it.
 */
function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    cwd: REPO_ROOT,
    env: credentialFreeEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DOCKER_MS,
  }).trim();
}

function lines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** Every tag of the dev image repository, as name:tag. */
function devImageTags(): string[] {
  return lines(docker('images', '--filter', `reference=${DEV_IMAGE}`, '--format', '{{.Repository}}:{{.Tag}}'));
}

/** The dev image tags wrangler built in this session. */
function sessionImageTags(): string[] {
  const before = imageTagsBefore;
  return before === undefined ? [] : devImageTags().filter((tag) => !before.has(tag));
}

/**
 * This session's dev containers and their -proxy sidecars: the containers named for this Worker's class that did
 * not exist before wrangler started. A sidecar keeps its name after wrangler removes its container.
 */
function sessionContainers(): string[] {
  const before = containersBefore;
  if (before === undefined) return [];
  const named = lines(docker('ps', '--all', '--quiet', '--no-trunc', '--filter', `name=^${DEV_CONTAINER_NAME}`));
  return named.filter((id) => !before.has(id));
}

/**
 * Removes this session's containers, then its dev image, which nothing uses any more, then its state directory.
 * Each step runs even when an earlier one failed, and the failures are thrown together at the end.
 */
function removeSessionArtifacts(): void {
  const steps = [
    () => {
      const containers = sessionContainers();
      if (containers.length > 0) docker('rm', '--force', ...containers);
    },
    () => {
      const tags = sessionImageTags();
      if (tags.length > 0) docker('image', 'rm', ...tags);
    },
    () => {
      if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
    },
  ];
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'the cleanup of this wrangler dev session failed');
}

/** Signals every process in wrangler's process group: npx, wrangler and workerd. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Polls until no process of the group runs, and says whether that happened within ms. */
async function groupExits(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    if (Date.now() > deadline) return false;
    await delay(100);
  }
}

/** Stops wrangler as Ctrl-C would, and kills its processes if they outlive STOP_MS. */
async function stopWrangler(pgid: number): Promise<void> {
  signalGroup(pgid, 'SIGINT');
  if (await groupExits(pgid, STOP_MS)) return;
  signalGroup(pgid, 'SIGKILL');
  if (!(await groupExits(pgid, STOP_MS))) throw new Error(`wrangler's process group ${pgid} outlived SIGKILL`);
}

// A signal ends this process without running after(), so the handler cleans up by itself, synchronously. wrangler
// gets SIGKILL, so its own cleanup cannot race this one. Ctrl-C sends SIGINT here, and the test runner passes
// SIGTERM on.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.once(signal, () => {
    try {
      if (wrangler?.pid !== undefined) signalGroup(wrangler.pid, 'SIGKILL');
      removeSessionArtifacts();
    } catch (error) {
      console.error(`cleanup after ${signal}:`, error);
    } finally {
      process.exit(code);
    }
  });
}

/** A free port on 127.0.0.1, released for wrangler to take. */
async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the port probe has no address');
  server.close();
  await once(server, 'close');
  return address.port;
}

before(async () => {
  imageTagsBefore = new Set(devImageTags());
  containersBefore = new Set(lines(docker('ps', '--all', '--quiet', '--no-trunc')));
  const port = await freePort();
  stateDir = mkdtempSync(join(tmpdir(), 'mcp-tibia-sh-wrangler-dev-'));
  const args = ['dev', '--ip', '127.0.0.1', '--port', String(port), '--show-interactive-dev-session=false'];
  // In its own process group, so cleanup can signal npx and every process it started at once.
  const child = spawn('npx', ['wrangler', ...args, '--persist-to', stateDir], {
    cwd: REPO_ROOT,
    env: credentialFreeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  wrangler = child;
  child.on('error', (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
  }
  const deadline = Date.now() + READY_MS;
  while (!output.includes('Ready on')) {
    if (spawnError !== undefined) throw new Error(`npx wrangler dev did not start: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`wrangler dev exited before it was ready:\n${output}`);
    }
    if (Date.now() > deadline) throw new Error(`wrangler dev was not ready within ${READY_MS / 1000} s:\n${output}`);
    await delay(100);
  }
  origin = new URL(`http://127.0.0.1:${port}`);
  containersAtReady = sessionContainers();
});

afterEach((t) => {
  if (!t.passed) anyTestFailed = true;
});

after(async () => {
  try {
    if (wrangler?.pid !== undefined) await stopWrangler(wrangler.pid);
  } finally {
    removeSessionArtifacts();
    if (anyTestFailed) process.stderr.write(`wrangler dev printed:\n${output}\n`);
  }
});

/** The dev server's origin. */
function devServer(): URL {
  assert.ok(origin, 'wrangler dev is not ready');
  return origin;
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(path, devServer()), { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
}

/**
 * What the tests compare about an answer: its status, whether it is text/plain, Allow, Retry-After and the body.
 * The Worker's own bodies are short, so a longer body is cut to keep a failure readable.
 */
async function summary(response: Response) {
  const body = await response.text();
  return {
    status: response.status,
    textPlain: /^text\/plain(;|$)/.test(response.headers.get('content-type') ?? ''),
    allow: response.headers.get('allow'),
    retryAfter: response.headers.get('retry-after'),
    body: body.length > 200 ? `${body.slice(0, 200)}... (${body.length} characters)` : body,
  };
}

/** The summary of an answer the Worker gives by itself. */
function workerAnswer(status: number, body: string, headers: { allow?: string; retryAfter?: string } = {}) {
  return { status, textPlain: true, allow: headers.allow ?? null, retryAfter: headers.retryAfter ?? null, body };
}

/**
 * A POST whose body has no declared length, so fetch sends it with Transfer-Encoding: chunked, in pieces of at
 * most size bytes.
 */
function postChunked(path: string, headers: Record<string, string>, bytes: Uint8Array, size: number) {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + size));
      offset += size;
    },
  });
  // Node's fetch requires duplex with a stream body, and the DOM type of RequestInit has no such field.
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body, duplex: 'half' };
  return request(path, init);
}

/**
 * The raw answer to a HEAD request, read until wrangler closes the connection. fetch never reads a body after a
 * HEAD, so only the bytes on the wire can show whether one was sent.
 */
function rawHead(path: string): Promise<string> {
  const { host, hostname, port } = devServer();
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname);
    const chunks: Buffer[] = [];
    socket.setTimeout(REQUEST_MS, () => {
      socket.destroy(new Error(`HEAD ${path} did not end within ${REQUEST_MS / 1000} s`));
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', reject);
    socket.write(`HEAD ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: text/html\r\nConnection: close\r\n\r\n`);
  });
}

test('the landing page answers GET on / and /wiki, and HEAD on /, with the deployed commit', async () => {
  for (const path of ['/', '/wiki']) {
    const response = await request(path, { headers: { accept: 'text/html' } });
    const body = await response.text();
    assert.deepEqual(
      {
        status: response.status,
        contentType: response.headers.get('content-type'),
        commit: response.headers.get('x-deploy-commit'),
        namesTheUrl: body.includes('https://mcp.tibia.sh/wiki'),
      },
      { status: 200, contentType: 'text/html; charset=utf-8', commit: 'local', namesTheUrl: true },
      `GET ${path}`,
    );
  }

  // Spec 12, item 5: the answer ends with its headers.
  const answer = await rawHead('/');
  const end = answer.indexOf('\r\n\r\n');
  assert.notEqual(end, -1, `the HEAD answer never ends its headers: ${JSON.stringify(answer)}`);
  const [statusLine = '', ...fields] = answer.slice(0, end).split('\r\n');
  const headers = new Headers();
  for (const field of fields) {
    const colon = field.indexOf(':');
    headers.append(field.slice(0, colon), field.slice(colon + 1).trim());
  }
  assert.deepEqual(
    {
      status: statusLine.split(' ')[1],
      contentType: headers.get('content-type'),
      commit: headers.get('x-deploy-commit'),
      afterHeaders: answer.slice(end + 4),
    },
    { status: '200', contentType: 'text/html; charset=utf-8', commit: 'local', afterHeaders: '' },
    `HEAD /: ${JSON.stringify(answer)}`,
  );

  assert.equal(await deployedCommit(new URL('/wiki', devServer()), AbortSignal.timeout(REQUEST_MS)), 'local');
});

test('unknown paths and POST / are 404', async () => {
  const requests: [label: string, path: string, init: RequestInit][] = [
    ['GET /robots.txt', '/robots.txt', { headers: { accept: 'text/html' } }],
    [
      'GET /.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource',
      { headers: { accept: 'application/json' } },
    ],
    ['POST /', '/', { method: 'POST', headers: MCP_HEADERS, body: TOOLS_LIST }],
  ];
  for (const [label, path, init] of requests) {
    assert.deepEqual(await summary(await request(path, init)), workerAnswer(404, 'Not Found'), label);
  }
});

test('GET without an HTML Accept, DELETE and PUT on /wiki are 405 with Allow: GET, POST', async () => {
  // fetch sends Accept: */* when none is set.
  for (const method of ['GET', 'DELETE', 'PUT']) {
    assert.deepEqual(
      await summary(await request('/wiki', { method })),
      workerAnswer(405, 'Method Not Allowed', { allow: 'GET, POST' }),
      method,
    );
  }
});

test('a POST with Origin is 403, even when it also breaks the size and content type rules', async () => {
  const browser = { origin: 'https://example.com' };
  const valid = await request('/wiki', { method: 'POST', headers: { ...MCP_HEADERS, ...browser }, body: TOOLS_LIST });
  assert.deepEqual(await summary(valid), workerAnswer(403, 'Forbidden'), 'a tools/list with Origin');
  const invalid = await request('/wiki', {
    method: 'POST',
    headers: { ...browser, 'content-type': 'text/plain' },
    body: OVERSIZED,
  });
  assert.deepEqual(await summary(invalid), workerAnswer(403, 'Forbidden'), 'an oversized text/plain body with Origin');
});

test('a body over 65,536 bytes is 413, declared or chunked, even with the wrong content type', async () => {
  // Exactly one byte over. In wrangler dev, a 413 answered without draining a larger chunked upload breaks the
  // next pooled request with 500 Network connection lost, which is an artifact of the dev proxy.
  const textPlain = { 'content-type': 'text/plain' };
  const declared = await request('/wiki', { method: 'POST', headers: textPlain, body: OVERSIZED });
  assert.deepEqual(await summary(declared), workerAnswer(413, 'Payload Too Large'), 'Content-Length: 65537');
  const streamed = await postChunked('/wiki', textPlain, OVERSIZED, 16_384);
  assert.deepEqual(await summary(streamed), workerAnswer(413, 'Payload Too Large'), 'a chunked 65,537-byte body');
});

test('a content type other than application/json is 415, and a body that is not JSON-RPC is 400', async () => {
  const textPlain = { 'content-type': 'text/plain' };
  const wrongType = await request('/wiki', { method: 'POST', headers: textPlain, body: 'not json' });
  assert.deepEqual(await summary(wrongType), workerAnswer(415, 'Unsupported Media Type'), 'text/plain');
  for (const body of ['not json', '{"jsonrpc":"1.0"}']) {
    const response = await request('/wiki', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.deepEqual(await summary(response), workerAnswer(400, 'Bad Request'), body);
  }
});

test('no request so far woke a dev container', () => {
  assert.deepEqual({ atReady: containersAtReady, now: sessionContainers() }, { atReady: [], now: [] });
});

test('MCP requests reach the container, which serves the pinned artifact', async () => {
  const reports = await probe(new URL('/wiki', devServer()), AbortSignal.timeout(REQUEST_MS));
  assert.deepEqual(mismatches(reports, expectedArtifact()), []);

  // The server answers 411 to a POST without Content-Length, and 400 to one with both Content-Length and
  // Transfer-Encoding. So a 200 proves that the Worker forwarded this chunked request with Content-Length alone.
  const streamed = await postChunked('/wiki', MCP_HEADERS, new TextEncoder().encode(TOOLS_LIST), 16);
  const streamedBody = await streamed.text();
  assert.equal(streamed.status, 200, `a chunked tools/list: ${streamedBody}`);

  const targeted = await request('/wiki', {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'cf-container-target-port': '8081' },
    body: TOOLS_LIST,
  });
  const targetedBody = await targeted.text();
  assert.equal(targeted.status, 200, `a tools/list with cf-container-target-port: 8081: ${targetedBody}`);

  // The count of 0 in the test before means something only if the count can see the container these woke.
  assert.notDeepEqual(sessionContainers(), [], 'docker ps shows no dev container of this session');
});

test('the rate limit is charged once per JSON-RPC message', async () => {
  // Miniflare's rate limiter counts exactly, in fixed windows aligned to the wall-clock minute. Starting just after
  // a boundary gives the two requests below a whole window.
  const boundary = Math.ceil(Date.now() / 60_000) * 60_000;
  await delay(boundary + 500 - Date.now());
  const notifications = Array.from({ length: 300 }, () => ({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const batch = await summary(
    await request('/wiki', { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(notifications) }),
  );
  const next = await summary(await request('/wiki', { method: 'POST', headers: MCP_HEADERS, body: TOOLS_LIST }));
  const seconds = (Date.now() - boundary) / 1000;
  assert.ok(
    seconds < 55,
    `the two POSTs ended ${seconds} s into their rate-limit window, too close to the next window to show anything`,
  );
  assert.notEqual(batch.status, 429, `a batch of 300 messages, the whole limit: ${JSON.stringify(batch)}`);
  assert.deepEqual(next, workerAnswer(429, 'Too Many Requests', { retryAfter: '60' }), 'message 301');
});
