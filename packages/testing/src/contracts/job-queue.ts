import { describe, expect, it } from 'vitest';
import type {
  HostPolicy,
  JobHandler,
  JobQueue,
  JobRef,
  OperationLedger,
  PolicyDenial,
  SyncStateStore,
} from '@ep-connectors/core';
import { FakeProvider, json } from '../fake-provider.js';
import { contractConnection, FAKE_API } from '../fixtures.js';
import { createLedgerBacking, MemoryLedger } from '../memory-ledger.js';
import { ControllablePolicy } from '../memory-policy.js';
import { createSyncBacking, MemorySyncStateStore } from '../memory-sync-state.js';

export interface JobQueueContractEnv {
  /** 実装は job を実行する直前に、この policy の `authorizeDispatch` を呼ぶ。 */
  policy: HostPolicy;
}

export interface JobQueueContractHarness {
  queue(): JobQueue;
  /**
   * 期限（`now`）の来た job を `handler` へ配送する。`deliveries` が 2 以上なら、同じ job を
   * その回数だけ並行に配送する（重複配送の再現）。
   */
  deliver(handler: JobHandler, options: { now: string; deliveries?: number }): Promise<void>;
  /** 組み合わせて確かめる台帳と同期の基点。省略したらメモリ実装を使う。 */
  ledger?(): OperationLedger;
  syncState?(): SyncStateStore;
}

export type JobQueueContractSetup = (
  env: JobQueueContractEnv,
) => JobQueueContractHarness | Promise<JobQueueContractHarness>;

const NOW = '2026-01-01T00:00:00.000Z';
const connection = contractConnection();
const scope = { connection, target: 'items', query: null };

const JOBS: Record<JobRef['kind'], JobRef> = {
  step: { kind: 'step', operation: 'op-1', step: 'calendar.create' },
  read: { kind: 'read', scope, expectedGeneration: null },
  subscription: { kind: 'subscription', connection, subscription: 'sub-1' },
};

/**
 * `JobQueue` の契約試験（試験の設計 1、全体設計 3.4）。
 */
