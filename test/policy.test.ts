/**
 * The Worker's request policy, one test per rule and edge.
 *
 * Expected values are literals rather than the module's constants, so a changed constant fails a test.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  chargeClient,
  chargeRateLimit,
  checkContentType,
  checkHeaders,
  checkJsonRpcShape,
  forwardWithRetry,
  notModified,
  rateLimitKey,
  readCapped,
  route,
  shouldRetry,
} from '../src/policy.ts';
import type { Route } from '../src/policy.ts';

const encoder = new TextEncoder();

/** What settledOrPending gives for a promise that is still pending. */
const PENDING = Symbol('pending');

/**
 * The value of promise, or PENDING when it is still pending at the event loop's next check phase. The streams
 * and fakes these tests hand in settle within microtasks, so PENDING means the function waits on something that
 * never settles, and the test fails at once instead of hanging.
 */
function settledOrPending<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([promise, setImmediate(PENDING)]);
}

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const MCP_ACCEPT = 'application/json, text/event-stream';

/** The CORS headers of every answer of the MCP endpoint but the landing page. */
const ENDPOINT_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Access-Control-Max-Age': '86400',
};

/** The CORS headers of every answer of the server card. */
const CARD_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
};

describe('route', () => {
  type RouteCase = [method: string, pathname: string, accept: string | null];

  /** One test per case, each expecting the same route. */
  function routes(rule: string, expected: Route, cases: RouteCase[]): void {
    describe(rule, () => {
      for (const [method, pathname, accept] of cases) {
        test(`${method} ${pathname}, Accept ${accept === null ? 'absent' : JSON.stringify(accept)}`, () => {
          assert.deepEqual(route(method, pathname, accept), expected);
        });
      }
    });
  }

  routes('POST on /wiki and /wiki/ is the MCP endpoint', { kind: 'mcp' }, [
    ['POST', '/wiki', MCP_ACCEPT],
    ['POST', '/wiki/', MCP_ACCEPT],
    ['POST', '/wiki', null],
    ['POST', '/wiki/', BROWSER_ACCEPT],
  ]);

  routes(
    'GET or HEAD on /, /wiki or /wiki/ with Accept containing text/html is the landing page',
    { kind: 'landing' },
    [
      ['GET', '/', BROWSER_ACCEPT],
      ['HEAD', '/', BROWSER_ACCEPT],
      ['GET', '/wiki', BROWSER_ACCEPT],
      ['HEAD', '/wiki', BROWSER_ACCEPT],
      ['GET', '/wiki/', 'text/html'],
      ['HEAD', '/wiki/', 'text/html'],
      ['GET', '/', 'application/xhtml+xml, text/html;q=0.9'],
    ],
  );

  routes(
    'OPTIONS on /wiki and /wiki/ is a preflight with the endpoint CORS headers',
    { kind: 'preflight', cors: ENDPOINT_CORS },
    [
      ['OPTIONS', '/wiki', null],
      ['OPTIONS', '/wiki/', null],
      ['OPTIONS', '/wiki', BROWSER_ACCEPT],
      ['OPTIONS', '/wiki/', MCP_ACCEPT],
    ],
  );

  routes(
    'any other method on /wiki or /wiki/, a non-HTML GET included, is 405 with Allow: GET, POST, OPTIONS and CORS',
    { kind: 'reject', status: 405, allow: 'GET, POST, OPTIONS', cors: ENDPOINT_CORS },
    [
      ['GET', '/wiki', null],
      ['GET', '/wiki/', MCP_ACCEPT],
      ['GET', '/wiki', '*/*'],
      ['HEAD', '/wiki', null],
      ['HEAD', '/wiki/', 'application/json'],
      ['DELETE', '/wiki', MCP_ACCEPT],
      ['DELETE', '/wiki/', null],
      ['PUT', '/wiki', null],
      ['PATCH', '/wiki/', null],
    ],
  );

  routes('GET and HEAD on /wiki/server-card are the server card, whatever the Accept', { kind: 'card' }, [
    ['GET', '/wiki/server-card', null],
    ['GET', '/wiki/server-card', 'application/mcp-server-card+json'],
    ['GET', '/wiki/server-card', BROWSER_ACCEPT],
    ['GET', '/wiki/server-card', MCP_ACCEPT],
    ['HEAD', '/wiki/server-card', null],
    ['HEAD', '/wiki/server-card', 'text/html'],
  ]);

  routes(
    'OPTIONS on /wiki/server-card is a preflight with the card CORS headers',
    { kind: 'preflight', cors: CARD_CORS },
    [
      ['OPTIONS', '/wiki/server-card', null],
      ['OPTIONS', '/wiki/server-card', BROWSER_ACCEPT],
    ],
  );

  routes(
    'any other method on /wiki/server-card is 405 with Allow: GET, OPTIONS and the card CORS headers',
    { kind: 'reject', status: 405, allow: 'GET, OPTIONS', cors: CARD_CORS },
    [
      ['POST', '/wiki/server-card', MCP_ACCEPT],
      ['POST', '/wiki/server-card', null],
      ['DELETE', '/wiki/server-card', null],
      ['PUT', '/wiki/server-card', null],
      ['PATCH', '/wiki/server-card', null],
    ],
  );

  routes('everything else is 404', { kind: 'reject', status: 404 }, [
    ['GET', '/', null],
    ['GET', '/', MCP_ACCEPT],
    ['HEAD', '/', '*/*'],
    ['POST', '/', MCP_ACCEPT],
    ['PUT', '/', BROWSER_ACCEPT],
    ['OPTIONS', '/', null],
    ['OPTIONS', '/other', null],
    ['GET', '/.well-known/oauth-protected-resource', 'application/json'],
    ['GET', '/.well-known/oauth-protected-resource/wiki', 'application/json'],
    ['GET', '/.well-known/oauth-authorization-server', 'application/json'],
    ['GET', '/.well-known/mcp/server-card', 'application/mcp-server-card+json'],
    ['GET', '/robots.txt', BROWSER_ACCEPT],
    ['POST', '/mcp', MCP_ACCEPT],
  ]);

  routes('paths match exactly and case-sensitively', { kind: 'reject', status: 404 }, [
    ['POST', '/WIKI', MCP_ACCEPT],
    ['POST', '/Wiki/', MCP_ACCEPT],
    ['GET', '/WIKI', BROWSER_ACCEPT],
    ['OPTIONS', '/WIKI', null],
    ['POST', '/wiki//', MCP_ACCEPT],
    ['OPTIONS', '/wiki//', null],
    ['POST', '/wiki/mcp', MCP_ACCEPT],
    ['POST', '/wikis', MCP_ACCEPT],
    ['GET', '//', BROWSER_ACCEPT],
    ['GET', '/wiki/server-card/', null],
    ['GET', '/wiki/Server-Card', null],
    ['OPTIONS', '/wiki/server-card/', null],
  ]);
});

