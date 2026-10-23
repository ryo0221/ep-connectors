import { describe, expect, it } from 'vitest';
import type { JobRef } from '@ep-connectors/core';
import {
  createQueueBacking,
  createSyncBacking,
  json,
  MemoryJobQueue,
  MemorySyncStateStore,
  runDueJobs,
} from '@ep-connectors/testing';
import { ogcFeaturesCapabilities } from './capabilities.js';
import { pointFeature } from './fake-ogc-server.js';
import type { FeatureQuery } from './read.js';
import { createFeaturesReadHandler, featuresScope, queryFromScope, syncFeatures } from './sync.js';
import {
  connection,
  PUBLIC_SOURCE,
  publicSetup,
  TOKEN_SOURCE,
  tokenSetup,
  TOKYO,
} from './support.js';

const QUERY: FeatureQuery = { collectionId: 'stations', bbox: TOKYO, limit: 10 };

function publicScope() {
  return featuresScope(connection({ provider: PUBLIC_SOURCE.provider }), PUBLIC_SOURCE, QUERY);
}

describe('syncFeatures', () => {
  it('publishes all pages as one generation with no delta cursor', async () => {
    const setup = publicSetup();
    const store = new MemorySyncStateStore(createSyncBacking());
    const scope = publicScope();
    const result = await syncFeatures(setup.reader, store, scope, QUERY, null);
    expect(result).toEqual({
      ok: true,
      generation: expect.any(Number),
      stored: 25,
      rejected: [],
      numberMatched: 25,
    });
    const published = await store.read(scope);
    expect(published?.cursor).toBeNull();
    expect(published?.entries).toHaveLength(25);
    expect(published?.entries[0]).toEqual({
      id: 'station-01',
      value: {
        geometry: { type: 'Point', coordinates: [139.71, 35.65] },
        properties: { name: 'Station 1' },
      },
    });
  });

  it('keeps the previous generation when a page has an unreadable next link', async () => {
    const backing = createSyncBacking();
    const scope = publicScope();
    const first = await syncFeatures(
      publicSetup().reader,
      new MemorySyncStateStore(backing),
      scope,
      QUERY,
      null,
    );
    if (!first.ok) throw new Error('first sync failed');
    const broken = publicSetup({ rewriteNext: () => 'https://[' });
    const second = await syncFeatures(
      broken.reader,
      new MemorySyncStateStore(backing),
      scope,
      QUERY,
      first.generation,
    );
    expect(second).toEqual({
      ok: false,
      reason: 'failed',
      error: { kind: 'read', error: { kind: 'next-link', reason: 'url' } },
    });
    const published = await new MemorySyncStateStore(backing).read(scope);
    expect(published?.generation).toBe(first.generation);
    expect(published?.entries).toHaveLength(25);
  });

  it('publishes nothing when a later page fails, and keeps the previous generation', async () => {
    const backing = createSyncBacking();
    const scope = publicScope();
    const first = await syncFeatures(
      publicSetup().reader,
      new MemorySyncStateStore(backing),
      scope,
      QUERY,
      null,
    );
    if (!first.ok) throw new Error('first sync failed');

    const failing = publicSetup({
      intercept: (_request, context) => (context.offset === 10 ? json(503, {}) : null),
    });
    const second = await syncFeatures(
      failing.reader,
      new MemorySyncStateStore(backing),
      scope,
      QUERY,
      first.generation,
    );
    expect(second).toEqual({
      ok: false,
      reason: 'failed',
      error: { kind: 'read', error: { kind: 'unavailable', status: 503, retryAfter: null } },
    });
    const published = await new MemorySyncStateStore(backing).read(scope);
    expect(published?.generation).toBe(first.generation);
    expect(published?.entries).toHaveLength(25);
  });

  it('replaces the copy with the current snapshot so removed features disappear', async () => {
    const backing = createSyncBacking();
    const scope = publicScope();
    const first = await syncFeatures(
      publicSetup().reader,
      new MemorySyncStateStore(backing),
      scope,
      QUERY,
      null,
    );
    if (!first.ok) throw new Error('first sync failed');
    const smaller = publicSetup({
      collections: [{ id: 'stations', features: [pointFeature('station-01', [139.71, 35.65])] }],
    });
    await syncFeatures(
      smaller.reader,
      new MemorySyncStateStore(backing),
      scope,
      QUERY,
      first.generation,
    );
    const published = await new MemorySyncStateStore(backing).read(scope);
    expect(published?.entries.map((entry) => entry.id)).toEqual(['station-01']);
  });

  it('does not overwrite a newer generation with an older read', async () => {
    const backing = createSyncBacking();
    const scope = publicScope();
    const store = new MemorySyncStateStore(backing);
    const first = await syncFeatures(publicSetup().reader, store, scope, QUERY, null);
    const second = await syncFeatures(
      publicSetup().reader,
      store,
      scope,
      QUERY,
      first.ok ? first.generation : null,
    );
    if (!second.ok) throw new Error('second sync failed');
    // 最初の世代を期待した、遅れて走る取得。
    const late = await syncFeatures(
      publicSetup().reader,
      store,
      scope,
      QUERY,
      first.ok ? first.generation : null,
    );
    expect(late).toEqual({ ok: false, reason: 'superseded', current: second.generation });
    expect((await store.read(scope))?.generation).toBe(second.generation);
  });

  it('keeps features without an id out of the copy and reports where they were', async () => {
    const setup = publicSetup({
      collections: [
        {
          id: 'stations',
          features: [
            { at: [139.75, 35.65], feature: { type: 'Bad' } },
            pointFeature(null, [139.75, 35.65]),
            pointFeature('a', [139.75, 35.65]),
          ],
        },
      ],
    });
    const store = new MemorySyncStateStore(createSyncBacking());
    const result = await syncFeatures(setup.reader, store, publicScope(), QUERY, null);
    expect(result.ok && result.rejected).toEqual([
      { index: 0, id: null, reason: 'invalid-feature', page: 0 },
      { index: 1, id: null, reason: 'missing-id', page: 0 },
    ]);
    expect((await store.read(publicScope()))?.entries.map((entry) => entry.id)).toEqual(['a']);
  });

  it('stops on a paging loop and on too many pages without publishing', async () => {
    const scope = publicScope();
    const looping = publicSetup({
      // 二ページ目から先、いつも同じ next を返す。
      rewriteNext: (href) => {
        const url = new URL(href);
        url.searchParams.set('offset', '10');
        return url.toString();
      },
    });
    const store = new MemorySyncStateStore(createSyncBacking());
    expect(await syncFeatures(looping.reader, store, scope, QUERY, null)).toEqual({
      ok: false,
      reason: 'failed',
      error: { kind: 'paging-loop' },
    });
    expect(
      await syncFeatures(publicSetup().reader, store, scope, QUERY, null, { maxPages: 2 }),
    ).toEqual({ ok: false, reason: 'failed', error: { kind: 'too-many-pages', maxPages: 2 } });
    expect(await store.read(scope)).toBeNull();
  });

  it('is discarded with the connection when the token store revokes it', async () => {
    const backing = createSyncBacking();
    const setup = tokenSetup({}, { syncState: new MemorySyncStateStore(backing) });
    const scope = featuresScope(setup.key, TOKEN_SOURCE, QUERY);
    const store = new MemorySyncStateStore(backing);
    expect((await syncFeatures(setup.reader, store, scope, QUERY, null)).ok).toBe(true);
    await setup.store.revoke(setup.key);
    expect(await store.read(scope)).toBeNull();
    const after = await syncFeatures(setup.reader, store, scope, QUERY, null);
    expect(after).toEqual({
      ok: false,
      reason: 'failed',
      error: { kind: 'read', error: { kind: 'send', error: { kind: 'revoked' } } },
    });
  });
});

