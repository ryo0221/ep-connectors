import type { ConnectionKey } from './connection.js';
import type { HttpHeaders } from './http.js';

export interface InboundWebhook {
  headers: HttpHeaders;
  body: string;
  receivedAt: string;
}

/** 変化があり得るという合図だけ。通知の本文を変更内容として持たない。 */
export interface WebhookSignal {
  connection: ConnectionKey;
  subscription: string;
  /** 再取得する対象（calendar ID、repository ID など）。 */
  target: string;
  /** Provider の配送 ID。再配送の重複を除くために使う。 */
  deliveryId?: string;
}

export type WebhookVerification =
  | { ok: true; signal: WebhookSignal }
  | {
      ok: false;
      reason: 'bad-signature' | 'unknown-subscription' | 'duplicate-delivery' | 'malformed';
    };

/**
 * Provider からの変更通知の受け口（全体設計 3.5）。HTTPS の受信は Host が持つ。通知を受けたら
 * 再取得し、通知だけで同期を完了としない。
 */
export interface WebhookIntake {
  verify(request: InboundWebhook): Promise<WebhookVerification>;
}