describe('checkHeaders', () => {
  const PAYLOAD_TOO_LARGE = { status: 413, body: 'Payload Too Large' };

  test('an Origin header passes', () => {
    assert.equal(checkHeaders(new Headers({ origin: 'https://example.com' })), null);
  });

  test('an empty Origin header passes', () => {
    assert.equal(checkHeaders(new Headers({ origin: '' })), null);
  });

  test('a declared length of 65,536 bytes passes', () => {
    assert.equal(checkHeaders(new Headers({ 'content-length': '65536' })), null);
  });

  test('a declared length of 65,537 bytes is 413', () => {
    assert.deepEqual(checkHeaders(new Headers({ 'content-length': '65537' })), PAYLOAD_TOO_LARGE);
  });

  test('a declared length that does not parse is left to readCapped, which reads a small body', async () => {
    assert.equal(checkHeaders(new Headers({ 'content-length': 'twelve' })), null);
    const { stream } = chunkedStream([encoder.encode('{"jsonrpc":"2.0",'), encoder.encode('"method":"ping"}')]);
    assert.deepEqual(await readCapped(stream), encoder.encode('{"jsonrpc":"2.0","method":"ping"}'));
  });
});

/**
 * A stream that hands out one chunk per read and closes on the read after the last one. It records how often
 * it was pulled and whether it was cancelled. With a high-water mark of 0 it is pulled only when read.
 */
