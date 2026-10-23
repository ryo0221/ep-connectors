import { describe, expect, it } from 'vitest';
import type { ClaimInput, OperationLedger } from '@ep-connectors/core';
import { FakeProvider, json } from '../fake-provider.js';
import { FAKE_API } from '../fixtures.js';

export interface LedgerContractHarness {
  /** 呼ぶたびに新しい instance（別の worker・再起動後の process に当たる）を返す。保管だけを共有する。 */
  ledger(): OperationLedger;
}

export type LedgerContractSetup = () => LedgerContractHarness | Promise<LedgerContractHarness>;

const AT = '2026-01-01T00:00:00.000Z';

function claimInput(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    slot: 'artifact-1/event-1@calendar-a',
    operation: 'op-1',
    planDigest: 'digest-1',
    plan: { create: { title: 'Planning' } },
    steps: ['calendar.create'],
    ...overrides,
  };
}

/**
 * `OperationLedger` の契約試験（試験の設計 1、全体設計 3.3）。
 */
export function ledgerContract(name: string, setup: LedgerContractSetup): void {
  describe(`OperationLedger contract: ${name}`, () => {
    it('grants a slot to exactly one of several concurrent claims', async () => {
      const harness = await setup();
      const results = await Promise.all(
        ['op-a', 'op-b', 'op-c'].map((operation) =>
          harness.ledger().claim(claimInput({ operation })),
        ),
      );
      const claimed = results.filter((result) => result.kind === 'claimed');
      expect(claimed).toHaveLength(1);
      const holder = ['op-a', 'op-b', 'op-c'][results.findIndex((r) => r.kind === 'claimed')];
      for (const result of results) {
        if (result.kind !== 'claimed')
          expect(result).toEqual({ kind: 'existing', operation: holder });
      }
    });

    it('reports a conflict for the same operation with a different plan digest', async () => {
      const harness = await setup();
      expect(await harness.ledger().claim(claimInput())).toEqual({ kind: 'claimed' });
      expect(await harness.ledger().claim(claimInput({ planDigest: 'digest-2' }))).toEqual({
        kind: 'conflict',
      });
      expect(await harness.ledger().claim(claimInput())).toEqual({
        kind: 'existing',
        operation: 'op-1',
      });
    });

    it('keeps the frozen plan readable by another instance', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const record = await harness.ledger().read('op-1');
      expect(record?.plan).toEqual({ create: { title: 'Planning' } });
      expect(record?.steps['calendar.create']).toMatchObject({ state: 'prepared', generation: 0 });
    });

    it('sends a step once when two workers receive it at the same time', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const provider = new FakeProvider().route('POST', `${FAKE_API}/v1/items`, () =>
        json(201, { id: 'event-x' }),
      );

      async function worker(): Promise<void> {
        const ledger = harness.ledger();
        const acquired = await ledger.acquireStep('op-1', 'calendar.create', 0);
        if (acquired.kind !== 'acquired') return;
        const appended = await ledger.appendAttempt(
          'op-1',
          { step: 'calendar.create', attempt: 1, idempotencyKey: 'op-1-1', at: AT },
          acquired.fence,
        );
        if (!appended.ok) return;
        await provider.transport({ method: 'POST', url: `${FAKE_API}/v1/items`, headers: {} });
        await ledger.recordResult(
          'op-1',
          'calendar.create',
          { state: 'accepted', externalRef: 'ref-1', at: AT },
          acquired.fence,
        );
      }

      await Promise.all([worker(), worker(), worker()]);
      expect(provider.received).toHaveLength(1);
      const record = await harness.ledger().read('op-1');
      expect(record?.steps['calendar.create']?.attempts).toHaveLength(1);
    });

    it('does not give the send right to a second acquire, whatever the claim said', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const first = await harness.ledger().acquireStep('op-1', 'calendar.create', 0);
      expect(first.kind).toBe('acquired');
      expect(await harness.ledger().claim(claimInput())).toEqual({
        kind: 'existing',
        operation: 'op-1',
      });
      const second = await harness.ledger().acquireStep('op-1', 'calendar.create', 0);
      expect(second).toMatchObject({ kind: 'not-acquired', state: 'dispatching' });
    });

    it('keeps a dispatching step unresolved across a restart and never returns it as unsent', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const acquired = await harness.ledger().acquireStep('op-1', 'calendar.create', 0);
      if (acquired.kind !== 'acquired') throw new Error('expected the send right');
      await harness
        .ledger()
        .appendAttempt('op-1', { step: 'calendar.create', attempt: 1, at: AT }, acquired.fence);

      // 応答を記録する前に止まった。再起動後の新しい instance から見る。
      const restarted = harness.ledger();
      expect(await restarted.listUnresolved()).toEqual([
        {
          operation: 'op-1',
          step: 'calendar.create',
          state: 'dispatching',
          generation: acquired.generation,
        },
      ]);
      expect(
        (await restarted.acquireStep('op-1', 'calendar.create', acquired.generation)).kind,
      ).toBe('not-acquired');
    });

    it('fences off the original worker once reconciliation starts', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const original = await harness.ledger().acquireStep('op-1', 'calendar.create', 0);
      if (original.kind !== 'acquired') throw new Error('expected the send right');
      await harness
        .ledger()
        .appendAttempt('op-1', { step: 'calendar.create', attempt: 1, at: AT }, original.fence);

      const reconcile = await harness
        .ledger()
        .acquireReconcile('op-1', 'calendar.create', original.generation);
      if (reconcile.kind !== 'acquired') throw new Error('expected the reconcile right');
      expect(reconcile.generation).toBeGreaterThan(original.generation);

      // 遅れて戻った元の worker の記録は拒否される。
      expect(
        await harness
          .ledger()
          .recordResult('op-1', 'calendar.create', { state: 'accepted', at: AT }, original.fence),
      ).toEqual({ ok: false, reason: 'stale-fence' });
      expect(
        await harness
          .ledger()
          .appendAttempt('op-1', { step: 'calendar.create', attempt: 2, at: AT }, original.fence),
      ).toEqual({ ok: false, reason: 'stale-fence' });

      // 照合権を持つ worker は記録できる。
      expect(
        await harness
          .ledger()
          .recordResult(
            'op-1',
            'calendar.create',
            { state: 'verified', externalRef: 'ref-1', at: AT },
            reconcile.fence,
          ),
      ).toEqual({ ok: true });
      expect(await harness.ledger().listUnresolved()).toEqual([]);
    });

    it('lets only one of two concurrent reconcilers proceed', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const original = await harness.ledger().acquireStep('op-1', 'calendar.create', 0);
      if (original.kind !== 'acquired') throw new Error('expected the send right');
      const results = await Promise.all([
        harness.ledger().acquireReconcile('op-1', 'calendar.create', original.generation),
        harness.ledger().acquireReconcile('op-1', 'calendar.create', original.generation),
      ]);
      expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(1);
    });

    it('refuses to release without evidence, or with the send right instead of the reconcile right', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const original = await harness.ledger().acquireStep('op-1', 'calendar.create', 0);
      if (original.kind !== 'acquired') throw new Error('expected the send right');

      expect(
        await harness
          .ledger()
          .release(
            'op-1',
            'calendar.create',
            { kind: 'attempt-not-recorded', detail: 'no attempt' },
            original.fence,
          ),
      ).toEqual({ ok: false, reason: 'not-reconciling' });

      const reconcile = await harness
        .ledger()
        .acquireReconcile('op-1', 'calendar.create', original.generation);
      if (reconcile.kind !== 'acquired') throw new Error('expected the reconcile right');
      expect(
        await harness
          .ledger()
          .release(
            'op-1',
            'calendar.create',
            null as unknown as Parameters<OperationLedger['release']>[2],
            reconcile.fence,
          ),
      ).toEqual({ ok: false, reason: 'missing-evidence' });
      expect((await harness.ledger().read('op-1'))?.steps['calendar.create']?.state).toBe(
        'dispatching',
      );
    });

    it('does not accept "no attempt recorded" as evidence once an attempt was recorded', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const original = await harness.ledger().acquireStep('op-1', 'calendar.create', 0);
      if (original.kind !== 'acquired') throw new Error('expected the send right');
      await harness
        .ledger()
        .appendAttempt('op-1', { step: 'calendar.create', attempt: 1, at: AT }, original.fence);
      const reconcile = await harness
        .ledger()
        .acquireReconcile('op-1', 'calendar.create', original.generation);
      if (reconcile.kind !== 'acquired') throw new Error('expected the reconcile right');
      expect(
        await harness
          .ledger()
          .release(
            'op-1',
            'calendar.create',
            { kind: 'attempt-not-recorded', detail: 'claimed by a worker' },
            reconcile.fence,
          ),
      ).toEqual({ ok: false, reason: 'missing-evidence' });
    });

    it('returns a step to prepared only with evidence, under a new generation', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const original = await harness.ledger().acquireStep('op-1', 'calendar.create', 0);
      if (original.kind !== 'acquired') throw new Error('expected the send right');
      // 試行を追記する前に止まった。
      const reconcile = await harness
        .ledger()
        .acquireReconcile('op-1', 'calendar.create', original.generation);
      if (reconcile.kind !== 'acquired') throw new Error('expected the reconcile right');
      expect(
        await harness
          .ledger()
          .release(
            'op-1',
            'calendar.create',
            { kind: 'attempt-not-recorded', detail: { checkedAt: AT } },
            reconcile.fence,
          ),
      ).toEqual({ ok: true });

      const record = await harness.ledger().read('op-1');
      const step = record?.steps['calendar.create'];
      expect(step?.state).toBe('prepared');
      expect(step?.generation).toBeGreaterThan(reconcile.generation);
      expect((await harness.ledger().acquireStep('op-1', 'calendar.create', 0)).kind).toBe(
        'not-acquired',
      );
      expect(
        (await harness.ledger().acquireStep('op-1', 'calendar.create', step?.generation ?? -1))
          .kind,
      ).toBe('acquired');
    });

    it('keeps an unknown step unresolved and requires reconciliation before anything else', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const original = await harness.ledger().acquireStep('op-1', 'calendar.create', 0);
      if (original.kind !== 'acquired') throw new Error('expected the send right');
      await harness
        .ledger()
        .recordResult('op-1', 'calendar.create', { state: 'unknown', at: AT }, original.fence);

      const unresolved = await harness.ledger().listUnresolved();
      expect(unresolved).toMatchObject([{ operation: 'op-1', state: 'unknown' }]);
      expect(
        (await harness.ledger().acquireStep('op-1', 'calendar.create', original.generation)).kind,
      ).toBe('not-acquired');
      // `unknown` を記録した送信権は使えない。
      expect(
        await harness
          .ledger()
          .recordResult('op-1', 'calendar.create', { state: 'verified', at: AT }, original.fence),
      ).toEqual({ ok: false, reason: 'stale-fence' });
    });

    it('does not reopen a settled step for reconciliation', async () => {
      const harness = await setup();
      await harness.ledger().claim(claimInput());
      const original = await harness.ledger().acquireStep('op-1', 'calendar.create', 0);
      if (original.kind !== 'acquired') throw new Error('expected the send right');
      await harness
        .ledger()
        .recordResult('op-1', 'calendar.create', { state: 'verified', at: AT }, original.fence);
      expect(
        await harness.ledger().acquireReconcile('op-1', 'calendar.create', original.generation),
      ).toMatchObject({ kind: 'not-acquired', state: 'verified' });
    });
  });
}
