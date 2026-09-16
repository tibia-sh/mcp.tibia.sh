/**
 * The Worker's request policy: what it answers itself, what reaches the container, which CORS headers each
 * resource's answers carry, how the rate limit is keyed and charged, and how a failed container fetch is retried.
 *
 * The Worker applies it in this order: route, checkHeaders, readCapped, checkContentType, checkJsonRpcShape,
 * then rateLimitKey and chargeRateLimit, then forwardWithRetry. The first check that rejects a request decides
 * the answer.
 *
 * Every function works only on its arguments and on the functions it is handed, with web-standard APIs, so
 * the same code runs in the Workers runtime and under node:test.
 */

/** The largest request body the Worker accepts, in bytes. */
export const MAX_BODY_BYTES = 65_536;

/** The pause before the one retry of a failed container fetch. */
export const RETRY_DELAY_MS = 500;

/** The Retry-After of a rate-limited request, in seconds: the rate limit's period. */
export const RATE_LIMITED_RETRY_AFTER = '60';

/** The Retry-After of the 503 that follows a failed retry, in seconds. */
export const UNAVAILABLE_RETRY_AFTER = '5';

/** A whole CORS header set, which the Worker sets on every answer of one resource. */
export type CorsHeaders = Readonly<Record<string, string>>;

/**
 * The CORS headers of the MCP endpoint, on every answer of /wiki and /wiki/ but the landing page: the container's
 * responses, the Worker's own rejections and 503, the 405 and the preflight.
 *
 * Any origin is allowed, because the Worker keeps no state and no credentials, so a cross-site request can do
 * nothing a curl cannot, except spend the visitor's own rate-limit allowance. With the origin a wildcard there is
 * no per-origin echo and no Vary. The wildcard in Allow-Headers covers every header the SDK's browser client
 * sends. Retry-After is exposed so a browser client can read it on a 429 or 503.
 */
export const ENDPOINT_CORS: CorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Access-Control-Max-Age': '86400',
};

/** What a 405 names in Allow: the methods its resource answers. */
export type Allow = 'GET, POST, OPTIONS' | 'GET, OPTIONS';

/**
 * Where route sends a request: the landing page, the MCP endpoint, a CORS preflight, or an answer of 404 or
 * 405. A preflight and a 405 carry the CORS headers of their resource.
 */
export type Route =
  | { kind: 'landing' }
  | { kind: 'mcp' }
  | { kind: 'preflight'; cors: CorsHeaders }
  | { kind: 'reject'; status: 404 }
  | { kind: 'reject'; status: 405; allow: Allow; cors: CorsHeaders };

/** A request the Worker answers itself, with a short text/plain body. */
export type Rejection = { status: 400 | 413 | 415; body: string };

/** How many JSON-RPC messages a body of the accepted shape holds, or its rejection. */
export type Shape = { ok: true; messages: number } | { ok: false; rejection: Rejection };

/** The answer to a body over MAX_BODY_BYTES, whether its declared length or its stream is over. */
export const PAYLOAD_TOO_LARGE: Rejection = { status: 413, body: 'Payload Too Large' };

const UNSUPPORTED_MEDIA_TYPE: Rejection = { status: 415, body: 'Unsupported Media Type' };

const BAD_REQUEST: Rejection = { status: 400, body: 'Bad Request' };

/**
 * Where a request goes.
 *
 * - POST on /wiki or /wiki/ is the MCP endpoint, served without a redirect, because redirecting a POST breaks
 *   clients.
 * - OPTIONS on /wiki or /wiki/ is a CORS preflight, which the Worker answers with the endpoint's CORS headers.
 *   A browser sends one before its first MCP request.
 * - GET or HEAD on /, /wiki or /wiki/ with an Accept containing text/html is the landing page.
 * - Any other method on /wiki or /wiki/, a non-HTML GET included, is 405 with the endpoint's CORS headers.
 * - Every other path is 404. That includes the OAuth discovery paths, so connector clients read the server as
 *   needing no auth.
 *
 * Paths match exactly and case-sensitively.
 */
export function route(method: string, pathname: string, accept: string | null): Route {
  const wiki = pathname === '/wiki' || pathname === '/wiki/';
  if (wiki && method === 'POST') return { kind: 'mcp' };
  if (wiki && method === 'OPTIONS') return { kind: 'preflight', cors: ENDPOINT_CORS };
  if ((wiki || pathname === '/') && (method === 'GET' || method === 'HEAD') && accept?.includes('text/html')) {
    return { kind: 'landing' };
  }
  return wiki
    ? { kind: 'reject', status: 405, allow: 'GET, POST, OPTIONS', cors: ENDPOINT_CORS }
    : { kind: 'reject', status: 404 };
}

/**
 * The checks that need only the headers.
 *
 * - A declared Content-Length above MAX_BODY_BYTES is 413. A missing length reads as 0 and one that does not
 *   parse as NaN, and neither is above the cap, so readCapped decides.
 */
export function checkHeaders(headers: Headers): Rejection | null {
  if (Number(headers.get('content-length')) > MAX_BODY_BYTES) return PAYLOAD_TOO_LARGE;
  return null;
}

/**
 * The whole body, or null as soon as the stream grows past limit bytes. Then it stops reading and cancels the
 * stream without waiting on the cancel, which a stream may reject or never settle. A null body is empty.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit: number = MAX_BODY_BYTES,
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative integer');
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The media type must be application/json, compared case-insensitively with any parameters ignored. Anything
 * else, a missing header included, is 415.
 */