function chunkedStream(chunks: Uint8Array[]) {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[state.pulls];
        state.pulls += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

describe('readCapped', () => {
  // These two compare 64 KiB arrays by length and Buffer.compare, because a failing deepEqual renders every
  // element and takes seconds.
  test('a 65,536-byte stream is read whole and in order', async () => {
    const { stream, state } = chunkedStream([new Uint8Array(40_000).fill(1), new Uint8Array(25_536).fill(2)]);
    const body = await readCapped(stream);
    assert.ok(body !== null, 'readCapped returned null');
    assert.equal(body.byteLength, 65_536);
    const expected = new Uint8Array(65_536).fill(1).fill(2, 40_000);
    assert.equal(Buffer.compare(body, expected), 0, 'the bytes are not the chunks in order');
    assert.equal(state.cancelled, false);
  });

  test('a 65,537-byte stream is null, cancelled, and not read past its 65,537th byte', async () => {
    const { stream, state } = chunkedStream([new Uint8Array(65_536), new Uint8Array(1)]);
    const body = await readCapped(stream);
    assert.ok(body === null, `readCapped returned ${body?.byteLength} bytes`);
    assert.deepEqual(state, { pulls: 2, cancelled: true });
  });

  const failingCancels: [name: string, cancel: () => Promise<void>][] = [
    ['rejects', () => Promise.reject(new Error('cancel failed'))],
    ['never settles', () => new Promise<void>(() => {})],
  ];
  for (const [name, cancel] of failingCancels) {
    test(`a stream over the cap whose cancel ${name} is still null`, async () => {
      const stream = new ReadableStream<Uint8Array>(
        { pull: (controller) => controller.enqueue(new Uint8Array(65_537)), cancel },
        { highWaterMark: 0 },
      );
      assert.equal(await settledOrPending(readCapped(stream)), null);
    });
  }

  test('a null body is an empty array', async () => {
    assert.deepEqual(await readCapped(null), new Uint8Array(0));
  });

  test('a limit passed in caps the stream at that limit', async () => {
    assert.deepEqual(await readCapped(chunkedStream([encoder.encode('four')]).stream, 4), encoder.encode('four'));
    const over = chunkedStream([encoder.encode('five!')]);
    assert.equal(await readCapped(over.stream, 4), null);
    assert.equal(over.state.cancelled, true);
  });

  test('a limit that is not a non-negative integer throws before any read', async () => {
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { stream, state } = chunkedStream([encoder.encode('x')]);
      await assert.rejects(readCapped(stream, limit), RangeError, `limit ${limit}`);
      assert.equal(state.pulls, 0, `limit ${limit}`);
    }
  });
});

describe('checkContentType', () => {
  const UNSUPPORTED_MEDIA_TYPE = { status: 415, body: 'Unsupported Media Type' };

  for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
    test(`${JSON.stringify(contentType)} passes`, () => {
      assert.equal(checkContentType(new Headers({ 'content-type': contentType })), null);
    });
  }

  for (const contentType of ['application/json-rpc', 'text/plain']) {
    test(`${JSON.stringify(contentType)} is 415`, () => {
      assert.deepEqual(checkContentType(new Headers({ 'content-type': contentType })), UNSUPPORTED_MEDIA_TYPE);
    });
  }

  test('a missing Content-Type is 415', () => {
    assert.deepEqual(checkContentType(new Headers()), UNSUPPORTED_MEDIA_TYPE);
  });
});

