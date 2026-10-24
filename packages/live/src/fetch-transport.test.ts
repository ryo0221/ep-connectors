import { describe, expect, it } from 'vitest';
import type { HttpRequest, OperationCatalog } from '@ep-connectors/core';
import { FetchHttpTransport } from './fetch-transport.js';

const CATALOG: OperationCatalog = {
  provider: 'public',
  operations: [
    {
      name: 'items.list',
      method: 'GET',
      origin: 'https://data.fake.test',
      path: '/items',
      query: ['limit'],
      headers: ['accept'],
      scopes: [],
      auth: 'none',
    },
  ],
};

const REQUEST: HttpRequest = {
  operation: 'items.list',
  method: 'GET',
  url: 'https://data.fake.test/items?limit=2',
  headers: { Accept: 'application/json' },
};

function recordingFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('FetchHttpTransport', () => {
  it('sends a catalogued request without following redirects or sending credentials', async () => {
    const { fetch, calls } = recordingFetch(
      () =>
        new Response('{"items":[]}', {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'session=secret' },
        }),
    );
    const transport = new FetchHttpTransport({ catalog: CATALOG, fetch, userAgent: 'ep-test' });
    const result = await transport.send(REQUEST);

    expect(result).toEqual({
      ok: true,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"items":[]}',
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: 'application/json', 'user-agent': 'ep-test' },
    });
  });

  it('does not send a request the catalog rejects', async () => {
    const { fetch, calls } = recordingFetch(() => new Response(''));
    const transport = new FetchHttpTransport({ catalog: CATALOG, fetch });
    const cases: [HttpRequest, string][] = [
      [{ ...REQUEST, url: 'https://elsewhere.fake.test/items' }, 'origin'],
      [{ ...REQUEST, url: 'https://data.fake.test/items?all=1' }, 'query'],
      [{ ...REQUEST, headers: { authorization: 'Bearer x' } }, 'credential-header'],
      [{ ...REQUEST, operation: 'items.delete' }, 'unknown-operation'],
    ];
    for (const [request, reason] of cases) {
      expect(await transport.send(request)).toEqual({
        ok: false,
        error: { kind: 'catalog', reason },
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('returns a redirect as a response for the adapter to refuse', async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.fake.test/' } }),
    );
    const result = await new FetchHttpTransport({ catalog: CATALOG, fetch }).send(REQUEST);
    expect(result.ok && result.response.status).toBe(302);
  });

  it('treats network failures, oversized and undecodable bodies as transport errors', async () => {
    const failing = recordingFetch(() => Promise.reject(new TypeError('network')));
    const oversized = recordingFetch(() => new Response('x'.repeat(64)));
    const declared = recordingFetch(
      () => new Response('x', { headers: { 'content-length': '1000000' } }),
    );
    const binary = recordingFetch(() => new Response(new Uint8Array([0xff, 0xfe, 0xfd])));
    const transportError = { ok: false, error: { kind: 'transport', phase: 'after-send' } };
    for (const { fetch } of [failing, oversized, declared, binary]) {
      const transport = new FetchHttpTransport({ catalog: CATALOG, fetch, maxResponseBytes: 32 });
      expect(await transport.send(REQUEST)).toEqual(transportError);
    }
  });
});
