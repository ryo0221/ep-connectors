import { describe, expect, it } from 'vitest';
import type {
  ConnectionKey,
  HttpRequest,
  OperationCatalog,
  ResourceRef,
  SyncStateStore,
  TokenStore,
} from '@ep-connectors/core';
import { FakeProvider, json, type RawTransport } from '../fake-provider.js';
import {
  CONTRACT_AUTHORIZED_RESOURCES,
  CONTRACT_CATALOG,
  CONTRACT_SCOPES,
  FAKE_API,
  FAKE_ELSEWHERE,
  FAKE_FILES,
} from '../fixtures.js';

/** 契約試験が Host の実装へ渡す環境。実装はこの目録で検査し、`transport` へ送る。 */
export interface TokenStoreContractEnv {
  catalog: OperationCatalog;
  /** 接続が同意を得ている scope。 */
  scopes: readonly string[];
  /**
   * 接続の principal が読んでよい資源。実装は目録の `resources` から取り出した資源のうち、
   * これにないものを含む要求を送らない。
   */
  authorizedResources: readonly ResourceRef[];
  /** 偽の Provider。実装は token を付けた要求をここへ送る。 */
  transport: RawTransport;
  /**
   * 偽の refresh の endpoint。実装の refresh はここを呼ぶ。`revoked` を返したら接続は失効している。
   */
  refresher: (refreshToken: string) => Promise<{ accessToken: string } | 'revoked'>;
}

export interface TokenStoreContractHarness {
  /** 呼ぶたびに新しい instance を返す。保管だけを共有する。 */
  store(): TokenStore;
  /** `scopes` の同意を得た、現在の session の接続。 */
  connection: ConnectionKey;
  /** 同じ保管にあるが、現在の session のものではない接続。 */
  foreignConnection: ConnectionKey;
  /** 同期の基点の保管。`revoke` がここを無効にすることを確かめる。 */
  syncState: SyncStateStore;
  /** 出力に現れてはならない値（access token、refresh token）。 */
  secrets: readonly string[];
}

export type TokenStoreContractSetup = (
  env: TokenStoreContractEnv,
) => TokenStoreContractHarness | Promise<TokenStoreContractHarness>;

const listItems = (url = `${FAKE_API}/v1/items`): HttpRequest => ({
  operation: 'items.list',
  method: 'GET',
  url,
});

/**
 * `TokenStore` の契約試験（試験の設計 1、全体設計 3.2.1）。
 */