describe('checkJsonRpcShape', () => {
  test('one object with jsonrpc "2.0" is 1 message', () => {
    const body = encoder.encode('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    assert.deepEqual(checkJsonRpcShape(body), { ok: true, messages: 1 });
  });

  test('a batch of three is 3 messages', () => {
    const body = encoder.encode(
      '[{"jsonrpc":"2.0","method":"notifications/initialized"},' +
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"},' +
        '{"jsonrpc":"2.0","id":2,"method":"ping"}]',
    );
    assert.deepEqual(checkJsonRpcShape(body), { ok: true, messages: 3 });
  });

  test('a byte order mark, and invalid UTF-8 inside a string, pass as they do in request.json()', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('{"jsonrpc":"2.0","method":"ping"}')]);
    assert.deepEqual(checkJsonRpcShape(withBom), { ok: true, messages: 1 });
    const invalidUtf8 = new Uint8Array([
      ...encoder.encode('{"jsonrpc":"2.0","method":"'),
      0xff,
      ...encoder.encode('"}'),
    ]);
    assert.deepEqual(checkJsonRpcShape(invalidUtf8), { ok: true, messages: 1 });
  });

  const BAD_REQUEST = { ok: false, rejection: { status: 400, body: 'Bad Request' } };
  const rejected: [name: string, body: string][] = [
    ['an empty batch', '[]'],
    ['a batch with an element that is not an object', '[{"jsonrpc":"2.0"}, 1]'],
    ['jsonrpc "1.0"', '{"jsonrpc":"1.0"}'],
    ['a JSON string', '"tools/list"'],
    ['a number', '42'],
    ['invalid JSON', '{"jsonrpc":"2.0"'],
    ['null', 'null'],
    ['a batch with null', '[null]'],
    ['a batch nested in a batch', '[[{"jsonrpc":"2.0"}]]'],
    ['an empty body', ''],
  ];
  for (const [name, body] of rejected) {
    test(`${name} is 400`, () => {
      assert.deepEqual(checkJsonRpcShape(encoder.encode(body)), BAD_REQUEST);
    });
  }
});

