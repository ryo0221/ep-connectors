import { describe, expect, it } from 'vitest';
import { json } from '@ep-connectors/testing';
import { CRS84 } from '../geo.js';
import { pointFeature } from './fake-ogc-server.js';
import type { FeaturePage, FeatureQuery } from './read.js';
import { checkNextLink, describeCollection, readFeaturesPage } from './read.js';
import {
  ELSEWHERE,
  ORIGIN,
  PUBLIC_SOURCE,
  publicSetup,
  stations,
  tokenSetup,
  TOKYO,
} from './support.js';

const QUERY: FeatureQuery = { collectionId: 'stations', bbox: TOKYO, limit: 10 };

async function readAll(
  setup: ReturnType<typeof publicSetup>,
  query: FeatureQuery,
): Promise<FeaturePage[]> {
  const pages: FeaturePage[] = [];
  let cursor: string | null = null;
  do {
    const result = await readFeaturesPage(setup.reader, query, cursor);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    pages.push(result.value);
    cursor = result.value.next;
  } while (cursor !== null);
  return pages;
}

describe('readFeaturesPage', () => {
  it('searches by bbox and returns CRS84 features with provenance', async () => {
    const setup = publicSetup();
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const page = result.value;

    const sent = setup.provider.received[0];
    const url = new URL(sent?.url ?? '');
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/ogcapi/collections/stations/items`);
    expect(url.searchParams.get('bbox')).toBe('139.7,35.6,139.8,35.7');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(sent?.headers.accept).toContain('application/geo+json');
    expect(sent?.headers.authorization).toBeUndefined();

    expect(page.crs).toBe(CRS84);
    expect(page.features).toHaveLength(10);
    expect(page.features[0]).toEqual({
      id: 'station-01',
      geometry: { type: 'Point', coordinates: [139.71, 35.65] },
      properties: { name: 'Station 1' },
    });
    expect(page.numberMatched).toBe(25);
    expect(page.next).not.toBeNull();
    expect(page.provenance).toEqual({
      provider: PUBLIC_SOURCE.provider,
      origin: ORIGIN,
      collectionId: 'stations',
      retrievedAt: '2026-10-23T00:00:00.000Z',
      timeStamp: '2026-10-01T00:00:00Z',
      links: [
        {
          rel: 'license',
          href: 'https://license.fake.test/cc-by-4.0',
          type: null,
          title: null,
        },
      ],
    });
  });

  it('follows next links until the last page without leaving the bbox', async () => {
    const setup = publicSetup();
    const pages = await readAll(setup, QUERY);
    expect(pages.map((page) => page.features.length)).toEqual([10, 10, 5]);
    const ids = pages.flatMap((page) => page.features.map((feature) => feature.id));
    expect(new Set(ids).size).toBe(25);
    expect(ids.every((id) => id?.startsWith('station-'))).toBe(true);
    // HTML の next link は選ばない。
    expect(setup.provider.received.every((request) => !request.url.includes('f=html'))).toBe(true);
  });

  it('accepts a bbox that crosses the antimeridian', async () => {
    const setup = publicSetup({
      collections: [
        {
          id: 'pacific',
          features: [
            pointFeature('fiji', [178.4, -18.1]),
            pointFeature('samoa', [-171.8, -13.8]),
            pointFeature('tokyo', [139.7, 35.6]),
          ],
        },
      ],
    });
    const result = await readFeaturesPage(
      setup.reader,
      { collectionId: 'pacific', bbox: [170, -30, -165, 0], limit: 10 },
      null,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.features.map((feature) => feature.id)).toEqual(['fiji', 'samoa']);
  });

  it.each([
    ['latitude out of range', { bbox: [139, -91, 140, 35] }, 'bbox'],
    ['south above north', { bbox: [139, 36, 140, 35] }, 'bbox'],
    ['longitude out of range', { bbox: [-181, 35, 140, 36] }, 'bbox'],
    ['zero limit', { limit: 0 }, 'limit'],
    ['limit above the maximum', { limit: 10001 }, 'limit'],
    ['empty collection', { collectionId: '' }, 'collection'],
  ] as const)('rejects %s without sending', async (_name, change, reason) => {
    const setup = publicSetup();
    const result = await readFeaturesPage(
      setup.reader,
      { ...QUERY, ...change } as FeatureQuery,
      null,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'invalid-query', reason } });
    expect(setup.provider.received).toHaveLength(0);
  });

  it('rejects a CRS other than CRS84 instead of converting it', async () => {
    const setup = publicSetup({ contentCrs: 'http://www.opengis.net/def/crs/EPSG/0/4326' });
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'unsupported-crs', crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
    });
  });

  it('accepts an explicit CRS84 Content-Crs', async () => {
    const setup = publicSetup({ contentCrs: CRS84 });
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    expect(result.ok).toBe(true);
  });

  it('does not follow a next link to another origin', async () => {
    const setup = publicSetup({
      rewriteNext: (href) => href.replace(ORIGIN, ELSEWHERE),
    });
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    expect(result).toEqual({ ok: false, error: { kind: 'next-link', reason: 'origin' } });
    expect(setup.provider.receivedAt(ELSEWHERE)).toHaveLength(0);
  });

  it('does not follow a next link that drops or changes the bbox', async () => {
    const dropped = publicSetup({
      rewriteNext: (href) => {
        const url = new URL(href);
        url.searchParams.delete('bbox');
        return url.toString();
      },
    });
    expect(await readFeaturesPage(dropped.reader, QUERY, null)).toEqual({
      ok: false,
      error: { kind: 'next-link', reason: 'bbox' },
    });

    const widened = publicSetup({
      rewriteNext: (href) => {
        const url = new URL(href);
        url.searchParams.set('bbox', '-180,-90,180,90');
        return url.toString();
      },
    });
    expect(await readFeaturesPage(widened.reader, QUERY, null)).toEqual({
      ok: false,
      error: { kind: 'next-link', reason: 'bbox' },
    });
  });

  it('accepts a next link that formats the same bbox differently', async () => {
    const setup = publicSetup({
      rewriteNext: (href) => {
        const url = new URL(href);
        url.searchParams.set('bbox', '139.70,35.60,139.80,35.70');
        return url.toString();
      },
    });
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    expect(result.ok && result.value.next).toContain('139.70');
  });

  it('does not follow a next link with an undeclared query parameter or another collection', async () => {
    const extra = publicSetup({ rewriteNext: (href) => `${href}&token=abc` });
    expect(await readFeaturesPage(extra.reader, QUERY, null)).toEqual({
      ok: false,
      error: { kind: 'next-link', reason: 'query' },
    });

    const other = publicSetup({
      rewriteNext: (href) => href.replace('/collections/stations/', '/collections/private/'),
    });
    expect(await readFeaturesPage(other.reader, QUERY, null)).toEqual({
      ok: false,
      error: { kind: 'next-link', reason: 'path' },
    });
  });

  it('re-checks a cursor that comes back from outside', async () => {
    const setup = publicSetup();
    const first = await readFeaturesPage(setup.reader, QUERY, null);
    if (!first.ok || first.value.next === null) throw new Error('no next page');
    const before = setup.provider.received.length;

    // 別の領域の条件で同じ基点を使う。
    const otherBbox = await readFeaturesPage(
      setup.reader,
      { ...QUERY, bbox: [135, 34, 136, 35] },
      first.value.next,
    );
    expect(otherBbox).toEqual({ ok: false, error: { kind: 'invalid-cursor', reason: 'bbox' } });

    const forged = await readFeaturesPage(setup.reader, QUERY, `${ELSEWHERE}/collect?x=1`);
    expect(forged).toEqual({ ok: false, error: { kind: 'invalid-cursor', reason: 'origin' } });
    expect(setup.provider.received).toHaveLength(before);

    const resumed = await readFeaturesPage(setup.reader, QUERY, first.value.next);
    expect(resumed.ok && resumed.value.features[0]?.id).toBe('station-11');
  });

  it('honours the paging parameters the host declared for the deployment', () => {
    const href = `${ORIGIN}/ogcapi/collections/stations/items?bbox=139.7,35.6,139.8,35.7&startIndex=10`;
    expect(checkNextLink(PUBLIC_SOURCE, QUERY, href, href).ok).toBe(true);
    const cursorSource = { ...PUBLIC_SOURCE, pagingParameters: ['cursor'] };
    expect(checkNextLink(cursorSource, QUERY, href, href)).toEqual({ ok: false, reason: 'query' });
    expect(checkNextLink(cursorSource, QUERY, `${href.split('&')[0]}&cursor=Zz`, href).ok).toBe(
      true,
    );
  });

  it('reports a next link only offered as HTML as an invalid response', async () => {
    const setup = publicSetup({ nextType: 'text/html' });
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalid-response', reason: 'no GeoJSON next link' },
    });
  });

  it('rejects malformed features with their position and keeps the rest', async () => {
    const collection = stations();
    collection.features = [
      pointFeature('ok', [139.75, 35.65], { note: 'a\u0000b‮c', html: '<b>bold</b>' }),
      {
        at: [139.75, 35.65],
        feature: {
          type: 'Feature',
          id: 'lat-lon',
          geometry: { type: 'Point', coordinates: [35.65, 139.75] },
          properties: {},
        },
      },
      {
        at: [139.75, 35.65],
        feature: {
          type: 'Feature',
          id: 'open-ring',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [139.7, 35.6],
                [139.8, 35.6],
                [139.8, 35.7],
                [139.7, 35.7],
              ],
            ],
          },
          properties: {},
        },
      },
      { at: [139.75, 35.65], feature: { type: 'NotAFeature' } },
      pointFeature(7, [139.76, 35.66]),
    ];
    const setup = publicSetup({ collections: [collection] });
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.features.map((feature) => feature.id)).toEqual(['ok', '7']);
    // 制御文字と表示の向きを変える文字を除く。HTML は解釈せずに文字列のまま返す。
    expect(result.value.features[0]?.properties).toEqual({ note: 'abc', html: '<b>bold</b>' });
    expect(result.value.rejected).toEqual([
      { index: 1, id: 'lat-lon', reason: 'invalid-geometry' },
      { index: 2, id: 'open-ring', reason: 'invalid-geometry' },
      { index: 3, id: null, reason: 'invalid-feature' },
    ]);
  });

  it('reports rate limits with the time to wait', async () => {
    const setup = publicSetup({
      intercept: () => json(429, { code: 'TooManyRequests' }, { 'retry-after': '120' }),
    });
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'rate-limited', retryAfter: '2026-10-23T00:02:00.000Z' },
    });
  });

  it('does not follow redirects', async () => {
    const setup = publicSetup({
      intercept: () => ({
        status: 302,
        headers: { location: `${ELSEWHERE}/items` },
        body: '',
      }),
    });
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    expect(result).toEqual({ ok: false, error: { kind: 'http', status: 302 } });
    expect(setup.provider.receivedAt(ELSEWHERE)).toHaveLength(0);
  });

  it('sends through the token store for a deployment that needs authentication', async () => {
    const setup = tokenSetup();
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    expect(result.ok).toBe(true);
    expect(setup.provider.received[0]?.headers.authorization).toBe('Bearer geo-access-token');
  });

  it('does not send when the connection lacks the scope', async () => {
    const setup = tokenSetup({}, { scopes: [] });
    const result = await readFeaturesPage(setup.reader, QUERY, null);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'send', error: { kind: 'catalog', reason: 'scope' } },
    });
    expect(setup.provider.received).toHaveLength(0);
  });
});

describe('describeCollection', () => {
  it('returns attribution, licence, extent and the declared CRS', async () => {
    const setup = publicSetup();
    const result = await describeCollection(setup.reader, 'stations');
    expect(result).toEqual({
      ok: true,
      value: {
        collectionId: 'stations',
        title: 'Stations',
        description: null,
        extent: [122, 20, 154, 46],
        crs: [CRS84],
        supportsCrs84: true,
        attribution: '© Example Survey',
        licenses: [
          {
            rel: 'license',
            href: 'https://license.fake.test/cc-by-4.0',
            type: null,
            title: 'License',
          },
        ],
        retrievedAt: '2026-10-23T00:00:00.000Z',
      },
    });
  });

  it('reports a collection that does not offer CRS84', async () => {
    const collection = { ...stations(), crs: ['http://www.opengis.net/def/crs/EPSG/0/6668'] };
    const setup = publicSetup({ collections: [collection] });
    const result = await describeCollection(setup.reader, 'stations');
    expect(result.ok && result.value.supportsCrs84).toBe(false);
  });

  it('returns not found as an http error', async () => {
    const setup = publicSetup();
    expect(await describeCollection(setup.reader, 'missing')).toEqual({
      ok: false,
      error: { kind: 'http', status: 404 },
    });
  });
});