export function tokenStoreContract(name: string, setup: TokenStoreContractSetup): void {
  describe(`TokenStore contract: ${name}`, () => {
    async function arrange() {
      const provider = new FakeProvider();
      let refreshCalls = 0;
      let refreshOutcome: 'ok' | 'revoked' = 'ok';
      provider
        .route('GET', `${FAKE_API}/v1/items`, () =>
          json(
            200,
            { items: [] },
            { 'set-cookie': 'session=provider-cookie', 'x-request-id': 'r1' },
          ),
        )
        .route('GET', `${FAKE_API}/v1/items/{itemId}`, (_request, params) =>
          json(200, { id: params.itemId }),
        )
        .route('POST', `${FAKE_API}/v1/items`, () => json(201, { id: 'created' }))
        .route('GET', `${FAKE_API}/v1/moved`, () => ({
          status: 302,
          headers: { location: `${FAKE_ELSEWHERE}/v1/items` },
          body: '',
        }))
        .route('GET', `${FAKE_ELSEWHERE}/v1/items`, () => json(200, { stolen: true }))
        .route('GET', `${FAKE_API}/v1/flaky`, (request) => {
          // 送信した header を含む文言の例外。実装はこれを外へ出さない。
          throw new Error(`connection reset: ${JSON.stringify(request.headers)}`);
        });
      const harness = await setup({
        catalog: CONTRACT_CATALOG,
        scopes: CONTRACT_SCOPES,
        authorizedResources: CONTRACT_AUTHORIZED_RESOURCES,
        transport: provider.transport,
        refresher: async () => {
          refreshCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return refreshOutcome === 'ok' ? { accessToken: `refreshed-${refreshCalls}` } : 'revoked';
        },
      });
      return {
        provider,
        harness,
        refreshCalls: () => refreshCalls,
        failRefresh: () => {
          refreshOutcome = 'revoked';
        },
      };
    }

    function expectNoSecrets(value: unknown, secrets: readonly string[]): void {
      const text = JSON.stringify(value);
      for (const secret of secrets) expect(text).not.toContain(secret);
    }

    it('sends a catalog operation with the token attached by the Host', async () => {
      const { provider, harness } = await arrange();
      const result = await harness.store().send(harness.connection, listItems());
      expect(result.ok).toBe(true);
      expect(provider.received).toHaveLength(1);
      expect(provider.received[0]?.headers.authorization).toMatch(/^Bearer /);
    });

    it('removes credential headers from the response and leaks no secret', async () => {
      const { harness } = await arrange();
      const result = await harness.store().send(harness.connection, listItems());
      if (!result.ok) throw new Error('expected success');
      expect(result.response.headers['set-cookie']).toBeUndefined();
      expect(result.response.headers['x-request-id']).toBe('r1');
      expectNoSecrets(result, harness.secrets);
    });

    it.each<[string, HttpRequest]>([
      [
        'an operation not in the catalog',
        { operation: 'items.delete', method: 'DELETE', url: `${FAKE_API}/v1/items/1` },
      ],
      [
        'a method that differs from the catalog',
        { operation: 'items.list', method: 'POST', url: `${FAKE_API}/v1/items` },
      ],
      ['another origin', listItems(`${FAKE_ELSEWHERE}/v1/items`)],
      ['another port on the same host', listItems('https://api.fake.test:8443/v1/items')],
      ['plain http', listItems('http://api.fake.test/v1/items')],
      ['userinfo in the URL', listItems('https://user:pass@api.fake.test/v1/items')],
      ['a path outside the catalog', listItems(`${FAKE_API}/v1/items/extra/segment`)],
      [
        'an encoded traversal in a path segment',
        { operation: 'items.get', method: 'GET', url: `${FAKE_API}/v1/items/%2E%2E` },
      ],
      [
        'an encoded slash in a path segment',
        { operation: 'items.get', method: 'GET', url: `${FAKE_API}/v1/items/a%2Fb` },
      ],
      ['a query parameter not in the catalog', listItems(`${FAKE_API}/v1/items?access_token=x`)],
      [
        'an operation without a granted scope',
        { operation: 'admin.purge', method: 'POST', url: `${FAKE_API}/v1/admin/purge` },
      ],
      [
        'an unauthenticated operation',
        { operation: 'files.download', method: 'GET', url: `${FAKE_FILES}/signed/f1?sig=s` },
      ],
      [
        'a header not in the catalog',
        { ...listItems(), headers: { 'x-forwarded-host': 'elsewhere' } },
      ],
    ])('does not send %s', async (_label, request) => {
      const { provider, harness } = await arrange();
      const result = await harness.store().send(harness.connection, request);
      expect(result.ok).toBe(false);
      expect(provider.received).toHaveLength(0);
    });

    it.each(['Authorization', 'cookie', 'Proxy-Authorization'])(
      'rejects a request whose adapter sets %s instead of overriding it',
      async (header) => {
        const { provider, harness } = await arrange();
        const result = await harness
          .store()
          .send(harness.connection, { ...listItems(), headers: { [header]: 'Bearer adapter' } });
        expect(result).toEqual({
          ok: false,
          error: { kind: 'catalog', reason: 'credential-header' },
        });
        expect(provider.received).toHaveLength(0);
      },
    );

    it('does not follow an authenticated redirect to another origin', async () => {
      const { provider, harness } = await arrange();
      const store = harness.store();
      const result = await store.send(harness.connection, {
        operation: 'items.moved',
        method: 'GET',
        url: `${FAKE_API}/v1/moved`,
      });
      if (!result.ok) throw new Error('expected the redirect response');
      expect(result.response.status).toBe(302);
      expect(provider.receivedAt(FAKE_ELSEWHERE)).toHaveLength(0);

      // Adapter が redirect 先や nextLink を次の要求として送っても、目録の検査で止まる。
      const location = result.response.headers.location as string;
      const followed = await harness.store().send(harness.connection, listItems(location));
      expect(followed.ok).toBe(false);
      expect(provider.receivedAt(FAKE_ELSEWHERE)).toHaveLength(0);
    });

    it('accepts an adapter header the catalog allows', async () => {
      const { provider, harness } = await arrange();
      const result = await harness.store().send(harness.connection, {
        operation: 'items.create',
        method: 'POST',
        url: `${FAKE_API}/v1/items`,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' },
        body: '{}',
      });
      expect(result.ok).toBe(true);
      expect(provider.received[0]?.headers['idempotency-key']).toBe('k1');
    });

    it('keeps secrets out of errors when the transport fails', async () => {
      const { harness } = await arrange();
      const result = await harness.store().send(harness.connection, {
        operation: 'items.flaky',
        method: 'GET',
        url: `${FAKE_API}/v1/flaky`,
      });
      expect(result).toMatchObject({ ok: false, error: { kind: 'transport' } });
      expectNoSecrets(result, harness.secrets);
    });

    it('sends a request for a resource the principal may read', async () => {
      const { provider, harness } = await arrange();
      const result = await harness.store().send(harness.connection, {
        operation: 'items.get',
        method: 'GET',
        url: `${FAKE_API}/v1/items/item-1`,
      });
      expect(result.ok).toBe(true);
      expect(provider.received).toHaveLength(1);
    });

    it('does not send a request for a resource the token reaches but the principal may not read', async () => {
      const { provider, harness } = await arrange();
      const result = await harness.store().send(harness.connection, {
        operation: 'items.get',
        method: 'GET',
        url: `${FAKE_API}/v1/items/item-other`,
      });
      expect(result).toMatchObject({ ok: false, error: { kind: 'policy' } });
      expect(provider.received).toHaveLength(0);
    });

    it('rejects a connection that is not the current session', async () => {
      const { provider, harness } = await arrange();
      const result = await harness.store().send(harness.foreignConnection, listItems());
      expect(result.ok).toBe(false);
      expect(provider.received).toHaveLength(0);
    });

    it('rejects an older generation of the same connection', async () => {
      const { provider, harness } = await arrange();
      const older = { ...harness.connection, generation: harness.connection.generation - 1 };
      const result = await harness.store().send(older, listItems());
      expect(result.ok).toBe(false);
      expect(provider.received).toHaveLength(0);
    });

    it('merges concurrent refreshes of one connection across instances', async () => {
      const { harness, refreshCalls } = await arrange();
      const results = await Promise.all([
        harness.store().refresh(harness.connection),
        harness.store().refresh(harness.connection),
        harness.store().refresh(harness.connection),
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
      expect(refreshCalls()).toBe(1);
    });

    it('reports revoked when the refresh is refused and stops sending', async () => {
      const { provider, harness, failRefresh } = await arrange();
      failRefresh();
      expect(await harness.store().refresh(harness.connection)).toEqual({
        ok: false,
        reason: 'revoked',
      });
      expect((await harness.store().send(harness.connection, listItems())).ok).toBe(false);
      expect(provider.received).toHaveLength(0);
    });

    it.each(['foreign', 'older generation'] as const)(
      'refuses to refresh or revoke a %s key and leaves the connection untouched',
      async (which) => {
        const { provider, harness, refreshCalls } = await arrange();
        const key =
          which === 'foreign'
            ? harness.foreignConnection
            : { ...harness.connection, generation: harness.connection.generation - 1 };
        const scope = { connection: harness.connection, target: 'items', query: null };
        const staged = await harness.syncState.stage(scope, null);
        if (!staged.ok) throw new Error('stage failed');
        await harness.syncState.commit(scope, null, staged.stagedGeneration, 'cursor-1');

        // 進行中の正当な refresh があっても、そこへ合流させない。
        const legitimate = harness.store().refresh(harness.connection);
        expect(await harness.store().refresh(key)).toMatchObject({ ok: false, reason: 'policy' });
        await legitimate;
        expect(refreshCalls()).toBe(1);

        expect(await harness.store().revoke(key)).toMatchObject({ ok: false, reason: 'policy' });
        expect(await harness.syncState.read(scope)).not.toBeNull();
        expect((await harness.store().send(harness.connection, listItems())).ok).toBe(true);
        expect(provider.received).toHaveLength(1);
      },
    );

    it('stops sending after revoke and invalidates the sync basis of the connection', async () => {
      const { provider, harness } = await arrange();
      const scope = { connection: harness.connection, target: 'items', query: null };
      const staged = await harness.syncState.stage(scope, null);
      if (!staged.ok) throw new Error('stage failed');
      await harness.syncState.commit(scope, null, staged.stagedGeneration, 'cursor-1');
      expect(await harness.syncState.read(scope)).not.toBeNull();

      expect(await harness.store().revoke(harness.connection)).toEqual({ ok: true });
      const result = await harness.store().send(harness.connection, listItems());
      expect(result.ok).toBe(false);
      expect(provider.received).toHaveLength(0);
      expect(await harness.syncState.read(scope)).toBeNull();
    });
  });
}