describe('rateLimitKey', () => {
  test('an IPv4 address is its own key', () => {
    assert.equal(rateLimitKey('203.0.113.7'), '203.0.113.7');
  });

  test('a full IPv6 address is keyed by its /64, in lowercase without leading zeros', () => {
    assert.equal(rateLimitKey('2001:0DB8:00A0:0000:0000:FF00:0042:8329'), '2001:db8:a0:0::/64');
  });

  test('a compressed IPv6 address is keyed by its /64', () => {
    assert.equal(rateLimitKey('2001:db8::ff00:42:8329'), '2001:db8:0:0::/64');
  });

  test('two addresses in one /64 share a key', () => {
    assert.equal(rateLimitKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
    assert.equal(rateLimitKey('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  });

  test('addresses in two /64s have different keys', () => {
    assert.equal(rateLimitKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
    assert.equal(rateLimitKey('2001:db8:1:3::1'), '2001:db8:1:3::/64');
  });

  test('an IPv4-mapped IPv6 address is keyed as its IPv4 address', () => {
    assert.equal(rateLimitKey('::ffff:198.51.100.23'), '198.51.100.23');
  });

  test('anything else throws, without the value in the message', () => {
    const garbage = [
      'unknown',
      '203.0.113',
      '203.0.113.256',
      '203.0.113.07',
      '2001:db8::1::2',
      '2001:db8:1:2:3:4:5:6:7',
      'fe80::1%eth0',
      '[2001:db8::1]',
      '2001:db8::/64',
      '::1]:80/x?[',
      // A trailing newline, which the URL parser would silently drop.
      '203.0.113.7\n',
      '2001:db8::1\n',
    ];
    for (const value of garbage) {
      assert.throws(
        () => rateLimitKey(value),
        (error: unknown) => error instanceof TypeError && !error.message.includes(value),
        value,
      );
    }
  });
});

/**
 * A limiter that answers each call with the next of successes after a turn of the event loop. It records
 * the calls, and the most calls it had in flight at once.
 */
function fakeLimiter(successes: boolean[]) {
  const calls: { key: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const limit = async (options: { key: string }) => {
    const success = successes[calls.length];
    calls.push(options);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await setImmediate();
    inFlight -= 1;
    assert.ok(success !== undefined, `limit was called ${calls.length} times, more than the test allows`);
    return { success };
  };
  return { limit, calls, maxInFlight: () => maxInFlight };
}

describe('chargeRateLimit', () => {
  test('3 messages under budget make 3 calls, one at a time, and pass', async () => {
    const limiter = fakeLimiter([true, true, true]);
    assert.equal(await chargeRateLimit(limiter.limit, '203.0.113.7', 3), true);
    assert.deepEqual(limiter.calls, [{ key: '203.0.113.7' }, { key: '203.0.113.7' }, { key: '203.0.113.7' }]);
    assert.equal(limiter.maxInFlight(), 1);
  });

  test('a failure on call 2 of 5 fails after exactly 2 calls', async () => {
    const limiter = fakeLimiter([true, false, true, true, true]);
    assert.equal(await chargeRateLimit(limiter.limit, '2001:db8:1:2::/64', 5), false);
    assert.equal(limiter.calls.length, 2);
  });

  test('a message count that is not a positive integer throws before any call', async () => {
    for (const messages of [0, -1, 1.5, Number.NaN]) {
      const limiter = fakeLimiter([true, true]);
      await assert.rejects(chargeRateLimit(limiter.limit, '203.0.113.7', messages), RangeError, `messages ${messages}`);
      assert.equal(limiter.calls.length, 0, `messages ${messages}`);
    }
  });
});

describe('chargeClient', () => {
  test('a missing CF-Connecting-IP throws before any call', async () => {
    const limiter = fakeLimiter([true]);
    await assert.rejects(chargeClient(limiter.limit, null, 1), {
      name: 'Error',
      message: 'the request has no CF-Connecting-IP header',
    });
    assert.equal(limiter.calls.length, 0);
  });

  test('an IPv4 address is charged under its own key, once per message', async () => {
    const limiter = fakeLimiter([true, true, true]);
    assert.equal(await chargeClient(limiter.limit, '203.0.113.7', 3), true);
    assert.deepEqual(limiter.calls, [{ key: '203.0.113.7' }, { key: '203.0.113.7' }, { key: '203.0.113.7' }]);
  });

  test('an IPv6 address is charged under its /64', async () => {
    const limiter = fakeLimiter([true]);
    assert.equal(await chargeClient(limiter.limit, '2001:db8:1:2::1', 1), true);
    assert.deepEqual(limiter.calls, [{ key: '2001:db8:1:2::/64' }]);
  });

  test('a failed charge is false', async () => {
    const limiter = fakeLimiter([false]);
    assert.equal(await chargeClient(limiter.limit, '203.0.113.7', 1), false);
    assert.equal(limiter.calls.length, 1);
  });
});

describe('notModified', () => {
  const ETAG = '"0a1b2c3d"';

  test('no If-None-Match is false', () => {
    assert.equal(notModified(null, ETAG), false);
  });

  test('* is true', () => {
    assert.equal(notModified('*', ETAG), true);
  });

  test('the tag is true', () => {
    assert.equal(notModified('"0a1b2c3d"', ETAG), true);
  });

  test('the tag marked weak is true', () => {
    assert.equal(notModified('W/"0a1b2c3d"', ETAG), true);
  });

  test('a list with the tag second is true', () => {
    assert.equal(notModified('"other","0a1b2c3d"', ETAG), true);
  });

  test('a list with spaces around its tags is true', () => {
    assert.equal(notModified('"other" , W/"0a1b2c3d" , "third"', ETAG), true);
  });

  test('the prefix is ignored on the ETag side too', () => {
    assert.equal(notModified('"0a1b2c3d"', 'W/"0a1b2c3d"'), true);
  });

  test('a different tag is false', () => {
    assert.equal(notModified('"other"', ETAG), false);
  });

  test('a list without the tag is false', () => {
    assert.equal(notModified('"other", W/"third"', ETAG), false);
  });

  test('the tag unquoted is false', () => {
    assert.equal(notModified('0a1b2c3d', ETAG), false);
  });
});

describe('shouldRetry', () => {
  test('a throw retries', () => {
    assert.equal(shouldRetry({ threw: true }), true);
  });

  for (const status of [500, 502, 503]) {
    test(`status ${status} retries`, () => {
      assert.equal(shouldRetry({ status }), true);
    });
  }

  for (const status of [404, 429, 499]) {
    test(`status ${status} does not retry`, () => {
      assert.equal(shouldRetry({ status }), false);
    });
  }
});

describe('forwardWithRetry', () => {
  const REQUEST_TEXT = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';

  /**
   * Fakes for send, sleep and log that record every call in one ordered list of events. send answers with
   * the queued outcomes in order, throwing the queued errors. A response made by respond records the
   * cancellation of its body.
   */
  function harness() {
    const events: string[] = [];
    const bodies: Uint8Array[] = [];
    const outcomes: (Response | Error)[] = [];
    return {
      events,
      bodies,
      outcomes,
      send: async (body: Uint8Array): Promise<Response> => {
        events.push('send');
        bodies.push(body.slice());
        const outcome = outcomes.shift();
        if (outcome === undefined) throw new Error('send was called more often than the test allows');
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      sleep: async (ms: number): Promise<void> => {
        events.push(`sleep ${ms}`);
      },
      log: {
        warn: (...args: unknown[]) => {
          events.push(`warn ${args.join(' ')}`);
        },
        error: (...args: unknown[]) => {
          events.push(`error ${args.join(' ')}`);
        },
      },
      respond: (status: number) =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              events.push(`cancel ${status}`);
            },
          }),
          { status },
        ),
    };
  }

  async function assertUnavailable(response: Response): Promise<void> {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain(;|$)/);
    assert.equal(await response.text(), 'Service Unavailable');
  }

  test('a throw then 200 returns the 200, after one sleep(500) and two sends', async () => {
    const h = harness();
    const ok = h.respond(200);
    h.outcomes.push(new Error('connection refused'), ok);
    assert.equal(await forwardWithRetry(encoder.encode(REQUEST_TEXT), h.send, h.sleep, h.log), ok);
    assert.deepEqual(h.events, ['send', 'warn container fetch failed, retrying: threw', 'sleep 500', 'send']);
  });

  test('500 then 200 returns the 200 and cancels the first body before the sleep', async () => {
    const h = harness();
    const ok = h.respond(200);
    h.outcomes.push(h.respond(500), ok);
    assert.equal(await forwardWithRetry(encoder.encode(REQUEST_TEXT), h.send, h.sleep, h.log), ok);
    assert.deepEqual(h.events, [
      'send',
      'warn container fetch failed, retrying: status 500',
      'cancel 500',
      'sleep 500',
      'send',
    ]);
  });

  test('500 then 502 returns the 502', async () => {
    const h = harness();
    const badGateway = h.respond(502);
    h.outcomes.push(h.respond(500), badGateway);
    assert.equal(await forwardWithRetry(encoder.encode(REQUEST_TEXT), h.send, h.sleep, h.log), badGateway);
    assert.deepEqual(h.events, [
      'send',
      'warn container fetch failed, retrying: status 500',
      'cancel 500',
      'sleep 500',
      'send',
    ]);
  });

  test('a throw then a throw answers 503 with Retry-After: 5', async () => {
    const h = harness();
    h.outcomes.push(new Error('connection refused'), new Error('connection refused'));
    await assertUnavailable(await forwardWithRetry(encoder.encode(REQUEST_TEXT), h.send, h.sleep, h.log));
    assert.deepEqual(h.events, [
      'send',
      'warn container fetch failed, retrying: threw',
      'sleep 500',
      'send',
      'error answering 503 after retry',
    ]);
  });

  test('500 then a throw answers 503 with Retry-After: 5', async () => {
    const h = harness();
    h.outcomes.push(h.respond(500), new Error('connection refused'));
    await assertUnavailable(await forwardWithRetry(encoder.encode(REQUEST_TEXT), h.send, h.sleep, h.log));
    assert.deepEqual(h.events, [
      'send',
      'warn container fetch failed, retrying: status 500',
      'cancel 500',
      'sleep 500',
      'send',
      'error answering 503 after retry',
    ]);
  });

  test('404 is returned after one send and no sleep', async () => {
    const h = harness();
    const notFound = h.respond(404);
    h.outcomes.push(notFound);
    assert.equal(await forwardWithRetry(encoder.encode(REQUEST_TEXT), h.send, h.sleep, h.log), notFound);
    assert.deepEqual(h.events, ['send']);
  });

  test('both sends receive the request bytes', async () => {
    const h = harness();
    h.outcomes.push(h.respond(503), h.respond(200));
    await forwardWithRetry(encoder.encode(REQUEST_TEXT), h.send, h.sleep, h.log);
    assert.deepEqual(h.bodies, [encoder.encode(REQUEST_TEXT), encoder.encode(REQUEST_TEXT)]);
  });

  test('a 5xx whose body has already failed is still retried', async () => {
    const h = harness();
    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection lost'));
      },
    });
    const ok = h.respond(200);
    h.outcomes.push(new Response(failedBody, { status: 500 }), ok);
    assert.equal(await forwardWithRetry(encoder.encode(REQUEST_TEXT), h.send, h.sleep, h.log), ok);
    assert.deepEqual(h.events, ['send', 'warn container fetch failed, retrying: status 500', 'sleep 500', 'send']);
  });

  test('a 5xx whose body cancel never settles is still retried', async () => {
    const h = harness();
    const stuckBody = new ReadableStream<Uint8Array>({
      cancel() {
        h.events.push('cancel 500');
        return new Promise<void>(() => {});
      },
    });
    const ok = h.respond(200);
    h.outcomes.push(new Response(stuckBody, { status: 500 }), ok);
    const response = await settledOrPending(forwardWithRetry(encoder.encode(REQUEST_TEXT), h.send, h.sleep, h.log));
    assert.equal(response, ok);
    assert.deepEqual(h.events, [
      'send',
      'warn container fetch failed, retrying: status 500',
      'cancel 500',
      'sleep 500',
      'send',
    ]);
  });

  test('the log lines carry nothing from the request or the errors', async () => {
    const h = harness();
    const marker = 'client-supplied-7f3a';
    const request = encoder.encode(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${marker}"}}`);
    h.outcomes.push(new Error(`fetch failed for ${marker}`), new Error(`fetch failed for ${marker}`));
    await forwardWithRetry(request, h.send, h.sleep, h.log);
    const lines = h.events.filter((event) => event.startsWith('warn ') || event.startsWith('error '));
    assert.deepEqual(lines, ['warn container fetch failed, retrying: threw', 'error answering 503 after retry']);
  });

  test('without a log, the lines go to console', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const error = t.mock.method(console, 'error', () => {});
    const h = harness();
    h.outcomes.push(h.respond(500), new Error('connection refused'));
    await assertUnavailable(await forwardWithRetry(encoder.encode(REQUEST_TEXT), h.send, h.sleep));
    assert.deepEqual(
      warn.mock.calls.map((call) => call.arguments),
      [['container fetch failed, retrying: status 500']],
    );
    assert.deepEqual(
      error.mock.calls.map((call) => call.arguments),
      [['answering 503 after retry']],
    );
  });
});
