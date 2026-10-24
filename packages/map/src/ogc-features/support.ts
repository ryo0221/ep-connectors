import type { ConnectionKey } from '@ep-connectors/core';
import {
  ControllablePolicy,
  createTokenBacking,
  FakeProvider,
  FixedClock,
  MemoryHttpTransport,
  MemoryTokenStore,
  type MemorySyncStateStore,
} from '@ep-connectors/testing';
import type { OgcFeaturesSource } from './catalog.js';
import { ogcFeaturesCatalog } from './catalog.js';
import type { FakeCollection, FakeOgcOptions } from './fake-ogc-server.js';
import { fakeOgcServer, pointFeature } from './fake-ogc-server.js';
import type { OgcFeaturesReader } from './read.js';
import { tokenSender, transportSender } from './read.js';

// 試験の共通の準備。偽の配備を `FakeProvider` に置き、`MemoryHttpTransport` / `MemoryTokenStore`
// （目録の検査を Host の側で行う）を通して送る。

export const ORIGIN = 'https://geo.fake.test';
export const ELSEWHERE = 'https://elsewhere.fake.test';
export const BASE_PATH = '/ogcapi';

export const PUBLIC_SOURCE: OgcFeaturesSource = {
  provider: 'ogc-features:public',
  origin: ORIGIN,
  basePath: BASE_PATH,
  auth: 'none',
};

export const TOKEN_SOURCE: OgcFeaturesSource = {
  provider: 'ogc-features:private',
  origin: ORIGIN,
  basePath: BASE_PATH,
  auth: 'token',
  scopes: ['features.read'],
};

/** 東京駅の周辺。 */
export const TOKYO: [number, number, number, number] = [139.7, 35.6, 139.8, 35.7];

/** 東京の内側に 25 件、外側に 5 件の点を持つ collection。 */
export function stations(): FakeCollection {
  const inside = Array.from({ length: 25 }, (_, i) =>
    pointFeature(`station-${String(i + 1).padStart(2, '0')}`, [139.71 + i * 0.003, 35.65], {
      name: `Station ${i + 1}`,
    }),
  );
  const outside = Array.from({ length: 5 }, (_, i) =>
    pointFeature(`far-${i + 1}`, [135.5, 34.7 + i * 0.01], { name: `Far ${i + 1}` }),
  );
  return {
    id: 'stations',
    title: 'Stations',
    attribution: '© Example Survey',
    license: 'https://license.fake.test/cc-by-4.0',
    extent: [122, 20, 154, 46],
    features: [...inside, ...outside],
  };
}

export interface Setup {
  provider: FakeProvider;
  reader: OgcFeaturesReader;
  clock: FixedClock;
}

export function publicSetup(options: Partial<FakeOgcOptions> = {}): Setup {
  const provider = new FakeProvider();
  fakeOgcServer(provider, {
    origin: ORIGIN,
    basePath: BASE_PATH,
    collections: [stations()],
    ...options,
  });
  const transport = new MemoryHttpTransport({
    catalog: ogcFeaturesCatalog(PUBLIC_SOURCE),
    transport: provider.transport,
  });
  const clock = new FixedClock('2026-10-23T00:00:00.000Z');
  return {
    provider,
    reader: { source: PUBLIC_SOURCE, send: transportSender(transport), clock },
    clock,
  };
}

export function connection(overrides: Partial<ConnectionKey> = {}): ConnectionKey {
  return {
    principal: 'principal-a',
    provider: TOKEN_SOURCE.provider,
    tenant: 'tenant-a',
    account: 'account-a',
    connection: 'connection-a',
    generation: 1,
    ...overrides,
  };
}

export interface TokenSetup extends Setup {
  store: MemoryTokenStore;
  policy: ControllablePolicy;
  key: ConnectionKey;
}

export function tokenSetup(
  options: Partial<FakeOgcOptions> = {},
  extra: { scopes?: string[]; syncState?: MemorySyncStateStore } = {},
): TokenSetup {
  const provider = new FakeProvider();
  fakeOgcServer(provider, {
    origin: ORIGIN,
    basePath: BASE_PATH,
    collections: [stations()],
    ...options,
  });
  const key = connection();
  const policy = new ControllablePolicy([key]);
  const store = new MemoryTokenStore({
    backing: createTokenBacking([
      {
        key,
        accessToken: 'geo-access-token',
        refreshToken: 'geo-refresh-token',
        scopes: extra.scopes ?? ['features.read'],
        revoked: false,
      },
    ]),
    catalogs: [ogcFeaturesCatalog(TOKEN_SOURCE)],
    transport: provider.transport,
    policy,
    refresher: async () => 'revoked',
    ...(extra.syncState === undefined ? {} : { syncState: extra.syncState }),
  });
  const clock = new FixedClock('2026-10-23T00:00:00.000Z');
  return {
    provider,
    reader: { source: TOKEN_SOURCE, send: tokenSender(store, key), clock },
    clock,
    store,
    policy,
    key,
  };
}
