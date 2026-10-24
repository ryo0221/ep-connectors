import type { OperationCatalog } from '@ep-connectors/core';

/**
 * 一つの OGC API Features の配備。Host が信頼できる設定として持ち、目録はここから静的に作る。
 * 実行時に Provider の応答から目録を増やさない。
 */
export interface OgcFeaturesSource {
  /** 目録と `ConnectionKey.provider` の名前。例 `ogc-features:example`。 */
  provider: string;
  /** Scheme・host・port。`https:` に限る。 */
  origin: string;
  /** Landing page の path。root に置かれた配備では `''`。例 `/ogcapi`。末尾の `/` は付けない。 */
  basePath: string;
  /** 公開データは `none`（`HttpTransport`）、認証の要る配備は `token`（`TokenStore.send`）。 */
  auth: 'none' | 'token';
  /** `auth: 'token'` のとき各操作に要る scope。 */
  scopes?: readonly string[];
  /**
   * `next` link が使う paging の query parameter。配備ごとに違う（`offset`、`startIndex` など）ため、
   * Host が配備に合わせて宣言する。載っていない parameter を含む `next` link は辿らない。
   */
  pagingParameters?: readonly string[];
}

export const DEFAULT_PAGING_PARAMETERS: readonly string[] = ['offset', 'startIndex', 'startindex'];

export const OGC_FEATURES_OPERATIONS = {
  collection: 'features.collection',
  items: 'features.items',
} as const;

/** 読取の要求で adapter が付ける query parameter。 */
const ITEMS_QUERY = ['bbox', 'limit'];

export function collectionPath(source: OgcFeaturesSource, collectionId: string): string {
  return `${source.basePath}/collections/${encodeURIComponent(collectionId)}`;
}

export function itemsPath(source: OgcFeaturesSource, collectionId: string): string {
  return `${collectionPath(source, collectionId)}/items`;
}

/** 配備の操作の目録（全体設計 3.2.1）。読取の二つの操作だけを載せる。 */
export function ogcFeaturesCatalog(source: OgcFeaturesSource): OperationCatalog {
  const scopes = source.auth === 'token' ? [...(source.scopes ?? [])] : [];
  const paging = source.pagingParameters ?? DEFAULT_PAGING_PARAMETERS;
  return {
    provider: source.provider,
    operations: [
      {
        name: OGC_FEATURES_OPERATIONS.collection,
        method: 'GET',
        origin: source.origin,
        path: `${source.basePath}/collections/{collectionId}`,
        headers: ['accept'],
        scopes,
        auth: source.auth,
      },
      {
        name: OGC_FEATURES_OPERATIONS.items,
        method: 'GET',
        origin: source.origin,
        path: `${source.basePath}/collections/{collectionId}/items`,
        query: [...ITEMS_QUERY, ...paging.filter((name) => !ITEMS_QUERY.includes(name))],
        headers: ['accept'],
        scopes,
        auth: source.auth,
      },
    ],
  };
}
