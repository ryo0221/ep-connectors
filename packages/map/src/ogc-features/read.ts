import type {
  Clock,
  ConnectionKey,
  HttpRequest,
  HttpResponse,
  HttpTransport,
  SendError,
  SendResult,
  TokenStore,
} from '@ep-connectors/core';
import type { Bbox, FeatureRejection, GeoFeature } from '../geo.js';
import { CRS84, checkBbox, isRecord, parseFeature, plainText, sameBbox } from '../geo.js';
import type { OgcFeaturesSource } from './catalog.js';
import {
  collectionPath,
  DEFAULT_PAGING_PARAMETERS,
  itemsPath,
  OGC_FEATURES_OPERATIONS,
  withFixedQuery,
} from './catalog.js';

/** 要求を送る経路。配備の `auth` に合わせて Host が選ぶ。 */
export type FeatureSender = (request: HttpRequest) => Promise<SendResult>;

export function tokenSender(store: TokenStore, connection: ConnectionKey): FeatureSender {
  return (request) => store.send(connection, request);
}

export function transportSender(transport: HttpTransport): FeatureSender {
  return (request) => transport.send(request);
}

export interface OgcFeaturesReader {
  source: OgcFeaturesSource;
  send: FeatureSender;
  clock: Clock;
}

/** 領域での検索の条件。座標は CRS84 に限る。 */
export interface FeatureQuery {
  collectionId: string;
  bbox: Bbox;
  /** 一ページの件数。1〜10000。配備がこれより少なく返すことがある。 */
  limit: number;
}

export const MAX_LIMIT = 10000;

/** 出典として返す link。`href` は未信頼の文字列であり、自動で fetch しない。 */
export type SourceLink = { rel: string; href: string; type: string | null; title: string | null };

export type FeatureProvenance = {
  provider: string;
  origin: string;
  collectionId: string;
  /** 取得した時刻（`Clock`）。 */
  retrievedAt: string;
  /** 配備が返した時刻（`timeStamp`）。 */
  timeStamp: string | null;
  /** 応答に含まれた `license`・`describedby` の link。 */
  links: SourceLink[];
};

export type FeaturePage = {
  collectionId: string;
  crs: typeof CRS84;
  bbox: Bbox;
  features: GeoFeature[];
  rejected: FeatureRejection[];
  /** 配備が返した条件に合う件数。返さない配備では `null`。 */
  numberMatched: number | null;
  /** 次のページの基点。`next` link の URL を検査したもの。最後のページでは `null`。 */
  next: string | null;
  provenance: FeatureProvenance;
};

export type CollectionDescription = {
  collectionId: string;
  title: string | null;
  description: string | null;
  /** 配備が宣言した範囲（CRS84）。宣言がなければ `null`。 */
  extent: Bbox | null;
  /** 配備が返せる CRS。Part 2 の宣言がなければ CRS84 だけとみなす。 */
  crs: string[];
  supportsCrs84: boolean;
  /** 出典の表示（`attribution`）。宣言がなければ `null`。 */
  attribution: string | null;
  licenses: SourceLink[];
  retrievedAt: string;
};

export type NextLinkRejection = 'url' | 'origin' | 'path' | 'query' | 'bbox' | 'limit';

export type FeatureReadError =
  | { kind: 'invalid-query'; reason: 'bbox' | 'limit' | 'collection' }
  /** 渡された基点が、この条件の `next` link として通らない。 */
  | { kind: 'invalid-cursor'; reason: NextLinkRejection }
  /** 配備が返した `next` link が検査を通らない。辿らずに止める。 */
  | { kind: 'next-link'; reason: NextLinkRejection }
  | { kind: 'send'; error: SendError }
  | { kind: 'rate-limited'; retryAfter: string | null }
  | { kind: 'unavailable'; status: number; retryAfter: string | null }
  | { kind: 'http'; status: number }
  /** CRS84 以外の座標が返った。変換せずに拒否する。 */
  | { kind: 'unsupported-crs'; crs: string }
  | { kind: 'invalid-response'; reason: string };

