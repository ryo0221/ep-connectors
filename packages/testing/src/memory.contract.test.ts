import {
  jobQueueContract,
  ledgerContract,
  syncStateContract,
  tokenStoreContract,
  webhookContract,
} from './contracts/index.js';
import { contractConnection } from './fixtures.js';
import { createLedgerBacking, MemoryLedger } from './memory-ledger.js';
import { createQueueBacking, MemoryJobQueue, runDueJobs } from './memory-job-queue.js';
import { ControllablePolicy } from './memory-policy.js';
import { createSyncBacking, MemorySyncStateStore } from './memory-sync-state.js';
import { createTokenBacking, MemoryTokenStore } from './memory-token-store.js';
import { createWebhookBacking, fakeWebhook, MemoryWebhookIntake } from './memory-webhook.js';

// メモリ実装も、Host の本番実装と同じ契約試験を通す。

tokenStoreContract('memory', (env) => {
  const connection = contractConnection();
  const foreignConnection = contractConnection({
    principal: 'principal-b',
    connection: 'connection-b',
  });
  const backing = createTokenBacking([
    {
      key: connection,
      accessToken: 'access-token-secret-a',
      refreshToken: 'refresh-token-secret-a',
      scopes: [...env.scopes],
      revoked: false,
    },
    {
      key: foreignConnection,
      accessToken: 'access-token-secret-b',
      refreshToken: 'refresh-token-secret-b',
      scopes: [...env.scopes],
      revoked: false,
    },
  ]);
  const policy = new ControllablePolicy([connection]);
  policy.decideResources((_key, resource) =>
    env.authorizedResources.some(
      (allowed) => allowed.kind === resource.kind && allowed.id === resource.id,
    ),
  );
  const syncBacking = createSyncBacking();
  const syncState = new MemorySyncStateStore(syncBacking);
  return {
    store: () =>
      new MemoryTokenStore({
        backing,
        catalogs: [env.catalog],
        transport: env.transport,
        policy,
        refresher: env.refresher,
        syncState: new MemorySyncStateStore(syncBacking),
      }),
    connection,
    foreignConnection,
    syncState,
    secrets: ['access-token-secret-a', 'refresh-token-secret-a'],
  };
});

ledgerContract('memory', () => {
  const backing = createLedgerBacking();
  return { ledger: () => new MemoryLedger(backing) };
});

jobQueueContract('memory', ({ policy }) => {
  const backing = createQueueBacking();
  return {
    queue: () => new MemoryJobQueue(backing),
    deliver: (handler, options) =>
      runDueJobs(backing, {
        now: options.now,
        policy,
        handler,
        ...(options.deliveries === undefined ? {} : { deliveries: options.deliveries }),
      }),
  };
});

webhookContract('memory', () => {
  const connection = contractConnection();
  const registered = {
    subscription: 'sub-1',
    connection,
    target: 'calendar-1',
    secret: 'hook-secret',
  };
  const backing = createWebhookBacking([registered]);
  return {
    intake: () => new MemoryWebhookIntake(backing),
    subscription: registered.subscription,
    connection,
    target: registered.target,
    signed: (body, deliveryId) => fakeWebhook(registered, body, deliveryId),
    forged: (body, deliveryId) =>
      fakeWebhook({ ...registered, secret: 'wrong-secret' }, body, deliveryId),
    unknownSubscription: (body, deliveryId) =>
      fakeWebhook({ subscription: 'sub-unknown', secret: 'hook-secret' }, body, deliveryId),
  };
});

syncStateContract('memory', () => {
  const backing = createSyncBacking();
  return {
    store: () => new MemorySyncStateStore(backing),
    restart: async () => MemorySyncStateStore.restart(backing),
  };
});
