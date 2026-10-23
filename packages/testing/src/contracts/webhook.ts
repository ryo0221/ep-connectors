import { describe, expect, it } from 'vitest';
import type { ConnectionKey, InboundWebhook, WebhookIntake } from '@ep-connectors/core';

export interface WebhookContractHarness {
  intake(): WebhookIntake;
  /** 登録済みの購読と、その購読に束縛された接続・対象。 */
  subscription: string;
  connection: ConnectionKey;
  target: string;
  /** 偽の Provider として正しく署名した通知。 */
  signed(body: string, deliveryId: string): Promise<InboundWebhook>;
  /** 別の secret で署名した通知。 */
  forged(body: string, deliveryId: string): Promise<InboundWebhook>;
  /** 登録されていない購読への、署名の形だけ正しい通知。 */
  unknownSubscription(body: string, deliveryId: string): Promise<InboundWebhook>;
}

export type WebhookContractSetup = () => WebhookContractHarness | Promise<WebhookContractHarness>;

/**
 * `WebhookIntake` の契約試験（試験の設計 1、全体設計 3.5）。
 */
export function webhookContract(name: string, setup: WebhookContractSetup): void {
  describe(`WebhookIntake contract: ${name}`, () => {
    // 本文が主張する接続・対象・変更内容を、合図へ持ち込まない。
    const body = JSON.stringify({
      target: 'someone-elses-calendar',
      connection: 'connection-z',
      changes: [{ id: 'e1', title: 'Injected' }],
    });

    it('returns only a signal bound to the registered subscription', async () => {
      const harness = await setup();
      const result = await harness.intake().verify(await harness.signed(body, 'd-1'));
      if (!result.ok) throw new Error(`expected a signal, got ${result.reason}`);
      expect(result.signal.connection).toEqual(harness.connection);
      expect(result.signal.target).toBe(harness.target);
      expect(result.signal.subscription).toBe(harness.subscription);
      for (const key of Object.keys(result.signal)) {
        expect(['connection', 'subscription', 'target', 'deliveryId']).toContain(key);
      }
      expect(JSON.stringify(result.signal)).not.toContain('Injected');
    });

    it('rejects a notification signed with another secret', async () => {
      const harness = await setup();
      expect(await harness.intake().verify(await harness.forged(body, 'd-1'))).toEqual({
        ok: false,
        reason: 'bad-signature',
      });
    });

    it('rejects a body changed after signing', async () => {
      const harness = await setup();
      const signed = await harness.signed(body, 'd-1');
      const result = await harness.intake().verify({ ...signed, body: `${signed.body} ` });
      expect(result).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('rejects an unknown subscription', async () => {
      const harness = await setup();
      const result = await harness.intake().verify(await harness.unknownSubscription(body, 'd-1'));
      expect(result.ok).toBe(false);
    });

    it('accepts a redelivered notification once, across instances', async () => {
      const harness = await setup();
      const notification = await harness.signed(body, 'd-7');
      expect((await harness.intake().verify(notification)).ok).toBe(true);
      expect(await harness.intake().verify(notification)).toEqual({
        ok: false,
        reason: 'duplicate-delivery',
      });
    });

    it('does not let a forged copy use up the delivery ID', async () => {
      const harness = await setup();
      await harness.intake().verify(await harness.forged(body, 'd-9'));
      expect((await harness.intake().verify(await harness.signed(body, 'd-9'))).ok).toBe(true);
    });
  });
}