export function jobQueueContract(name: string, setup: JobQueueContractSetup): void {
  describe(`JobQueue contract: ${name}`, () => {
    async function arrange() {
      const policy = new ControllablePolicy([connection]);
      const harness = await setup({ policy });
      const ledgerBacking = createLedgerBacking();
      const syncBacking = createSyncBacking();
      return {
        policy,
        harness,
        ledger: () => harness.ledger?.() ?? new MemoryLedger(ledgerBacking),
        syncState: () => harness.syncState?.() ?? new MemorySyncStateStore(syncBacking),
      };
    }

    it.each(Object.keys(JOBS) as JobRef['kind'][])(
      'authorizes a %s job right before running it',
      async (kind) => {
        const { policy, harness } = await arrange();
        const job = JOBS[kind];
        await harness.queue().enqueue(job);
        const handled: JobRef[] = [];
        await harness.deliver(
          async (delivered) => {
            // 実行の直前に確認が済んでいる。
            expect(policy.dispatchCalls).toHaveLength(handled.length + 1);
            handled.push(delivered);
            return { kind: 'done' };
          },
          { now: NOW },
        );
        expect(handled).toEqual([job]);
        expect(policy.dispatchCalls).toEqual([job]);
      },
    );

    const denials: PolicyDenial[] = ['revoked', 'tenant-changed', 'connection-generation-changed'];
    for (const kind of Object.keys(JOBS) as JobRef['kind'][]) {
      it.each(denials)(
        `does not run a ${kind} job when dispatch is denied (%s)`,
        async (reason) => {
          const { policy, harness } = await arrange();
          // Enqueue の時点では許可されていたが、実行の直前に拒否される。
          await harness.queue().enqueue(JOBS[kind]);
          policy.decideDispatch(() => ({ ok: false, reason }));
          let ran = 0;
          await harness.deliver(
            async () => {
              ran += 1;
              return { kind: 'done' };
            },
            { now: NOW },
          );
          expect(ran).toBe(0);
          expect(policy.dispatchCalls).toHaveLength(1);

          // 拒否された job は終わっており、許可が戻っても後から実行されない。
          policy.decideDispatch(() => ({ ok: true }));
          await harness.deliver(
            async () => {
              ran += 1;
              return { kind: 'done' };
            },
            { now: NOW },
          );
          expect(ran).toBe(0);
        },
      );
    }

    it('does not run a job before notBefore', async () => {
      const { harness } = await arrange();
      await harness.queue().enqueue(JOBS.read, { notBefore: '2026-01-01T00:05:00.000Z' });
      let ran = 0;
      const handler: JobHandler = async () => {
        ran += 1;
        return { kind: 'done' };
      };
      await harness.deliver(handler, { now: NOW });
      expect(ran).toBe(0);
      await harness.deliver(handler, { now: '2026-01-01T00:05:00.000Z' });
      expect(ran).toBe(1);
    });

    it('sends a step once when the same job is delivered twice', async () => {
      const { harness, ledger } = await arrange();
      await ledger().claim({
        slot: 'slot-1',
        operation: 'op-1',
        planDigest: 'digest-1',
        plan: { title: 'Planning' },
        steps: ['calendar.create'],
      });
      const provider = new FakeProvider().route('POST', `${FAKE_API}/v1/items`, () =>
        json(201, { id: 'created' }),
      );
      await harness.queue().enqueue(JOBS.step);
      await harness.deliver(
        async (job) => {
          if (job.kind !== 'step') return { kind: 'abandoned', reason: 'unexpected job' };
          const worker = ledger();
          const record = await worker.read(job.operation);
          const step = record?.steps[job.step];
          if (!step) return { kind: 'abandoned', reason: 'missing step' };
          const acquired = await worker.acquireStep(job.operation, job.step, step.generation);
          if (acquired.kind !== 'acquired') return { kind: 'done' };
          const appended = await worker.appendAttempt(
            job.operation,
            { step: job.step, attempt: 1, at: NOW },
            acquired.fence,
          );
          if (!appended.ok) return { kind: 'done' };
          await provider.transport({ method: 'POST', url: `${FAKE_API}/v1/items`, headers: {} });
          await worker.recordResult(
            job.operation,
            job.step,
            { state: 'accepted', at: NOW },
            acquired.fence,
          );
          return { kind: 'done' };
        },
        { now: NOW, deliveries: 2 },
      );
      expect(provider.received).toHaveLength(1);
    });

    it('publishes one generation when the same read job runs twice, and never an older one over a newer', async () => {
      const { harness, syncState } = await arrange();
      await harness.queue().enqueue(JOBS.read);
      let fetched = 0;
      await harness.deliver(
        async (job) => {
          if (job.kind !== 'read') return { kind: 'abandoned', reason: 'unexpected job' };
          const store = syncState();
          const staged = await store.stage(job.scope, job.expectedGeneration);
          if (!staged.ok) return { kind: 'done' };
          fetched += 1;
          const run = fetched;
          await store.applyPage(job.scope, staged.stagedGeneration, {
            upserts: [{ id: 'item-1', value: { run } }],
            removals: [],
          });
          await store.commit(job.scope, job.expectedGeneration, staged.stagedGeneration, `c${run}`);
          return { kind: 'done' };
        },
        { now: NOW, deliveries: 2 },
      );
      const published = await syncState().read(scope);
      expect(published).not.toBeNull();
      // 二つの実行のどちらか一つの世代だけが公開されている。
      expect(published?.entries).toHaveLength(1);
      const run = (published?.entries[0]?.value as { run: number }).run;
      expect(published?.cursor).toBe(`c${run}`);
      expect(fetched).toBe(2);
    });
  });
}
