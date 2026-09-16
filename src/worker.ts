/**
 * The Worker in front of the TibiaWiki MCP container.
 *
 * It answers everything except an MCP-shaped POST /wiki itself, so none of that wakes the container. The checks
 * run in spec 5.2's order, and the first one that rejects a request decides the answer. Every answer of the
 * endpoint but the landing page carries the endpoint's CORS headers, so a browser client can read it.
 * src/policy.ts holds every decision, and test/wiring.test.ts checks that this file applies them in order.
 */
import { Container, getContainer } from '@cloudflare/containers';
import { landingPage } from './landing.ts';
import {
  chargeRateLimit,
  checkContentType,
  checkHeaders,
  checkJsonRpcShape,
  ENDPOINT_CORS,
  forwardWithRetry,
  PAYLOAD_TOO_LARGE,
  RATE_LIMITED_RETRY_AFTER,
  rateLimitKey,
  readCapped,
  route,
} from './policy.ts';
import type { CorsHeaders, Rejection } from './policy.ts';

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

    const headerRejection = checkHeaders(request.headers);
    if (headerRejection !== null) return reject(headerRejection);
    const body = await readCapped(request.body);
    if (body === null) return reject(PAYLOAD_TOO_LARGE);
    const typeRejection = checkContentType(request.headers);
    if (typeRejection !== null) return reject(typeRejection);
    const shape = checkJsonRpcShape(body);
    if (!shape.ok) return reject(shape.rejection);

    // The platform sets CF-Connecting-IP on every request, so a missing one is a fault, answered with a 500.
    const ip = request.headers.get('cf-connecting-ip');
    if (ip === null) throw new Error('the request has no CF-Connecting-IP header');
    const key = rateLimitKey(ip);
    if (!(await chargeRateLimit((options) => env.RATE_LIMITER.limit(options), key, shape.messages))) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: withCors(new Headers({ 'Retry-After': RATE_LIMITED_RETRY_AFTER }), ENDPOINT_CORS),
      });
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
