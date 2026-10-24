import type {
  ConnectionKey,
  JobHandler,
  JobOutcome,
  JsonValue,
  SyncEntry,
  SyncScope,
  SyncStateStore,
} from '@ep-connectors/core';
import type { FeatureRejection } from '../geo.js';
import { CRS84, checkBbox, isRecord } from '../geo.js';
import type { OgcFeaturesSource } from './catalog.js';
import type { FeatureQuery, FeatureReadError, FeatureSender, OgcFeaturesReader } from './read.js';
import { readFeaturesPage } from './read.js';

/**
 * OGC API Features には差分の基点も変更通知もない（Part 1）。そこで写しは毎回 baseline から
 * 作り直し、全ページを取り終えてから一つの世代として公開する。基点（cursor）は `null` で commit する。
 * 再取得は Host が定期的に、または rate limit の後に `read` の job として預ける。
 */
export function featuresScope(
  connection: ConnectionKey,
  source: OgcFeaturesSource,
  query: FeatureQuery,
): SyncScope {
  return {
    connection,
    target: `${source.provider}/collections/${query.collectionId}`,
    query: { kind: 'ogc-features.items', bbox: [...query.bbox], limit: query.limit, crs: CRS84 },
  };
}

/** `featuresScope` で作った scope から条件を読み直す。形が違えば `null`。 */
export function queryFromScope(source: OgcFeaturesSource, scope: SyncScope): FeatureQuery | null {
  if (scope.connection.provider !== source.provider) return null;
  const prefix = `${source.provider}/collections/`;
  if (!scope.target.startsWith(prefix)) return null;
  const collectionId = scope.target.slice(prefix.length);
  const query = scope.query;
  if (!isRecord(query) || query.kind !== 'ogc-features.items' || query.crs !== CRS84) return null;
  if (!Array.isArray(query.bbox) || typeof query.limit !== 'number') return null;
  const bbox = checkBbox(query.bbox as number[]);
  if (!bbox.ok || collectionId === '') return null;
  return { collectionId, bbox: bbox.bbox, limit: query.limit };
}

export interface FeatureSyncOptions {
  /** これを超えるページ数の写しは公開しない（途中までの写しを全体として見せないため）。 */
  maxPages?: number;
}

export const DEFAULT_MAX_PAGES = 100;

export type FeatureSyncError =
  | { kind: 'read'; error: FeatureReadError }
  | { kind: 'too-many-pages'; maxPages: number }
  | { kind: 'paging-loop' }
  | { kind: 'storage'; reason: 'unknown-staging' };

/** 写しに入れなかった地物。`page` は 0 から数えたページ、`index` はそのページの中の位置。 */
export type SyncRejection = FeatureRejection & { page: number };

export type FeatureSyncResult =
  | {
      ok: true;
      generation: number;
      stored: number;
      rejected: SyncRejection[];
      numberMatched: number | null;
    }
  /** 別の取得が先に新しい世代を公開した。この取得は公開しない。 */
  | { ok: false; reason: 'superseded'; current: number | null }
  | { ok: false; reason: 'failed'; error: FeatureSyncError };

/**
 * 領域の地物を全ページ読み、`SyncStateStore` へ一つの世代として公開する。公開済みの世代が
 * `expectedGeneration` と違えば公開しない（世代の CAS）。途中で失敗した staging は公開されず、
 * 次の取得は最初のページからやり直す。ID のない地物は写しに入れず、`missing-id` として返す。
 */
