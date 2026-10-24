import type { ConnectionKey, HostPolicy, PolicyDenial, SyncStateStore } from '@ep-connectors/core';
import { canonicalJson } from '@ep-connectors/core';
import { REPOSITORY_RESOURCE } from './catalog.js';
import type { GithubWorkItem, WorkItemsProvenance } from './dto.js';
import { decodeCursor, workItemsScope } from './dto.js';

export type WorkItemsRead =
  | { ok: true; items: GithubWorkItem[]; provenance: WorkItemsProvenance }
  | { ok: false; reason: PolicyDenial | 'not-synced' };

/**
 * 公開済みの写しを、本人向けの DTO として返す。Cache は installation の中で共有してよいが、表示の
 * たびに principal・project の repository の閲覧の認可を確かめる（設計 2.1）。対応表から外した
 * repository の写しは、cache に残っていても返さない。
 */
export async function readWorkItems(
  deps: { policy: HostPolicy; sync: SyncStateStore },
  connection: ConnectionKey,
  repositoryId: string,
): Promise<WorkItemsRead> {
  const decision = await deps.policy.authorizeResources(connection, [
    { kind: REPOSITORY_RESOURCE, id: repositoryId },
  ]);
  if (!decision.ok) return { ok: false, reason: decision.reason };
  const published = await deps.sync.read(workItemsScope(connection, repositoryId));
  const cursor = decodeCursor(published?.cursor ?? null);
  if (!published || !cursor) return { ok: false, reason: 'not-synced' };

  const items = published.entries
    .map((entry) => entry.value as GithubWorkItem)
    .sort((a, b) =>
      a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : a.updatedAt < b.updatedAt ? 1 : -1,
    );
  return {
    ok: true,
    items,
    provenance: {
      repository: cursor.repository,
      generation: published.generation,
      fetchedAt: cursor.fetchedAt,
      fullReconciledAt: cursor.fullReconciledAt,
      etag: cursor.etag,
      contentHash: await sha256(canonicalJson(items)),
    },
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