export function checkContentType(headers: Headers): Rejection | null {
  const mediaType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' ? null : UNSUPPORTED_MEDIA_TYPE;
}

/**
 * A JSON object with jsonrpc "2.0" is 1 message, and a non-empty array of such objects is one message per
 * element. Anything else, invalid JSON included, is 400.
 *
 * The check is never stricter than the MCP SDK behind it. The SDK handles every element of a batch, so
 * batches pass. The body is decoded as request.json() decodes it, so a byte order mark and invalid UTF-8
 * inside a string pass as well. An empty batch is 400, as in the SDK: JSON-RPC 2.0 calls it an invalid
 * request, and it would charge the rate limit nothing.
 */
export function checkJsonRpcShape(body: Uint8Array): Shape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, rejection: BAD_REQUEST };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length > 0 && parsed.every(isJsonRpcMessage)) return { ok: true, messages: parsed.length };
  } else if (isJsonRpcMessage(parsed)) {
    return { ok: true, messages: 1 };
  }
  return { ok: false, rejection: BAD_REQUEST };
}

function isJsonRpcMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'jsonrpc' in value && value.jsonrpc === '2.0';
}

/** A dotted-quad IPv4 address: four decimal octets from 0 to 255, without leading zeros. */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * The rate-limit key of a client IP.
 *
 * - An IPv4 address is its own key.
 * - An IPv6 address is keyed by its /64, as `<h1>:<h2>:<h3>:<h4>::/64` in lowercase without leading zeros.
 *   One host commonly holds a whole /64, and could otherwise take a fresh address per request.
 * - An IPv4-mapped IPv6 address, `::ffff:a.b.c.d`, is keyed as `a.b.c.d`.
 * - Anything else throws, because the platform sets CF-Connecting-IP. The message never quotes the value.
 */
export function rateLimitKey(ip: string): string {
  if (IPV4.test(ip)) return ip;
  const address = ipv6Address(ip);
  if (address === null) throw new TypeError('rateLimitKey needs an IPv4 or IPv6 address');
  // The IPv4-mapped addresses are ::ffff:0:0/96.
  if ((address >> 32n) === 0xffffn) {
    const ipv4 = Number(address & 0xffffffffn);
    return [24, 16, 8, 0].map((shift) => (ipv4 >>> shift) & 0xff).join('.');
  }
  const hextets = [112n, 96n, 80n, 64n].map((shift) => ((address >> shift) & 0xffffn).toString(16));
  return `${hextets.join(':')}::/64`;
}

/** An IPv6 address as a 128-bit number, or null when ip is not one. */
function ipv6Address(ip: string): bigint | null {
  // With only these characters, all of ip stays between the brackets, where the URL parser accepts exactly
  // one IPv6 address. It serializes the address as hex pieces with at most one "::", and an embedded IPv4
  // address as two pieces.
  if (!/^[\da-f:.]+$/i.test(ip)) return null;
  let host: string;
  try {
    host = new URL(`http://[${ip}]/`).hostname;
  } catch {
    return null;
  }
  const [head = '', tail = ''] = host.slice(1, -1).split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const pieces = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return BigInt(`0x${pieces.map((piece) => piece.padStart(4, '0')).join('')}`);
}

/**
 * Charges the rate limit once per JSON-RPC message, one call at a time, because the SDK handles every element
 * of a batch. It returns false at the first call that fails, without further calls, and true when every call
 * succeeds.
 */
export async function chargeRateLimit(
  limit: (options: { key: string }) => Promise<{ success: boolean }>,
  key: string,
  messages: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(messages) || messages < 1) throw new RangeError('messages must be a positive integer');
  for (let call = 0; call < messages; call += 1) {
    const { success } = await limit({ key });
    if (!success) return false;
  }
  return true;
}

/** Whether a container fetch is retried: after a throw, or a status of 500 or above. */
export function shouldRetry(outcome: { threw: true } | { status: number }): boolean {
  return 'threw' in outcome || outcome.status >= 500;
}

/**
 * Sends the buffered body to the container, and sends it once more after RETRY_DELAY_MS when send throws or
 * answers with a status of 500 or above. The container proxy returns its own failures as 500 responses, so a
 * 5xx retries as well as a throw. The second response is returned whatever its status. When the second send
 * throws too, the answer is 503 with Retry-After.
 *
 * Replaying a request is safe, because every tool is read-only and the server keeps no session. The log lines
 * never carry an error message, which can quote the request.
 */
export async function forwardWithRetry(
  body: Uint8Array,
  send: (body: Uint8Array) => Promise<Response>,
  sleep: (ms: number) => Promise<void>,
  log: Pick<Console, 'warn' | 'error'> = console,
): Promise<Response> {
  let first: Response | null = null;
  try {
    first = await send(body);
  } catch {
    // A throw leaves first null, which retries.
  }
  if (first !== null && !shouldRetry({ status: first.status })) return first;
  log.warn(`container fetch failed, retrying: ${first === null ? 'threw' : `status ${first.status}`}`);
  // The body is discarded either way, so the retry does not wait on a cancel that may reject or never settle.
  void first?.body?.cancel().catch(() => {});
  await sleep(RETRY_DELAY_MS);
  try {
    return await send(body);
  } catch {
    log.error('answering 503 after retry');
    return new Response('Service Unavailable', { status: 503, headers: { 'Retry-After': UNAVAILABLE_RETRY_AFTER } });
  }
}
