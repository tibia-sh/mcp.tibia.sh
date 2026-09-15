/**
 * The Worker in front of the TibiaWiki MCP container.
 *
 * It answers everything except an MCP-shaped POST /wiki itself, so none of that wakes the container. The checks
 * run in spec 5.2's order, and the first one that rejects a request decides the answer. src/policy.ts holds every
 * decision, and test/wiring.test.ts checks that this file applies them in order.
 */
import { Container, getContainer } from '@cloudflare/containers';
import { landingPage } from './landing.ts';
import {
  chargeRateLimit,
  checkContentType,
  checkHeaders,
  checkJsonRpcShape,
  forwardWithRetry,
  PAYLOAD_TOO_LARGE,
  RATE_LIMITED_RETRY_AFTER,
  rateLimitKey,
  readCapped,
  route,
} from './policy.ts';
import type { Rejection } from './policy.ts';

export class TibiaWikiMcp extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = false;
  pingEndpoint = "container/ping";
}

/** A rejection as a short text/plain answer. */
function reject({ status, body }: Rejection): Response {
  return new Response(body, { status });
}

export default {
  async fetch(request, env): Promise<Response> {
    const decision = route(request.method, new URL(request.url).pathname, request.headers.get('accept'));
    if (decision.kind === 'reject') {
      const { status, allow } = decision;
      return new Response(status === 405 ? 'Method Not Allowed' : 'Not Found', {
        status,
        headers: allow === undefined ? {} : { Allow: allow },
      });
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
      return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': RATE_LIMITED_RETRY_AFTER } });
    }

    // Container.fetch takes its port from cf-container-target-port, so no client may choose it. The buffered body
    // goes out with a Content-Length, which the server requires, so a chunked request's Transfer-Encoding stays
    // behind. workerd drops a copied one as well, but does not document that. The container serves MCP at /mcp and
    // takes no query string.
    const headers = new Headers(request.headers);
    headers.delete('cf-container-target-port');
    headers.delete('transfer-encoding');
    const target = new URL('/mcp', request.url);
    return forwardWithRetry(
      body,
      // Each attempt gets its own copy of the bytes and a fresh stub, so a failed first attempt leaves nothing
      // the retry depends on.
      (bytes) => getContainer(env.MCP).fetch(new Request(target, { method: 'POST', headers, body: bytes.slice() })),
      (ms) => scheduler.wait(ms),
    );
  },
} satisfies ExportedHandler<Env>;
