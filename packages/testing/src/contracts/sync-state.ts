import { describe, expect, it } from 'vitest';
import type { ConnectionKey, SyncEntry, SyncScope, SyncStateStore } from '@ep-connectors/core';
import { contractConnection } from '../fixtures.js';

export interface SyncStateContractHarness {
  /** 呼ぶたびに新しい instance を返す。保管だけを共有する。 */
  store(): SyncStateStore;
  /**
   * Process の再起動を再現する。Host の保管が再起動で行うこと（公開の印が指していない staging を
   * 捨てるなど）をここで行う。何もしない実装でもよい。
   */
  restart(): Promise<void>;
}

export type SyncStateContractSetup = () =>
  | SyncStateContractHarness
  | Promise<SyncStateContractHarness>;

interface Change {
  seq: number;
  id: string;
  value: SyncEntry['value'] | null;
}

/** 基点（最後に読んだ seq）からの差分をページで返す、偽の Provider の変更履歴。 */
class DeltaSource {
  readonly changes: Change[] = [];
  add(id: string, value: SyncEntry['value'] | null): void {
    this.changes.push({ seq: this.changes.length + 1, id, value });
  }
  page(cursor: string | null, size: number): { changes: Change[]; next: string; done: boolean } {
    const after = cursor === null ? 0 : Number(cursor);
    const changes = this.changes.filter((change) => change.seq > after).slice(0, size);
    const last = changes.at(-1)?.seq ?? after;
    return { changes, next: String(last), done: !this.changes.some((change) => change.seq > last) };
  }
  /** すべての変更を適用した結果。 */
  expected(): SyncEntry[] {
    const map = new Map<string, SyncEntry>();
    for (const change of this.changes) {
      if (change.value === null) map.delete(change.id);
      else map.set(change.id, { id: change.id, value: change.value });
    }
    return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
}

function sorted(entries: SyncEntry[]): SyncEntry[] {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * `SyncStateStore` の契約試験（試験の設計 1、全体設計 3.6）。
 */
export function syncStateContract(name: string, setup: SyncStateContractSetup): void {
  describe(`SyncStateStore contract: ${name}`, () => {
    const connection = contractConnection();
    const scope: SyncScope = {
      connection,
      target: 'calendar-1',
      query: { fields: ['summary', 'start'] },
      window: { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' },
    };

    async function publish(
      store: SyncStateStore,
      target: SyncScope,
      entries: SyncEntry[],
      cursor: string,
    ): Promise<number> {
      const current = await store.read(target);
      const staged = await store.stage(target, current?.generation ?? null);
      if (!staged.ok) throw new Error('stage failed');
      await store.applyPage(target, staged.stagedGeneration, { upserts: entries, removals: [] });
      const committed = await store.commit(
        target,
        current?.generation ?? null,
        staged.stagedGeneration,
        cursor,
      );
      if (!committed.ok) throw new Error('commit failed');
      return committed.generation;
    }

    /** 公開済みの基点から差分を読み、全ページを適用してから公開する。`stopAfterPages` で途中で止める。 */
    async function syncOnce(
      store: SyncStateStore,
      source: DeltaSource,
      options: { stopAfterPages?: number; stopBeforeCommit?: boolean } = {},
    ): Promise<'committed' | 'stopped'> {
      const current = await store.read(scope);
      const staged = await store.stage(scope, current?.generation ?? null);
      if (!staged.ok) throw new Error('stage failed');
      let cursor = current?.cursor ?? null;
      let pages = 0;
      for (;;) {
        const page = source.page(cursor, 2);
        await store.applyPage(scope, staged.stagedGeneration, {
          upserts: page.changes
            .filter((change) => change.value !== null)
            .map((change) => ({ id: change.id, value: change.value as SyncEntry['value'] })),
          removals: page.changes
            .filter((change) => change.value === null)
            .map((change) => change.id),
        });
        cursor = page.next;
        pages += 1;
        if (options.stopAfterPages !== undefined && pages >= options.stopAfterPages)
          return 'stopped';
        if (page.done) break;
      }
      if (options.stopBeforeCommit) return 'stopped';
      const committed = await store.commit(
        scope,
        current?.generation ?? null,
        staged.stagedGeneration,
        cursor,
      );
      if (!committed.ok) throw new Error('commit failed');
      return 'committed';
    }

    it('has no basis before the first commit and publishes cache and cursor together', async () => {
      const harness = await setup();
      const store = harness.store();
      expect(await store.read(scope)).toBeNull();
      const staged = await store.stage(scope, null);
      if (!staged.ok) throw new Error('stage failed');
      await store.applyPage(scope, staged.stagedGeneration, {
        upserts: [{ id: 'e1', value: { summary: 'A' } }],
        removals: [],
      });
      // 全ページを適用するまで、読む側には何も見えない。
      expect(await harness.store().read(scope)).toBeNull();
      const committed = await store.commit(scope, null, staged.stagedGeneration, 'cursor-1');
      expect(committed).toEqual({ ok: true, generation: staged.stagedGeneration });
      expect(await harness.store().read(scope)).toEqual({
        generation: staged.stagedGeneration,
        cursor: 'cursor-1',
        entries: [{ id: 'e1', value: { summary: 'A' } }],
      });
    });

    it.each<[string, Partial<SyncScope>]>([
      ['another target', { target: 'calendar-2' }],
      ['another query', { query: { fields: ['summary'] } }],
      [
        'another window',
        { window: { start: '2026-02-01T00:00:00Z', end: '2026-03-01T00:00:00Z' } },
      ],
      ['another connection generation', { connection: { ...connection, generation: 2 } }],
      ['another connection', { connection: { ...connection, connection: 'connection-b' } }],
    ])('does not return the basis for %s', async (_label, overrides) => {
      const harness = await setup();
      await publish(harness.store(), scope, [{ id: 'e1', value: 1 }], 'cursor-1');
      expect(await harness.store().read({ ...scope, ...overrides })).toBeNull();
    });

    it('does not return a windowed basis for the same scope without a window', async () => {
      const harness = await setup();
      await publish(harness.store(), scope, [{ id: 'e1', value: 1 }], 'cursor-1');
      const unwindowed: SyncScope = {
        connection: scope.connection,
        target: scope.target,
        query: scope.query,
      };
      expect(await harness.store().read(unwindowed)).toBeNull();
    });

    it('rejects a commit whose expected generation is not the published one', async () => {
      const harness = await setup();
      const first = await publish(harness.store(), scope, [{ id: 'e1', value: 1 }], 'cursor-1');
      const staged = await harness.store().stage(scope, first);
      if (!staged.ok) throw new Error('stage failed');
      expect(
        await harness.store().commit(scope, null, staged.stagedGeneration, 'cursor-2'),
      ).toEqual({
        ok: false,
        reason: 'generation-mismatch',
        current: first,
      });
    });

    it('never lets an older staging overwrite a newer publication', async () => {
      const harness = await setup();
      const base = await publish(harness.store(), scope, [{ id: 'e1', value: 1 }], 'cursor-1');
      const slow = await harness.store().stage(scope, base);
      const fast = await harness.store().stage(scope, base);
      if (!slow.ok || !fast.ok) throw new Error('stage failed');
      await harness.store().applyPage(scope, fast.stagedGeneration, {
        upserts: [{ id: 'e1', value: 2 }],
        removals: [],
      });
      expect(
        (await harness.store().commit(scope, base, fast.stagedGeneration, 'cursor-3')).ok,
      ).toBe(true);
      await harness.store().applyPage(scope, slow.stagedGeneration, {
        upserts: [{ id: 'e1', value: 0 }],
        removals: [],
      });
      expect(
        (await harness.store().commit(scope, base, slow.stagedGeneration, 'cursor-2')).ok,
      ).toBe(false);
      expect(await harness.store().read(scope)).toMatchObject({
        cursor: 'cursor-3',
        entries: [{ id: 'e1', value: 2 }],
      });
      // 古い世代を基にした staging は始められない。
      expect(await harness.store().stage(scope, base)).toEqual({ ok: false, reason: 'stale-base' });
    });

    it('drops the cursor with the baseline on invalidate', async () => {
      const harness = await setup();
      const generation = await publish(
        harness.store(),
        scope,
        [{ id: 'e1', value: 1 }],
        'cursor-1',
      );
      expect(await harness.store().invalidate(scope)).toEqual({ ok: true });
      expect(await harness.store().read(scope)).toBeNull();
      expect(await harness.store().stage(scope, generation)).toEqual({
        ok: false,
        reason: 'stale-base',
      });
    });

    it('invalidates with an expected generation only while that generation is published', async () => {
      const harness = await setup();
      const first = await publish(harness.store(), scope, [{ id: 'e1', value: 1 }], 'cursor-1');
      // 一つの worker が世代 first を読んだあと、別の worker が新しい世代を公開する。
      const seen = await harness.store().read(scope);
      expect(seen?.generation).toBe(first);
      const second = await publish(harness.store(), scope, [{ id: 'e1', value: 2 }], 'cursor-2');
      expect(await harness.store().invalidate(scope, first)).toEqual({
        ok: false,
        reason: 'generation-mismatch',
        current: second,
      });
      expect(await harness.store().read(scope)).toMatchObject({
        generation: second,
        cursor: 'cursor-2',
        entries: [{ id: 'e1', value: 2 }],
      });

      expect(await harness.store().invalidate(scope, second)).toEqual({ ok: true });
      expect(await harness.store().read(scope)).toBeNull();
      // 公開済みの世代がなければ、期待した世代での無効化は一致しない。
      expect(await harness.store().invalidate(scope, second)).toEqual({
        ok: false,
        reason: 'generation-mismatch',
        current: null,
      });
    });

    it('invalidates every scope of a connection, whatever its generation, and nothing else', async () => {
      const harness = await setup();
      const newer = { ...scope, connection: { ...connection, generation: 2 } };
      const otherTarget = { ...scope, target: 'calendar-2' };
      const otherConnection: SyncScope = {
        ...scope,
        connection: { ...connection, connection: 'connection-b' } as ConnectionKey,
      };
      for (const target of [scope, newer, otherTarget, otherConnection]) {
        await publish(harness.store(), target, [{ id: 'e1', value: 1 }], 'cursor-1');
      }
      await harness.store().invalidateConnection(connection);
      expect(await harness.store().read(scope)).toBeNull();
      expect(await harness.store().read(newer)).toBeNull();
      expect(await harness.store().read(otherTarget)).toBeNull();
      expect(await harness.store().read(otherConnection)).not.toBeNull();
    });

    it.each([
      ['while applying pages', { stopAfterPages: 1 }],
      ['just before the commit', { stopBeforeCommit: true }],
    ] as const)(
      'resumes from the published pair after a restart %s, without losing changes',
      async (_label, stop) => {
        const harness = await setup();
        const source = new DeltaSource();
        source.add('e1', { summary: 'A' });
        source.add('e2', { summary: 'B' });
        expect(await syncOnce(harness.store(), source)).toBe('committed');
        const before = await harness.store().read(scope);

        source.add('e1', { summary: 'A2' });
        source.add('e3', { summary: 'C' });
        source.add('e2', null);
        source.add('e4', { summary: 'D' });
        expect(await syncOnce(harness.store(), source, stop)).toBe('stopped');
        await harness.restart();

        // 読む側は、cache と基点が同じ公開済みの世代のものだけを見る。
        expect(await harness.store().read(scope)).toEqual(before);
        expect(await syncOnce(harness.store(), source)).toBe('committed');
        const after = await harness.store().read(scope);
        expect(sorted(after?.entries ?? [])).toEqual(source.expected());
        expect(after?.cursor).toBe(String(source.changes.length));
      },
    );

    it('resumes from the new pair after a restart just after the commit', async () => {
      const harness = await setup();
      const source = new DeltaSource();
      source.add('e1', { summary: 'A' });
      expect(await syncOnce(harness.store(), source)).toBe('committed');
      await harness.restart();
      const published = await harness.store().read(scope);
      expect(published?.cursor).toBe('1');
      source.add('e2', { summary: 'B' });
      expect(await syncOnce(harness.store(), source)).toBe('committed');
      expect(sorted((await harness.store().read(scope))?.entries ?? [])).toEqual(source.expected());
    });
  });
}