export type FeatureReadResult<T> = { ok: true; value: T } | { ok: false; error: FeatureReadError };

const ACCEPT = 'application/geo+json, application/json;q=0.9';
const CRS84_URIS = [CRS84, CRS84.replace(/^http:/, 'https:')];

/**
 * 一ページを読む（OGC API Features Part 1 の `/collections/{collectionId}/items`）。`cursor` が
 * `null` なら最初のページ、そうでなければ前のページの `next` を渡す。基点は呼出しの外から戻って
 * くる未信頼の値として、毎回同じ条件の `next` link として検査し直す。
 */
export async function readFeaturesPage(
  reader: OgcFeaturesReader,
  query: FeatureQuery,
  cursor: string | null,
): Promise<FeatureReadResult<FeaturePage>> {
  const invalid = checkQuery(query);
  if (invalid) return fail({ kind: 'invalid-query', reason: invalid });
  const { source } = reader;

  let url: string;
  if (cursor === null) {
    const first = withFixedQuery(
      source,
      new URL(`${source.origin}${itemsPath(source, query.collectionId)}`),
    );
    first.searchParams.set('bbox', query.bbox.join(','));
    first.searchParams.set('limit', String(query.limit));
    url = first.toString();
  } else {
    const checked = checkNextLink(source, query, cursor, cursor);
    if (!checked.ok) return fail({ kind: 'invalid-cursor', reason: checked.reason });
    url = checked.url;
  }

  const sent = await reader.send({
    operation: OGC_FEATURES_OPERATIONS.items,
    method: 'GET',
    url,
    headers: { accept: ACCEPT },
  });
  const response = checkResponse(reader, sent);
  if (!response.ok) return response;
  const crs = responseCrs(response.value);
  if (crs !== null && !CRS84_URIS.includes(crs)) return fail({ kind: 'unsupported-crs', crs });

  const body = parseJson(response.value);
  if (!isRecord(body) || body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
    return fail({ kind: 'invalid-response', reason: 'not a FeatureCollection' });
  }

  const features: GeoFeature[] = [];
  const rejected: FeatureRejection[] = [];
  body.features.forEach((value, index) => {
    const parsed = parseFeature(value);
    if (parsed.ok) features.push(parsed.feature);
    else rejected.push({ index, id: parsed.id, reason: parsed.reason });
  });

  // `links` がないのは最後のページとしてよいが、配列でない `links` は次のページの有無を読めない。
  if (body.links !== undefined && !Array.isArray(body.links)) {
    return fail({ kind: 'invalid-response', reason: 'links' });
  }
  const { links, brokenNext } = parseLinks(body.links, url);
  if (brokenNext) return fail({ kind: 'next-link', reason: 'url' });
  let next: string | null = null;
  const nextLinks = links.filter((link) => link.rel === 'next');
  if (nextLinks.length > 0) {
    const chosen = chooseNextLink(nextLinks);
    if (!chosen) return fail({ kind: 'invalid-response', reason: 'no GeoJSON next link' });
    const checked = checkNextLink(source, query, chosen.href, url);
    if (!checked.ok) return fail({ kind: 'next-link', reason: checked.reason });
    next = checked.url;
  }

  return {
    ok: true,
    value: {
      collectionId: query.collectionId,
      crs: CRS84,
      bbox: [...query.bbox],
      features,
      rejected,
      numberMatched: count(body.numberMatched),
      next,
      provenance: {
        provider: source.provider,
        origin: source.origin,
        collectionId: query.collectionId,
        retrievedAt: reader.clock.now(),
        timeStamp: typeof body.timeStamp === 'string' ? plainText(body.timeStamp) : null,
        links: links.filter((link) => link.rel === 'license' || link.rel === 'describedby'),
      },
    },
  };
}