export async function syncFeatures(
  reader: OgcFeaturesReader,
  store: SyncStateStore,
  scope: SyncScope,
  query: FeatureQuery,
  expectedGeneration: number | null,
  options: FeatureSyncOptions = {},
): Promise<FeatureSyncResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const staged = await store.stage(scope, null);
  if (!staged.ok) return { ok: false, reason: 'superseded', current: null };
  const { stagedGeneration } = staged;

  const rejected: SyncRejection[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let stored = 0;
  let numberMatched: number | null = null;
  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex >= maxPages) return failed({ kind: 'too-many-pages', maxPages });
    const read = await readFeaturesPage(reader, query, cursor);
    if (!read.ok) return failed({ kind: 'read', error: read.error });
    const page = read.value;
    if (pageIndex === 0) numberMatched = page.numberMatched;

    // 受け付けた地物の、応答の中での位置。拒否された位置を飛ばして数える。
    const rejectedAt = new Set(page.rejected.map((rejection) => rejection.index));
    const positions: number[] = [];
    for (let i = 0; positions.length < page.features.length; i += 1) {
      if (!rejectedAt.has(i)) positions.push(i);
    }
    rejected.push(...page.rejected.map((rejection) => ({ ...rejection, page: pageIndex })));
    const upserts: SyncEntry[] = [];
    page.features.forEach((feature, accepted) => {
      if (feature.id === null) {
        rejected.push({
          index: positions[accepted] as number,
          id: null,
          reason: 'missing-id',
          page: pageIndex,
        });
        return;
      }
      upserts.push({
        id: feature.id,
        value: { geometry: feature.geometry, properties: feature.properties } as JsonValue,
      });
    });
    const applied = await store.applyPage(scope, stagedGeneration, { upserts, removals: [] });
    if (!applied.ok) return failed({ kind: 'storage', reason: 'unknown-staging' });
    stored += upserts.length;

    if (page.next === null) break;
    if (seen.has(page.next)) return failed({ kind: 'paging-loop' });
    seen.add(page.next);
    cursor = page.next;
  }

  const committed = await store.commit(scope, expectedGeneration, stagedGeneration, null);
  if (!committed.ok) {
    if (committed.reason === 'generation-mismatch') {
      return { ok: false, reason: 'superseded', current: committed.current };
    }
    return failed({ kind: 'storage', reason: 'unknown-staging' });
  }
  return { ok: true, generation: committed.generation, stored, rejected, numberMatched };
}

export interface FeaturesReadHandlerOptions extends FeatureSyncOptions {
  source: OgcFeaturesSource;
  store: SyncStateStore;
  clock: OgcFeaturesReader['clock'];
  /** Job の scope の接続に合わせて送る経路を返す。`auth: 'none'` の配備では接続を使わない。 */
  sender(connection: ConnectionKey): FeatureSender;
  /** 待機の指示がない一時障害の後、次に試すまでの時間。既定は 60 秒。 */
  retryDelayMs?: number;
}

/**
 * `read` の job を処理する handler。Host のキューは呼ぶ直前に `authorizeDispatch` で再確認する。
 * Rate limit と一時障害は `retry`、それ以外の失敗は理由付きで `abandoned` にする。別の取得が先に
 * 公開していれば、古い世代で上書きせずに `done` とする。
 */
export function createFeaturesReadHandler(options: FeaturesReadHandlerOptions): JobHandler {
  return async (job): Promise<JobOutcome> => {
    if (job.kind !== 'read') return { kind: 'abandoned', reason: 'unsupported-job' };
    const query = queryFromScope(options.source, job.scope);
    if (!query) return { kind: 'abandoned', reason: 'unknown-scope' };
    const reader: OgcFeaturesReader = {
      source: options.source,
      send: options.sender(job.scope.connection),
      clock: options.clock,
    };
    const result = await syncFeatures(
      reader,
      options.store,
      job.scope,
      query,
      job.expectedGeneration,
      options.maxPages === undefined ? {} : { maxPages: options.maxPages },
    );
    if (result.ok || result.reason === 'superseded') return { kind: 'done' };
    return outcomeFor(result.error, options);
  };
}

function outcomeFor(error: FeatureSyncError, options: FeaturesReadHandlerOptions): JobOutcome {
  const later = () =>
    new Date(Date.parse(options.clock.now()) + (options.retryDelayMs ?? 60_000)).toISOString();
  if (error.kind !== 'read') return { kind: 'abandoned', reason: error.kind };
  const read = error.error;
  switch (read.kind) {
    case 'rate-limited':
    case 'unavailable':
      return { kind: 'retry', notBefore: read.retryAfter ?? later() };
    case 'send':
      // 読取は外部に作用を残さないため、送信後の失敗でも再取得してよい。
      return read.error.kind === 'transport'
        ? { kind: 'retry', notBefore: later() }
        : { kind: 'abandoned', reason: `send:${read.error.kind}` };
    default:
      return { kind: 'abandoned', reason: read.kind };
  }
}

function failed(error: FeatureSyncError): FeatureSyncResult {
  return { ok: false, reason: 'failed', error };
}
