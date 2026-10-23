import type {
  ConnectionKey,
  InboundWebhook,
  WebhookIntake,
  WebhookVerification,
} from '@ep-connectors/core';
import { normalizeHeaders } from '@ep-connectors/core';

export interface RegisteredSubscription {
  subscription: string;
  connection: ConnectionKey;
  target: string;
  secret: string;
}

export interface MemoryWebhookBacking {
  subscriptions: Map<string, RegisteredSubscription>;
  deliveries: Set<string>;
}

export function createWebhookBacking(
  subscriptions: RegisteredSubscription[] = [],
): MemoryWebhookBacking {
  return {
    subscriptions: new Map(subscriptions.map((entry) => [entry.subscription, entry])),
    deliveries: new Set(),
  };
}

export const SIGNATURE_HEADER = 'x-fake-signature';
export const SUBSCRIPTION_HEADER = 'x-fake-subscription';
export const DELIVERY_HEADER = 'x-fake-delivery';

/**
 * 試験専用の `WebhookIntake`。偽の Provider の署名（body の HMAC-SHA256）を検証し、購読の登録から
 * 合図を作る。通知の本文は署名の検証にだけ使う。
 */
export class MemoryWebhookIntake implements WebhookIntake {
  constructor(private readonly backing: MemoryWebhookBacking) {}

  async verify(request: InboundWebhook): Promise<WebhookVerification> {
    const headers = normalizeHeaders(request.headers);
    const subscriptionId = headers[SUBSCRIPTION_HEADER];
    const signature = headers[SIGNATURE_HEADER];
    const deliveryId = headers[DELIVERY_HEADER];
    if (!subscriptionId || !signature || !deliveryId) return { ok: false, reason: 'malformed' };
    const subscription = this.backing.subscriptions.get(subscriptionId);
    if (!subscription) return { ok: false, reason: 'unknown-subscription' };
    const expected = await signBody(subscription.secret, request.body);
    if (!constantTimeEqual(expected, signature)) return { ok: false, reason: 'bad-signature' };
    const deliveryKey = `${subscriptionId}\u0000${deliveryId}`;
    if (this.backing.deliveries.has(deliveryKey))
      return { ok: false, reason: 'duplicate-delivery' };
    this.backing.deliveries.add(deliveryKey);
    return {
      ok: true,
      signal: {
        connection: structuredClone(subscription.connection),
        subscription: subscription.subscription,
        target: subscription.target,
        deliveryId,
      },
    };
  }
}

export async function signBody(secret: string, body: string): Promise<string> {
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

/** 偽の Provider として署名した通知を作る。 */
export async function fakeWebhook(
  subscription: Pick<RegisteredSubscription, 'subscription' | 'secret'>,
  body: string,
  deliveryId: string,
  receivedAt = '2026-01-01T00:00:00.000Z',
): Promise<InboundWebhook> {
  return {
    headers: {
      [SUBSCRIPTION_HEADER]: subscription.subscription,
      [DELIVERY_HEADER]: deliveryId,
      [SIGNATURE_HEADER]: await signBody(subscription.secret, body),
    },
    body,
    receivedAt,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