/** Collection の説明（`/collections/{collectionId}`）を読む。出典・利用条件・CRS の宣言を返す。 */
export async function describeCollection(
  reader: OgcFeaturesReader,
  collectionId: string,
): Promise<FeatureReadResult<CollectionDescription>> {
  if (collectionId === '') return fail({ kind: 'invalid-query', reason: 'collection' });
  const { source } = reader;
  const url = withFixedQuery(
    source,
    new URL(`${source.origin}${collectionPath(source, collectionId)}`),
  ).toString();
  const sent = await reader.send({
    operation: OGC_FEATURES_OPERATIONS.collection,
    method: 'GET',
    url,
    headers: { accept: 'application/json' },
  });
  const response = checkResponse(reader, sent);
  if (!response.ok) return response;
  const body = parseJson(response.value);
  if (!isRecord(body)) return fail({ kind: 'invalid-response', reason: 'not a collection' });

  const declared = Array.isArray(body.crs)
    ? body.crs.filter((value): value is string => typeof value === 'string').map(plainText)
    : [];
  const crs = declared.length > 0 ? declared : [CRS84];
  return {
    ok: true,
    value: {
      collectionId,
      title: optionalText(body.title),
      description: optionalText(body.description),
      extent: declaredExtent(body.extent),
      crs,
      supportsCrs84: crs.some((value) => CRS84_URIS.includes(value)),
      attribution: optionalText(body.attribution),
      licenses: parseLinks(body.links, url).links.filter((link) => link.rel === 'license'),
      retrievedAt: reader.clock.now(),
    },
  };
}

/**
 * `next` link（または外から戻ってきた基点）を検査する。同じ配備・同じ collection の items で、
 * 領域が変わらず、許可した query parameter だけを持つものに限る。目録の検査（Host）に加えて、
 * 条件が途中で変わること（領域を外した全件の取得など）を adapter の側で止める。
 */
export function checkNextLink(
  source: OgcFeaturesSource,
  query: FeatureQuery,
  href: string,
  base: string,
): { ok: true; url: string } | { ok: false; reason: NextLinkRejection } {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return { ok: false, reason: 'url' };
  }
  if (url.username || url.password || url.hash) return { ok: false, reason: 'url' };
  if (url.protocol !== 'https:' || url.origin !== new URL(source.origin).origin) {
    return { ok: false, reason: 'origin' };
  }
  if (url.pathname !== itemsPath(source, query.collectionId)) return { ok: false, reason: 'path' };

  const paging = ['bbox', 'limit', ...(source.pagingParameters ?? DEFAULT_PAGING_PARAMETERS)];
  const fixed = source.fixedQuery ?? {};
  const names = [...url.searchParams.keys()];
  if (names.some((name) => !paging.includes(name) && !Object.hasOwn(fixed, name))) {
    return { ok: false, reason: 'query' };
  }
  if (new Set(names).size !== names.length) return { ok: false, reason: 'query' };
  // 固定の query は値も同じものに限る（`f=html` などの別の形式へ移らない）。
  for (const [name, value] of Object.entries(fixed)) {
    if (paging.includes(name)) continue;
    const actual = url.searchParams.get(name);
    if (actual !== null && actual !== value) return { ok: false, reason: 'query' };
  }

  const bbox = url.searchParams.get('bbox');
  const parsed = bbox === null ? null : checkBbox(bbox.split(',').map(strictNumber));
  if (!parsed?.ok || !sameBbox(parsed.bbox, query.bbox)) return { ok: false, reason: 'bbox' };

  const limit = url.searchParams.get('limit');
  if (limit !== null) {
    const value = strictNumber(limit);
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
      return { ok: false, reason: 'limit' };
    }
  }
  // `next` が固定の query を落としていても、全ての要求に付ける。
  return { ok: true, url: withFixedQuery(source, url).toString() };
}

