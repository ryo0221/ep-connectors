import type { ConnectionKey } from './connection.js';
import type { JobRef } from './job-queue.js';

export type PolicyDenial =
  | 'not-current-session'
  | 'revoked'
  | 'tenant-changed'
  | 'connection-generation-changed'
  | 'membership-changed'
  | 'plan-expired'
  | 'plan-digest-mismatch'
  | 'forbidden';

export type PolicyDecision = { ok: true } | { ok: false; reason: PolicyDenial };

/**
 * 誰が実行してよいかを判断する Host の差し口。ライブラリは判定を持たず、各操作の直前に問い合わせる。
 * 判定は呼出しのたびに Host の現在の状態から行い、前回の結果を使い回さない。
 */
export interface HostPolicy {
  /** 渡された key が、現在の session の principal に属する現在の世代の接続か。 */
  authorizeConnection(key: ConnectionKey): Promise<PolicyDecision>;
  /**
   * Job を実行する直前の再確認（全体設計 3.4）。種類ごとに確かめる内容が違う。
   * `step`: 計画の有効期限と digest、principal・membership・connection、送信先への権限。
   * `read`: scope の principal・connection・対象への閲覧の認可、期待する世代。
   * `subscription`: 購読の所有者と connection の有効性。
   */
  authorizeDispatch(job: JobRef): Promise<PolicyDecision>;
}
