import type {
  CommitResult,
  ConnectionKey,
  PageResult,
  PublishedSync,
  StageResult,
  SyncEntry,
  SyncPage,
  SyncScope,
  SyncStateStore,
} from '@ep-connectors/core';
import { canonicalJson, connectionIdentity } from '@ep-connectors/core';

interface ScopeState {
  connection: string;
  /** 公開の印。cache の世代と基点の組を一つの記録として持つ。 */
  published: { generation: number; cursor: string | null; entries: Map<string, SyncEntry> } | null;
  staging: Map<number, Map<string, SyncEntry>>;
}

export interface MemorySyncBacking {
  scopes: Map<string, ScopeState>;
  /** 世代の番号は scope を無効にしても再利用しない。 */
  nextGeneration: number;
}

export function createSyncBacking(): MemorySyncBacking {
  return { scopes: new Map(), nextGeneration: 1 };
}

export function syncScopeKey(scope: SyncScope): string {
  return canonicalJson({
    connection: { ...scope.connection },
    target: scope.target,
    query: scope.query,
    window: scope.window ? { ...scope.window } : null,
  });
}

/** 試験専用の `SyncStateStore`。各操作は await を挟まずに読んで書くため atomic になる。 */
export class MemorySyncStateStore implements SyncStateStore {
  constructor(private readonly backing: MemorySyncBacking) {}

  async read(scope: SyncScope): Promise<PublishedSync | null> {
    const published = this.backing.scopes.get(syncScopeKey(scope))?.published;
    if (!published) return null;
    return {
      generation: published.generation,
      cursor: published.cursor,
      entries: structuredClone(
        [...published.entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      ),
    };
  }

  async stage(scope: SyncScope, basedOn: number | null): Promise<StageResult> {
    const state = this.state(scope);
    if (basedOn !== null && state.published?.generation !== basedOn) {
      return { ok: false, reason: 'stale-base' };
    }
    const stagedGeneration = this.backing.nextGeneration;
    this.backing.nextGeneration += 1;
    state.staging.set(
      stagedGeneration,
      basedOn === null ? new Map() : structuredClone(state.published?.entries ?? new Map()),
    );
    return { ok: true, stagedGeneration };
  }

  async applyPage(scope: SyncScope, stagedGeneration: number, page: SyncPage): Promise<PageResult> {
    const staging = this.backing.scopes.get(syncScopeKey(scope))?.staging.get(stagedGeneration);
    if (!staging) return { ok: false, reason: 'unknown-staging' };
    for (const id of page.removals) staging.delete(id);
    for (const entry of page.upserts) staging.set(entry.id, structuredClone(entry));
    return { ok: true };
  }

  async commit(
    scope: SyncScope,
    expectedGeneration: number | null,
    stagedGeneration: number,
    cursor: string | null,
  ): Promise<CommitResult> {
    const state = this.backing.scopes.get(syncScopeKey(scope));
    const current = state?.published?.generation ?? null;
    if (current !== expectedGeneration) {
      return { ok: false, reason: 'generation-mismatch', current };
    }
    const staging = state?.staging.get(stagedGeneration);
    if (!state || !staging) return { ok: false, reason: 'unknown-staging', current };
    state.published = { generation: stagedGeneration, cursor, entries: staging };
    state.staging.delete(stagedGeneration);
    return { ok: true, generation: stagedGeneration };
  }

  async invalidate(scope: SyncScope): Promise<void> {
    this.backing.scopes.delete(syncScopeKey(scope));
  }

  async invalidateConnection(connection: ConnectionKey): Promise<void> {
    const identity = connectionIdentity(connection);
    for (const [key, state] of this.backing.scopes) {
      if (state.connection === identity) this.backing.scopes.delete(key);
    }
  }

  /** 再起動を再現する。公開の印が指していない staging を捨てる。 */
  static restart(backing: MemorySyncBacking): void {
    for (const state of backing.scopes.values()) state.staging.clear();
  }

  private state(scope: SyncScope): ScopeState {
    const key = syncScopeKey(scope);
    let state = this.backing.scopes.get(key);
    if (!state) {
      state = {
        connection: connectionIdentity(scope.connection),
        published: null,
        staging: new Map(),
      };
      this.backing.scopes.set(key, state);
    }
    return state;
  }
}