function checkQuery(query: FeatureQuery): 'bbox' | 'limit' | 'collection' | null {
  if (query.collectionId === '') return 'collection';
  if (!checkBbox(query.bbox).ok) return 'bbox';
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) return 'limit';
  return null;
}

function checkResponse(
  reader: OgcFeaturesReader,
  sent: SendResult,
): FeatureReadResult<HttpResponse> {
  if (!sent.ok) return fail({ kind: 'send', error: sent.error });
  const { response } = sent;
  if (response.status === 429) {
    return fail({ kind: 'rate-limited', retryAfter: retryAfter(reader.clock, response) });
  }
  if (response.status >= 500) {
    return fail({
      kind: 'unavailable',
      status: response.status,
      retryAfter: retryAfter(reader.clock, response),
    });
  }
  // 3xx も辿らない。配備の移転は Host の設定（`OgcFeaturesSource`）の変更として扱う。
  if (response.status !== 200) return fail({ kind: 'http', status: response.status });
  const type = (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/geo+json' && type !== 'application/json') {
    return fail({ kind: 'invalid-response', reason: 'content-type' });
  }
  return { ok: true, value: response };
}

/** Part 2 の `Content-Crs` header（`<uri>`）。ない応答は Part 1 の既定の CRS84 とする。 */
function responseCrs(response: HttpResponse): string | null {
  const value = response.headers['content-crs'];
  if (value === undefined) return null;
  return plainText(value.trim().replace(/^<(.*)>$/, '$1'));
}

function retryAfter(clock: Clock, response: HttpResponse): string | null {
  const value = response.headers['retry-after']?.trim();
  if (!value) return null;
  const date = /^\d+$/.test(value)
    ? Date.parse(clock.now()) + Number(value) * 1000
    : Date.parse(value);
  // 表せない時刻は待機の指示がないものとして扱い、呼ぶ側の既定の待機に任せる。
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseJson(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    return undefined;
  }
}

/**
 * `brokenNext` は、読めない `next` link があったこと。黙って捨てると最後のページと区別できず、
 * 途中までの写しを全体として公開してしまう。
 */
function parseLinks(value: unknown, base: string): { links: SourceLink[]; brokenNext: boolean } {
  const links: SourceLink[] = [];
  let brokenNext = false;
  if (!Array.isArray(value)) return { links, brokenNext };
  for (const link of value) {
    if (!isRecord(link) || typeof link.rel !== 'string') continue;
    let href: string;
    try {
      if (typeof link.href !== 'string') throw new TypeError('href');
      href = new URL(link.href, base).toString();
    } catch {
      if (link.rel === 'next') brokenNext = true;
      continue;
    }
    links.push({
      rel: link.rel,
      href,
      type: optionalText(link.type),
      title: optionalText(link.title),
    });
  }
  return { links, brokenNext };
}

/** GeoJSON の `next` を選ぶ。HTML など別の形式の link しかなければ `null`。 */
function chooseNextLink(links: SourceLink[]): SourceLink | null {
  const type = (link: SourceLink) => link.type?.split(';')[0]?.trim().toLowerCase() ?? null;
  return (
    links.find((link) => type(link) === 'application/geo+json') ??
    links.find((link) => type(link) === 'application/json') ??
    links.find((link) => type(link) === null) ??
    null
  );
}

function declaredExtent(value: unknown): Bbox | null {
  if (!isRecord(value) || !isRecord(value.spatial) || !Array.isArray(value.spatial.bbox)) {
    return null;
  }
  const crs = value.spatial.crs;
  if (crs !== undefined && (typeof crs !== 'string' || !CRS84_URIS.includes(crs))) return null;
  const first: unknown = value.spatial.bbox[0];
  if (!Array.isArray(first)) return null;
  const checked = checkBbox(first as number[]);
  return checked.ok ? checked.bbox : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? plainText(value) : null;
}

function count(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function strictNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function fail<T>(error: FeatureReadError): FeatureReadResult<T> {
  return { ok: false, error };
}
