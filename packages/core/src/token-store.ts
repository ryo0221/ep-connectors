import type { ConnectionKey } from './connection.js';
import type { HttpRequest, HttpResponse } from './http.js';
import type { CatalogRejection } from './catalog.js';
import type { PolicyDenial } from './policy.js';

export type SendResult = { ok: true; response: HttpResponse } | { ok: false; error: SendError };

/**
 * `send` の失敗。文言・detail には token、送信した header、query 中の資格情報を含めない。
 * `transport` は送信後に応答が得られなかった場合も含むため、書込みでは結果不明として扱う。
 */
export type SendError =
  | { kind: 'policy'; reason: PolicyDenial }
  | { kind: 'catalog'; reason: CatalogRejection }
  | { kind: 'revoked' }
  | { kind: 'transport'; phase: 'before-send' | 'after-send' };

export type RefreshResult = { ok: true } | { ok: false; reason: 'revoked' | 'transport' };

/**
 * 資格情報を保管し、認証付きの要求を送る Host の差し口（全体設計 3.2）。Token は adapter へ渡らない。
 *
 * Host の `send` は次を必ず満たす（3.2.1）。目録の操作名・method・origin・path・query・header・
 * scope の検査（`checkCatalogRequest`）。認証付き要求の 3xx を辿らず、token を付けずに応答として返す。
 * Adapter が認証に関わる header を指定した要求は要求ごと拒否する。応答から認証に関わる header を
 * 除く（`stripCredentialResponseHeaders`）。SDK・HTTP client・proxy の暗黙の retry を無効にする。
 */
export interface TokenStore {
  send(key: ConnectionKey, request: HttpRequest): Promise<SendResult>;
  /** 同じ key への同時の refresh は、Host 側で一つにまとめる。 */
  refresh(key: ConnectionKey): Promise<RefreshResult>;
  /** 接続を解除し、その接続に束縛された同期の基点も無効にする。 */
  revoke(key: ConnectionKey): Promise<void>;
}

/** 認証の要らない通信の差し口（全体設計 3.7）。目録の `auth: 'none'` の操作だけを送る。 */
export interface HttpTransport {
  send(request: HttpRequest): Promise<SendResult>;
}
