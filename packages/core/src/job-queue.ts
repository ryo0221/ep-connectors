import type { ConnectionKey } from './connection.js';
import type { SyncScope } from './sync-state.js';

/**
 * キューへ預ける job の参照（全体設計 3.4）。Payload の写しを持たず、実行するときに台帳や
 * `SyncStateStore` から読み直す。
 */
export type JobRef =
  | { kind: 'step'; operation: string; step: string }
  | {
      kind: 'read';
      scope: SyncScope;
      expectedGeneration: number | null;
      /**
       * 取り直しが要ると分かった時刻（ISO 8601。Webhook の受信、失敗した取得など）。この時刻より
       * あとに始まった取得がすでに公開されていれば、その job は取りに行かずに終えてよい。遅れて
       * 届いた重複の配送を、変更を読み落とさずに見分けるために使う。
       */
      requestedAt?: string;
    }
  | { kind: 'subscription'; connection: ConnectionKey; subscription: string };

export interface EnqueueOptions {
  /** ISO 8601 の時刻。これより前には実行しない。 */
  notBefore?: string;
}

/**
 * 再試行と非同期の照合を Host の実行基盤へ預ける差し口。Host は job を実行する直前に必ず
 * `HostPolicy.authorizeDispatch(job)` を呼び、拒否されたら handler を呼ばずに終える。
 * 「一回だけ配送する」保証は求めない。重複の抑止は台帳と `SyncStateStore` の世代で行う。
 */
export interface JobQueue {
  enqueue(job: JobRef, options?: EnqueueOptions): Promise<{ jobId: string }>;
}

/** Host のキューが job ごとに呼ぶ、ライブラリ側の処理。 */
export type JobHandler = (job: JobRef) => Promise<JobOutcome>;

export type JobOutcome =
  | { kind: 'done' }
  | { kind: 'retry'; notBefore: string }
  | { kind: 'abandoned'; reason: string };
