import type {
  ConnectionKey,
  InboundWebhook,
  JobRef,
  WebhookIntake,
  WebhookSignal,
  WebhookVerification,
} from '@ep-connectors/core';
import { normalizeHeaders } from '@ep-connectors/core';
import { workItemsScope } from './dto.js';

export const SIGNATURE_HEADER = 'x-hub-signature-256';
export const DELIVERY_HEADER = 'x-github-delivery';
export const EVENT_HEADER = 'x-github-event';

export interface GithubWebhookIntakeOptions {
  /** App の webhook secret。Host の信頼境界の中から読む。 */
  secret(): Promise<string>;
  /**
   * Installation と repository から、合図を届ける接続と購読を Host が引く。導入範囲の外や、
   * 対応表にない repository なら `null`。
   */
  resolve(
    installationId: number,
    repositoryId: string,
  ): Promise<{ connection: ConnectionKey; subscription: string } | null>;
  /** 配送 ID を atomic に記録し、初めてなら `true`。Host の保管で再配送を一度だけ扱う。 */
  recordDelivery(deliveryId: string): Promise<boolean>;
}

/**
 * GitHub の webhook の `WebhookIntake`。HTTPS の受信は Host が持ち、ここは署名
 * （`X-Hub-Signature-256`、body の HMAC-SHA256）の検証、配送 ID（`X-GitHub-Delivery`）での重複の除去、
 * 合図への変換だけを行う。本文からは宛先（installation と repository の node ID）だけを読み、
 * 変更内容として扱わない。
 */
export class GithubWebhookIntake implements WebhookIntake {
  constructor(private readonly options: GithubWebhookIntakeOptions) {}

  async verify(request: InboundWebhook): Promise<WebhookVerification> {
    const headers = normalizeHeaders(request.headers);
    const signature = headers[SIGNATURE_HEADER];
    const deliveryId = headers[DELIVERY_HEADER];
    if (!signature || !deliveryId || !headers[EVENT_HEADER]) {
      return { ok: false, reason: 'malformed' };
    }
    const expected = await githubSignature(await this.options.secret(), request.body);
    if (!constantTimeEqual(expected, signature)) return { ok: false, reason: 'bad-signature' };

    const target = webhookTarget(request.body);
    if (!target) return { ok: false, reason: 'malformed' };
    const resolved = await this.options.resolve(target.installationId, target.repositoryId);
    if (!resolved) return { ok: false, reason: 'unknown-subscription' };
    // 署名を確かめてから記録する。偽の通知で配送 ID を使い切らせない。
    if (!(await this.options.recordDelivery(deliveryId))) {
      return { ok: false, reason: 'duplicate-delivery' };
    }
    return {
      ok: true,
      signal: {
        connection: resolved.connection,
        subscription: resolved.subscription,
        target: target.repositoryId,
        deliveryId,
      },
    };
  }
}

function webhookTarget(body: string): { installationId: number; repositoryId: string } | null {
  try {
    const payload = JSON.parse(body) as {
      installation?: { id?: unknown };
      repository?: { node_id?: unknown };
    };
    const installationId = payload.installation?.id;
    const repositoryId = payload.repository?.node_id;
    if (!Number.isInteger(installationId) || typeof repositoryId !== 'string' || !repositoryId) {
      return null;
    }
    return { installationId: installationId as number, repositoryId };
  } catch {
    return null;
  }
}

/** 合図を受けたら、その repository の一覧を再取得する `read` job にする。 */
export function workItemsJob(signal: WebhookSignal): JobRef {
  return {
    kind: 'read',
    scope: workItemsScope(signal.connection, signal.target),
    expectedGeneration: null,
  };
}

export async function githubSignature(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `sha256=${Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
