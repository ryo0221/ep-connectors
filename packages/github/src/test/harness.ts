import type { ConnectionKey, PolicyDecision } from '@ep-connectors/core';
import {
  ControllablePolicy,
  createQueueBacking,
  createSyncBacking,
  createTokenBacking,
  FixedClock,
  MemoryJobQueue,
  MemorySyncStateStore,
  MemoryTokenStore,
} from '@ep-connectors/testing';
import {
  createGithubCatalog,
  ISSUES_READ,
  PULL_REQUESTS_READ,
  REPOSITORY_NAME_RESOURCE,
  REPOSITORY_RESOURCE,
} from '../catalog.js';
import { workItemsRepository } from '../dto.js';
import type { GithubReadOptions } from '../sync.js';
import { FakeGithub } from './fake-github.js';

export const ACCESS_TOKEN = 'ghs_installation-token-secret';

/** 一つの installation の接続。導入範囲には repo-a と repo-b が入っている。 */
export function installationConnection(overrides: Partial<ConnectionKey> = {}): ConnectionKey {
  return {
    principal: 'principal-a',
    provider: 'github',
    tenant: 'installation-1',
    account: 'acme',
    connection: 'connection-a',
    generation: 1,
    ...overrides,
  };
}

/**
 * Host の役を試験用に組む。`authorized` は Host のプロジェクトとリポジトリの対応表（node ID と
 * `owner/name`）で、installation の token が届くことと別に、principal が読める repository を決める。
 */
export async function githubHarness(options: GithubReadOptions = {}) {
  const github = new FakeGithub();
  const connection = installationConnection();
  const authorized = new Map<string, string>();
  const policy = new ControllablePolicy([connection]);
  policy.decideResources((_key, resource) => {
    if (resource.kind === REPOSITORY_RESOURCE) return authorized.has(resource.id);
    if (resource.kind === REPOSITORY_NAME_RESOURCE) {
      return [...authorized.values()].includes(resource.id);
    }
    return false;
  });
  policy.decideDispatch((job): PolicyDecision => {
    if (job.kind !== 'read') return { ok: false, reason: 'forbidden' };
    const repository = workItemsRepository(job.scope);
    return repository && authorized.has(repository)
      ? { ok: true }
      : { ok: false, reason: 'forbidden' };
  });
  const tokenBacking = createTokenBacking([
    {
      key: connection,
      accessToken: ACCESS_TOKEN,
      refreshToken: 'unused',
      scopes: [ISSUES_READ, PULL_REQUESTS_READ],
      revoked: false,
    },
  ]);
  const syncBacking = createSyncBacking();
  const queueBacking = createQueueBacking();
  const clock = new FixedClock('2026-10-23T00:00:00.000Z');
  const catalog = await createGithubCatalog();
  const refresh = { outcome: 'ok' as 'ok' | 'revoked', calls: 0 };

  // 呼ぶたびに新しい instance を作り、保管だけを共有する。
  const tokens = () =>
    new MemoryTokenStore({
      backing: tokenBacking,
      catalogs: [catalog],
      transport: github.provider.transport,
      policy,
      refresher: async () => {
        refresh.calls += 1;
        return refresh.outcome === 'ok'
          ? { accessToken: `${ACCESS_TOKEN}-${refresh.calls}` }
          : 'revoked';
      },
      syncState: new MemorySyncStateStore(syncBacking),
    });
  const sync = () => new MemorySyncStateStore(syncBacking);
  const deps = () => ({ tokens: tokens(), sync: sync(), clock, options });

  return {
    github,
    connection,
    authorized,
    policy,
    clock,
    catalog,
    tokens,
    sync,
    deps,
    syncBacking,
    queueBacking,
    queue: () => new MemoryJobQueue(queueBacking),
    refresh,
    authorize(id: string, nameWithOwner: string) {
      authorized.set(id, nameWithOwner);
    },
  };
}

export const T = (minute: number) =>
  new Date(Date.parse('2026-10-22T00:00:00.000Z') + minute * 60_000).toISOString();
