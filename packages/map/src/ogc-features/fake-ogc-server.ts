import type { HttpResponse } from '@ep-connectors/core';
import type { FakeProvider, ReceivedRequest } from '@ep-connectors/testing';
import { json } from '@ep-connectors/testing';
import { CRS84 } from '../geo.js';

// 試験専用の偽の OGC API Features の配備。Part 1 の items（bbox・limit・next link・
// numberMatched・timeStamp・未知の query parameter は 400）と、Part 2 の Content-Crs だけを再現する。
// Paging は offset 方式とする。配備ごとの違い（startIndex、不透明な cursor）は `rewriteNext` で再現する。

export interface FakeFeature {
  /** 領域での絞り込みに使う位置。返す `feature` の形が壊れていても絞り込めるように分ける。 */
  at: [number, number];
  feature: unknown;
}

export interface FakeCollection {
  id: string;
  title?: string;
  attribution?: string;
  license?: string;
  crs?: string[];
  /** collection の説明の `itemType`。省略すると付けない。 */
  itemType?: string;
  extent?: [number, number, number, number];
  features: FakeFeature[];
}

export interface ItemsContext {
  collectionId: string;
  offset: number;
  /** この配備が items へ受けた要求の、何回目か（1 から）。 */
  call: number;
}

export interface FakeOgcOptions {
  origin: string;
  basePath: string;
  collections: FakeCollection[];
  /** 指定すると `Content-Crs` header を付ける。 */
  contentCrs?: string;
  /** 通常の応答の前に呼ぶ。応答を返せばそれを使う（rate limit、障害の再現）。 */
  intercept?: (request: ReceivedRequest, context: ItemsContext) => HttpResponse | null;
  /** 返す `next` link を書き換える。 */
  rewriteNext?: (href: string, context: ItemsContext) => string;
  /** `next` link に付ける type。既定は GeoJSON。 */
  nextType?: string;
  timeStamp?: string;
  /**
   * 受け付ける固定の query（pygeoapi の `f=json` など）。値が違えば 400。受けた値はそのまま
   * `next` link に残す（pygeoapi 0.24 の `itemtypes.py` と同じ）。
   */
  fixedQuery?: Record<string, string>;
}

const DEFAULT_LIMIT = 10;

export function fakeOgcServer(provider: FakeProvider, options: FakeOgcOptions): void {
  const base = `${options.origin}${options.basePath}`;
  let calls = 0;

  provider.route('GET', `${base}/collections/{collectionId}`, (_request, params) => {
    const collection = options.collections.find(
      (candidate) => candidate.id === params.collectionId,
    );
    if (!collection) return json(404, { code: 'NotFound' });
    const href = `${base}/collections/${collection.id}`;
    return json(200, {
      id: collection.id,
      ...(collection.title === undefined ? {} : { title: collection.title }),
      ...(collection.attribution === undefined ? {} : { attribution: collection.attribution }),
      ...(collection.crs === undefined ? {} : { crs: collection.crs }),
      ...(collection.itemType === undefined ? {} : { itemType: collection.itemType }),
      ...(collection.extent === undefined
        ? {}
        : { extent: { spatial: { bbox: [collection.extent], crs: CRS84 } } }),
      links: [
        { rel: 'self', href, type: 'application/json' },
        { rel: 'items', href: `${href}/items`, type: 'application/geo+json' },
        ...(collection.license === undefined
          ? []
          : [{ rel: 'license', href: collection.license, title: 'License' }]),
      ],
    });
  });

  provider.route('GET', `${base}/collections/{collectionId}/items`, (request, params) => {
    calls += 1;
    const collection = options.collections.find(
      (candidate) => candidate.id === params.collectionId,
    );
    if (!collection) return json(404, { code: 'NotFound' });
    const url = new URL(request.url);
    for (const [name, value] of url.searchParams) {
      const fixed = options.fixedQuery?.[name];
      if (fixed === undefined ? !['bbox', 'limit', 'offset'].includes(name) : value !== fixed) {
        return json(400, { code: 'InvalidParameterValue', description: name });
      }
    }
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const context: ItemsContext = { collectionId: collection.id, offset, call: calls };
    const intercepted = options.intercept?.(request, context);
    if (intercepted) return intercepted;

    const limit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
    const bboxParam = url.searchParams.get('bbox');
    const bbox = bboxParam === null ? null : bboxParam.split(',').map(Number);
    const matched = collection.features.filter(
      (entry) => bbox === null || inside(entry.at, bbox as [number, number, number, number]),
    );
    const page = matched.slice(offset, offset + limit);

    const self = new URL(url);
    const links: unknown[] = [{ rel: 'self', href: self.toString(), type: 'application/geo+json' }];
    if (collection.license !== undefined) links.push({ rel: 'license', href: collection.license });
    if (offset + limit < matched.length) {
      const next = new URL(url);
      next.searchParams.set('offset', String(offset + limit));
      const href = options.rewriteNext?.(next.toString(), context) ?? next.toString();
      links.push({ rel: 'next', href, type: options.nextType ?? 'application/geo+json' });
      // 同じ位置の HTML の link。Adapter は GeoJSON のものを選ぶ。
      links.push({ rel: 'next', href: `${href}&f=html`, type: 'text/html' });
    }
    return json(
      200,
      {
        type: 'FeatureCollection',
        features: page.map((entry) => entry.feature),
        numberMatched: matched.length,
        numberReturned: page.length,
        timeStamp: options.timeStamp ?? '2026-10-01T00:00:00Z',
        links,
      },
      {
        'content-type': 'application/geo+json',
        ...(options.contentCrs === undefined ? {} : { 'content-crs': `<${options.contentCrs}>` }),
      },
    );
  });
}

function inside(
  [longitude, latitude]: [number, number],
  [west, south, east, north]: [number, number, number, number],
): boolean {
  if (latitude < south || latitude > north) return false;
  // 最小経度が最大経度より大きい領域は日付変更線をまたぐ。
  return west <= east
    ? longitude >= west && longitude <= east
    : longitude >= west || longitude <= east;
}

/** 位置 `at` の点の地物。 */
export function pointFeature(
  id: string | number | null,
  at: [number, number],
  properties: Record<string, unknown> = {},
): FakeFeature {
  return {
    at,
    feature: {
      type: 'Feature',
      ...(id === null ? {} : { id }),
      geometry: { type: 'Point', coordinates: at },
      properties,
    },
  };
}