describe('featuresScope', () => {
  it('binds the copy to the connection, collection, bbox, limit and CRS', () => {
    const scope = publicScope();
    expect(queryFromScope(PUBLIC_SOURCE, scope)).toEqual(QUERY);
    expect(queryFromScope(TOKEN_SOURCE, scope)).toBeNull();
    expect(queryFromScope(PUBLIC_SOURCE, { ...scope, query: { kind: 'other' } })).toBeNull();
    const other = featuresScope(scope.connection, PUBLIC_SOURCE, {
      ...QUERY,
      bbox: [135, 34, 136, 35],
    });
    expect(other.query).not.toEqual(scope.query);
  });
});

describe('read jobs', () => {
  function queueSetup(options: Parameters<typeof publicSetup>[0] = {}) {
    const setup = publicSetup(options);
    const syncBacking = createSyncBacking();
    const queueBacking = createQueueBacking();
    const policy = tokenSetup().policy;
    const handler = createFeaturesReadHandler({
      source: PUBLIC_SOURCE,
      store: new MemorySyncStateStore(syncBacking),
      clock: setup.clock,
      sender: () => setup.reader.send,
    });
    return { ...setup, syncBacking, queueBacking, policy, handler };
  }

  it('publishes one generation when the same read job is delivered twice', async () => {
    const env = queueSetup();
    const scope = publicScope();
    await new MemoryJobQueue(env.queueBacking).enqueue({
      kind: 'read',
      scope,
      expectedGeneration: null,
    });
    await runDueJobs(env.queueBacking, {
      now: env.clock.now(),
      policy: env.policy,
      handler: env.handler,
      deliveries: 2,
    });
    expect(env.queueBacking.jobs[0]?.status).toBe('done');
    const store = new MemorySyncStateStore(env.syncBacking);
    const published = await store.read(scope);
    expect(published?.entries).toHaveLength(25);
    // 二つの配送の一方だけが公開され、他方は superseded で終わる。staging は公開されない。
    expect(env.policy.dispatchCalls).toHaveLength(2);
  });

  it('retries after the rate limit and then publishes', async () => {
    let limited = true;
    const env = queueSetup({
      intercept: (_request, context) => {
        if (limited && context.offset === 10) {
          limited = false;
          return json(429, {}, { 'retry-after': '30' });
        }
        return null;
      },
    });
    const scope = publicScope();
    await new MemoryJobQueue(env.queueBacking).enqueue({
      kind: 'read',
      scope,
      expectedGeneration: null,
    });
    const run = () =>
      runDueJobs(env.queueBacking, {
        now: env.clock.now(),
        policy: env.policy,
        handler: env.handler,
      });

    await run();
    expect(env.queueBacking.jobs[0]).toMatchObject({
      status: 'pending',
      notBefore: '2026-10-23T00:00:30.000Z',
    });
    expect(await new MemorySyncStateStore(env.syncBacking).read(scope)).toBeNull();

    // 待機の前には実行しない。
    const before = env.provider.received.length;
    await run();
    expect(env.provider.received).toHaveLength(before);

    env.clock.advance(30_000);
    await run();
    expect(env.queueBacking.jobs[0]?.status).toBe('done');
    expect((await new MemorySyncStateStore(env.syncBacking).read(scope))?.entries).toHaveLength(25);
  });

  it('does not read when the dispatch check fails', async () => {
    const env = queueSetup();
    env.policy.decideDispatch(() => ({ ok: false, reason: 'connection-generation-changed' }));
    const scope = publicScope();
    await new MemoryJobQueue(env.queueBacking).enqueue({
      kind: 'read',
      scope,
      expectedGeneration: null,
    });
    await runDueJobs(env.queueBacking, {
      now: env.clock.now(),
      policy: env.policy,
      handler: env.handler,
    });
    expect(env.queueBacking.jobs[0]).toMatchObject({
      status: 'abandoned',
      abandonedReason: 'connection-generation-changed',
    });
    expect(env.provider.received).toHaveLength(0);
  });

  it.each<[string, JobRef, string]>([
    [
      'a job of another kind',
      { kind: 'step', operation: 'op-1', step: 'create' },
      'unsupported-job',
    ],
    [
      'a scope of another provider',
      {
        kind: 'read',
        scope: featuresScope(connection(), TOKEN_SOURCE, QUERY),
        expectedGeneration: null,
      },
      'unknown-scope',
    ],
  ])('abandons %s', async (_name, job, reason) => {
    const env = queueSetup();
    expect(await env.handler(job)).toEqual({ kind: 'abandoned', reason });
    expect(env.provider.received).toHaveLength(0);
  });

  it('abandons a read the deployment refuses, with the reason', async () => {
    const env = queueSetup({ contentCrs: 'http://www.opengis.net/def/crs/EPSG/0/4326' });
    expect(
      await env.handler({ kind: 'read', scope: publicScope(), expectedGeneration: null }),
    ).toEqual({ kind: 'abandoned', reason: 'unsupported-crs' });
  });

  it('falls back to the default delay when Retry-After cannot be used', async () => {
    const env = queueSetup({ intercept: () => json(429, {}, { 'retry-after': '9999999999999' }) });
    expect(
      await env.handler({ kind: 'read', scope: publicScope(), expectedGeneration: null }),
    ).toEqual({
      kind: 'retry',
      notBefore: '2026-10-23T00:01:00.000Z',
    });
  });

  it('retries after a transport failure', async () => {
    const env = queueSetup();
    const handler = createFeaturesReadHandler({
      source: PUBLIC_SOURCE,
      store: new MemorySyncStateStore(env.syncBacking),
      clock: env.clock,
      sender: () => async () => ({ ok: false, error: { kind: 'transport', phase: 'after-send' } }),
      retryDelayMs: 5_000,
    });
    expect(await handler({ kind: 'read', scope: publicScope(), expectedGeneration: null })).toEqual(
      {
        kind: 'retry',
        notBefore: '2026-10-23T00:00:05.000Z',
      },
    );
  });

  it('builds the sender from the job connection', async () => {
    const token = tokenSetup();
    const syncBacking = createSyncBacking();
    const seen: string[] = [];
    const handler = createFeaturesReadHandler({
      source: TOKEN_SOURCE,
      store: new MemorySyncStateStore(syncBacking),
      clock: token.clock,
      sender: (key) => {
        seen.push(key.connection);
        return token.reader.send;
      },
    });
    const scope = featuresScope(token.key, TOKEN_SOURCE, QUERY);
    expect(await handler({ kind: 'read', scope, expectedGeneration: null })).toEqual({
      kind: 'done',
    });
    expect(seen).toEqual(['connection-a']);
    expect(token.provider.received.every((request) => request.headers.authorization)).toBe(true);
  });
});

describe('ogcFeaturesCapabilities', () => {
  it('declares reads only, and scheduled refresh only with a background queue', () => {
    const withQueue = ogcFeaturesCapabilities({
      durableLedger: false,
      webhookIntake: false,
      backgroundQueue: true,
    });
    const withoutQueue = ogcFeaturesCapabilities({
      durableLedger: false,
      webhookIntake: true,
      backgroundQueue: false,
    });
    const status = (list: typeof withQueue, operation: string) =>
      list.find((entry) => entry.operation === operation)?.status;
    expect(status(withQueue, 'features.scheduledRefresh')).toEqual({ available: true });
    expect(status(withoutQueue, 'features.scheduledRefresh')).toEqual({
      available: false,
      reason: 'host-port-missing',
    });
    expect(status(withoutQueue, 'features.changeNotification')).toEqual({
      available: false,
      reason: 'unsupported-by-provider',
    });
    expect(withQueue.some((entry) => entry.operation.includes('write'))).toBe(false);
  });
});
