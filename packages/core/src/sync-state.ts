import type { ConnectionKey } from './connection.js';
import type { JsonValue } from './json.js';

/**
 * 同期の基点を束縛する条件（全体設計 3.6）。条件の違う基点を流用しない。
 */
export interface SyncScope {
  connection: ConnectionKey;
  /** Calendar、sheet、folder、repository などの対象。 */
  target: string;
  /** 取得条件（field、filter など）。 */
  query: JsonValue;
  /** 固定した期間（Microsoft の期間付き delta など）。 */
  window?: { start: string; end: string };
}

export interface SyncEntry {
  id: string;
  value: JsonValue;
}

/** 公開済みの世代。読む側はこれだけを見る。 */
export interface PublishedSync {
  generation: number;
  cursor: string | null;
  entries: SyncEntry[];
}

export interface SyncPage {
  upserts: readonly SyncEntry[];
  removals: readonly string[];
}

export type StageResult =
  | { ok: true; stagedGeneration: number }
  | { ok: false; reason: 'stale-base' };
export type PageResult = { ok: true } | { ok: false; reason: 'unknown-staging' };
export type InvalidateResult =
  | { ok: true }
  | { ok: false; reason: 'generation-mismatch'; current: number | null };
export type CommitResult =
  | { ok: true; generation: number }
  | { ok: false; reason: 'generation-mismatch' | 'unknown-staging'; current: number | null };

/**
 * 外部 cache と同期の基点の保管（全体設計 3.6）。取得したページを新しい世代の staging へ書き、
 * 全ページを適用してから cache の世代と基点を `commit` で一体に公開する。
 *
 * Host が cache と基点を同じ保管で atomic に更新できない場合も、公開の印（どの世代と基点の組が
 * 公開済みか）を一つの記録として CAS で書き、基点はその印の中にだけ保管する。再起動の後は
 * 印が指す組から再開し、印が指していない staging だけを捨てる。
 */
export interface SyncStateStore {
  read(scope: SyncScope): Promise<PublishedSync | null>;
  /**
   * 新しい世代の staging を始める。`basedOn` が公開済みの世代なら、その cache の上に差分を適用する。
   * `null` は baseline からの作り直し（初回、410、baseline の喪失）。
   */
  stage(scope: SyncScope, basedOn: number | null): Promise<StageResult>;
  applyPage(scope: SyncScope, stagedGeneration: number, page: SyncPage): Promise<PageResult>;
  /** 公開済みの世代が `expectedGeneration` のときだけ、staging と基点を一体で公開する（CAS）。 */
  commit(
    scope: SyncScope,
    expectedGeneration: number | null,
    stagedGeneration: number,
    cursor: string | null,
  ): Promise<CommitResult>;
  /**
   * Baseline と基点を無効にする。台帳・未解決の operation・Host の binding は消さない。
   * `expectedGeneration` を渡したときは、公開済みの世代がそれと一致するときだけ無効にする（CAS）。
   * 410 を受けた worker が、その間に別の worker が公開した新しい世代を消さないために使う。
   * 比較と削除は一つの操作として行い、`commit` と同じ保管で atomic にする。省くと無条件に無効にする。
   */
  invalidate(scope: SyncScope, expectedGeneration?: number): Promise<InvalidateResult>;
  /** その接続（世代を問わない）に束縛されたすべての scope を無効にする。`TokenStore.revoke` が使う。 */
  invalidateConnection(connection: ConnectionKey): Promise<void>;
}
