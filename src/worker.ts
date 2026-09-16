/**
 * The Worker in front of the TibiaWiki MCP container.
 *
 * It answers everything except an MCP-shaped POST /wiki itself, so none of that wakes the container. The checks
 * run in spec 5.2's order, and the first one that rejects a request decides the answer. Every answer of the
 * endpoint but the landing page carries the endpoint's CORS headers, and every answer of the server card the
 * card's, so a browser client can read them. src/policy.ts holds every decision, and test/wiring.test.ts checks
 * that this file applies them in order.
 */
import { Container, getContainer } from '@cloudflare/containers';
import { landingPage } from './landing.ts';
import {
  CARD_CORS,
  chargeClient,
  checkContentType,
  checkHeaders,
  checkJsonRpcShape,
  ENDPOINT_CORS,
  forwardWithRetry,
  notModified,
  PAYLOAD_TOO_LARGE,
  RATE_LIMITED_RETRY_AFTER,
  readCapped,
  route,
} from './policy.ts';
import type { CorsHeaders, Rejection } from './policy.ts';
import { SERVER_CARD, SERVER_CARD_CACHE_CONTROL, SERVER_CARD_TYPE } from './server-card.ts';

export class TibiaWikiMcp extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = false;
  pingEndpoint = "container/ping";
}

/** The same headers with every header of cors set on them, each replacing one of the same name. */
function withCors(headers: Headers, cors: CorsHeaders): Headers {
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return headers;
}

/** A rejection as a short text/plain answer of the endpoint, with its CORS headers. */
function reject({ status, body }: Rejection): Response {
  return new Response(body, { status, headers: withCors(new Headers(), ENDPOINT_CORS) });
}

/** The answer of a rate-limited request, with the CORS headers of the resource it asked for. */
function tooManyRequests(cors: CorsHeaders): Response {
  return new Response('Too Many Requests', {
    status: 429,
    headers: withCors(new Headers({ 'Retry-After': RATE_LIMITED_RETRY_AFTER }), cors),
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const decision = route(request.method, new URL(request.url).pathname, request.headers.get('accept'));
    if (decision.kind === 'reject') {
      if (decision.status === 404) return new Response('Not Found', { status: 404 });
      const { allow, cors } = decision;
      return new Response('Method Not Allowed', {
        status: 405,
        headers: withCors(new Headers({ Allow: allow }), cors),
      });
    }
    if (decision.kind === 'preflight') {
      return new Response(null, { status: 204, headers: withCors(new Headers(), decision.cors) });
    }
    if (decision.kind === 'landing') {
      // A HEAD gets the same headers and no body.
      return new Response(request.method === 'HEAD' ? null : landingPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'x-deploy-commit': env.DEPLOY_COMMIT },
      });
    }
    if (decision.kind === 'card') return serveCard(request, env);

    const headerRejection = checkHeaders(request.headers);
    if (headerRejection !== null) return reject(headerRejection);
    const body = await readCapped(request.body);
    if (body === null) return reject(PAYLOAD_TOO_LARGE);
    const typeRejection = checkContentType(request.headers);
    if (typeRejection !== null) return reject(typeRejection);
    const shape = checkJsonRpcShape(body);
    if (!shape.ok) return reject(shape.rejection);

    // A missing CF-Connecting-IP is a fault: the charge throws, and the platform answers 500 with no CORS headers.
    const ip = request.headers.get('cf-connecting-ip');
    if (!(await chargeClient((options) => env.RATE_LIMITER.limit(options), ip, shape.messages))) {
      return tooManyRequests(ENDPOINT_CORS);
    }

    // The forwarded request leaves three headers behind:
    // - cf-container-target-port, because Container.fetch takes its port from it, so no client may choose it.
    // - Transfer-Encoding, because the buffered body goes out with a Content-Length, which the server requires.
    //   workerd drops a copied one as well, but does not document that.
    // - Expect, because the body is already whole. Forwarded, Expect: 100-continue makes the server answer
    //   100 Continue, which the container proxy cannot turn into a response, and the request gets 500.
    // The container serves MCP at /mcp and takes no query string.
    const headers = new Headers(request.headers);
    headers.delete('cf-container-target-port');
    headers.delete('transfer-encoding');
    headers.delete('expect');
    const target = new URL('/mcp', request.url);
    const response = await forwardWithRetry(
      body,
      // Each attempt gets its own copy of the bytes and a fresh stub, so a failed first attempt leaves nothing
      // the retry depends on.
      (bytes) => getContainer(env.MCP).fetch(new Request(target, { method: 'POST', headers, body: bytes.slice() })),
      (ms) => scheduler.wait(ms),
    );
    // A fetched Response has immutable headers, so the container's answer, or the 503 in its place, goes out
    // re-wrapped: the same status, status text and streamed body, with the CORS headers set on a copy of its
    // headers. The container's server sets none of its own.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: withCors(new Headers(response.headers), ENDPOINT_CORS),
    });
  },
} satisfies ExportedHandler<Env>;

/**
 * The server card: one unit of the rate limit, then 304 when the request's If-None-Match names this deploy's
 * tag, otherwise the document, or its headers alone for a HEAD. The tag is the deploy commit in double quotes, a
 * strong validator, because the document depends on nothing but the bundled constants. Every answer carries the
 * card's CORS headers. The 304 carries the tag and Cache-Control but not the document's Content-Type, as RFC 9110
 * section 15.4.5 asks: a 304 sends no representation, and only the headers that update a cached one.
 */
async function serveCard(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip');
  if (!(await chargeClient((options) => env.RATE_LIMITER.limit(options), ip, 1))) return tooManyRequests(CARD_CORS);
  const etag = `"${env.DEPLOY_COMMIT}"`;
  const headers = withCors(new Headers({ 'Cache-Control': SERVER_CARD_CACHE_CONTROL, ETag: etag }), CARD_CORS);
  if (notModified(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
  headers.set('Content-Type', SERVER_CARD_TYPE);
  return new Response(request.method === 'HEAD' ? null : SERVER_CARD, { headers });
}
