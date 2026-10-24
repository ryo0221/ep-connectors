import { describe, expect, it } from 'vitest';
import type { ConnectionKey, HttpRequest } from '@ep-connectors/core';
import { FetchHttpTransport } from '@ep-connectors/live';
import { createSyncBacking, MemorySyncStateStore } from '@ep-connectors/testing';
import type { OgcFeaturesSource } from './catalog.js';
import { ogcFeaturesCatalog } from './catalog.js';
import type { FeatureQuery, OgcFeaturesReader } from './read.js';
import { describeCollection, readFeaturesPage, transportSender } from './read.js';
import { featuresScope, syncFeatures } from './sync.js';

// R2 の Geo の実接続（issue #11）。pygeoapi のデモ配備（/master）へ、読取だけの小さな要求を
// 送る。/cite の lakes は tile として公開され items が 400 になるため使わない（docs/map 9.1）。
// `npm run test:live` でだけ動き、通常の試験・CI では動かさない。secret は使わない。
// 配備の利用条件と安定性は保証されない。使えなければ docs/map/README.md の 9 節に理由を残す。

/** Host の信頼できる静的な設定。応答の link から送信先を増やさない。 */
const SOURCE: OgcFeaturesSource = {
  provider: 'ogc-features:pygeoapi-demo',
  origin: 'https://demo.pygeoapi.io',
  basePath: '/master',
  auth: 'none',
  // pygeoapi は offset で paging し、`next` link に要求の形式（`f=json`）を残す。
  pagingParameters: ['offset'],
  fixedQuery: { f: 'json' },
};

/** 五大湖の周辺。小さな `limit` で数ページになるようにし、要求は十数回に収める。 */
const QUERY: FeatureQuery = { collectionId: 'lakes', bbox: [-93, 41, -76, 49.5], limit: 2 };
const MAX_PAGES = 10;

const CONNECTION: ConnectionKey = {
  principal: 'live-smoke',
  provider: SOURCE.provider,
  tenant: 'public',
  account: 'anonymous',
  connection: 'pygeoapi-demo',
  generation: 1,
};

const clock = { now: () => new Date().toISOString() };

/** 送った要求の操作名と path・query だけを数える。応答の本体は残さない。 */
function countingReader(): { reader: OgcFeaturesReader; sent: string[] } {
  const transport = new FetchHttpTransport({
    catalog: ogcFeaturesCatalog(SOURCE),
    userAgent: 'ep-connectors-r2-smoke (+https://github.com/ryo0221/ep-connectors/issues/11)',
  });
  const sent: string[] = [];
  const send = transportSender(transport);
  return {
    reader: {
      source: SOURCE,
      clock,
      send: (request: HttpRequest) => {
        const url = new URL(request.url);
        sent.push(`${request.operation} ${url.pathname}${url.search}`);
        return send(request);
      },
    },
    sent,
  };
}

describe('pygeoapi demo (live, read-only)', () => {
  it('describes the collection, pages through a small bbox and publishes one generation', async () => {
    const { reader, sent } = countingReader();

    const collection = await describeCollection(reader, QUERY.collectionId);
    if (!collection.ok) throw new Error(`describe: ${JSON.stringify(collection.error)}`);
    expect(collection.value.supportsCrs84).toBe(true);

    const first = await readFeaturesPage(reader, QUERY, null);
    if (!first.ok) throw new Error(`first page: ${JSON.stringify(first.error)}`);
    expect(first.value.crs).toBe('http://www.opengis.net/def/crs/OGC/1.3/CRS84');
    expect(first.value.features.length).toBeGreaterThan(0);
    expect(first.value.features.length).toBeLessThanOrEqual(QUERY.limit);
    for (const feature of first.value.features) {
      expect(['Polygon', 'MultiPolygon']).toContain(feature.geometry?.type);
    }
    expect(first.value.provenance).toMatchObject({
      provider: SOURCE.provider,
      origin: SOURCE.origin,
      collectionId: QUERY.collectionId,
    });

    // 外から戻った基点は、送る前に拒否する。
    const before = sent.length;
    const forged = await readFeaturesPage(
      reader,
      QUERY,
      `${SOURCE.origin}${SOURCE.basePath}/collections/lakes/items?f=json&bbox=-180,-90,180,90&offset=0`,
    );
    expect(forged).toEqual({ ok: false, error: { kind: 'invalid-cursor', reason: 'bbox' } });
    expect(sent).toHaveLength(before);

    const store = new MemorySyncStateStore(createSyncBacking());
    const scope = featuresScope(CONNECTION, SOURCE, QUERY);
    const syncStart = sent.length;
    const synced = await syncFeatures(reader, store, scope, QUERY, null, { maxPages: MAX_PAGES });
    if (!synced.ok) throw new Error(`sync: ${JSON.stringify(synced)}`);
    const pages = sent.length - syncStart;
    const published = await store.read(scope);
    expect(published?.generation).toBe(synced.generation);
    expect(published?.entries).toHaveLength(synced.stored);
    if (synced.numberMatched !== null) {
      expect(synced.stored + synced.rejected.length).toBe(synced.numberMatched);
    }

    // 秘密も実応答の本体も含まない記録。docs/map/README.md の 9 節へ写す。
    console.log(
      JSON.stringify(
        {
          at: clock.now(),
          endpoint: `${SOURCE.origin}${SOURCE.basePath}`,
          collection: {
            id: QUERY.collectionId,
            title: collection.value.title,
            attribution: collection.value.attribution,
            licenses: collection.value.licenses.map((link) => link.href),
            crs: collection.value.crs,
            extent: collection.value.extent,
          },
          query: QUERY,
          firstPage: {
            returned: first.value.features.length,
            numberMatched: first.value.numberMatched,
            timeStamp: first.value.provenance.timeStamp,
            hasNext: first.value.next !== null,
            sourceLinks: first.value.provenance.links.map((link) => `${link.rel} ${link.href}`),
          },
          sync: {
            pages,
            stored: synced.stored,
            numberMatched: synced.numberMatched,
            rejected: synced.rejected.map(
              (entry) => `${entry.page}:${entry.index}:${entry.reason}`,
            ),
            generation: synced.generation,
          },
          requests: sent,
        },
        null,
        2,
      ),
    );
  });
});
