import type {
  ConnectionKey,
  HostPolicy,
  HttpRequest,
  HttpTransport,
  OperationCatalog,
  PolicyDenial,
  RefreshResult,
  RevokeResult,
  SendResult,
  SyncStateStore,
  TokenStore,
} from '@ep-connectors/core';
import {
  checkCatalogRequest,
  connectionIdentity,
  normalizeHeaders,
  stripCredentialResponseHeaders,
} from '@ep-connectors/core';
import type { RawTransport } from './fake-provider.js';

export interface StoredConnection {
  key: ConnectionKey;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  revoked: boolean;
}

/** 試験用の保管。複数の instance が共有し、instance は状態を持たない。 */
export interface MemoryTokenBacking {
  connections: Map<string, StoredConnection>;
  /** 同じ接続への同時の refresh を一つにまとめるための、進行中の refresh。 */
  refreshing: Map<string, Promise<RefreshResult>>;
}

export function createTokenBacking(connections: StoredConnection[] = []): MemoryTokenBacking {
  return {
    connections: new Map(connections.map((stored) => [connectionIdentity(stored.key), stored])),
    refreshing: new Map(),
  };
}

export type Refresher = (refreshToken: string) => Promise<{ accessToken: string } | 'revoked'>;

export interface MemoryTokenStoreOptions {
  backing: MemoryTokenBacking;
  catalogs: readonly OperationCatalog[];
  transport: RawTransport;
  policy: HostPolicy;
  refresher: Refresher;
  syncState?: SyncStateStore;
}

/**
 * 試験専用の `TokenStore`。本番の Host へ耐久性や安全な保管を宣言させない。全体設計 3.2.1 の
 * 境界を Host の実装の例として満たす。
 */
export class MemoryTokenStore implements TokenStore {
  constructor(private readonly options: MemoryTokenStoreOptions) {}

  /** 現在の session の、保管と同じ世代の接続かを確かめる。`send`・`refresh`・`revoke` が共有する。 */
  private async current(
    key: ConnectionKey,
  ): Promise<
    { ok: true; stored: StoredConnection | undefined } | { ok: false; denial: PolicyDenial }
  > {
    const decision = await this.options.policy.authorizeConnection(key);
    if (!decision.ok) return { ok: false, denial: decision.reason };
    const stored = this.options.backing.connections.get(connectionIdentity(key));
    if (stored && stored.key.generation !== key.generation) {
      return { ok: false, denial: 'connection-generation-changed' };
    }
    return { ok: true, stored };
  }

  async send(key: ConnectionKey, request: HttpRequest): Promise<SendResult> {
    const current = await this.current(key);
    if (!current.ok) return { ok: false, error: { kind: 'policy', reason: current.denial } };
    const stored = current.stored;
    if (!stored || stored.revoked) return { ok: false, error: { kind: 'revoked' } };
    const catalog = this.options.catalogs.find((candidate) => candidate.provider === key.provider);
    if (!catalog) return { ok: false, error: { kind: 'catalog', reason: 'unknown-operation' } };
    const check = await checkCatalogRequest({
      catalog,
      request,
      auth: 'token',
      grantedScopes: stored.scopes,
    });
    if (!check.ok) return { ok: false, error: { kind: 'catalog', reason: check.reason } };
    if (check.resources.length > 0) {
      const allowed = await this.options.policy.authorizeResources(key, check.resources);
      if (!allowed.ok) return { ok: false, error: { kind: 'policy', reason: allowed.reason } };
    }

    const headers = {
      ...normalizeHeaders(request.headers),
      authorization: `Bearer ${stored.accessToken}`,
    };
    try {
      const response = await this.options.transport({
        method: request.method,
        url: request.url,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      // 3xx も辿らずにそのまま返す。送り直すなら adapter が新しい要求として目録の検査を通す。
      return {
        ok: true,
        response: {
          status: response.status,
          headers: stripCredentialResponseHeaders(response.headers),
          body: response.body,
        },
      };
    } catch {
      // 例外の文言には送信した header が含まれ得るため、外へ出さない。
      return { ok: false, error: { kind: 'transport', phase: 'after-send' } };
    }
  }

  async refresh(key: ConnectionKey): Promise<RefreshResult> {
    const current = await this.current(key);
    if (!current.ok) return { ok: false, reason: 'policy', denial: current.denial };
    const identity = connectionIdentity(key);
    const inFlight = this.options.backing.refreshing.get(identity);
    if (inFlight) return inFlight;
    const running = this.runRefresh(identity).finally(() => {
      this.options.backing.refreshing.delete(identity);
    });
    this.options.backing.refreshing.set(identity, running);
    return running;
  }

  private async runRefresh(identity: string): Promise<RefreshResult> {
    const stored = this.options.backing.connections.get(identity);
    if (!stored || stored.revoked) return { ok: false, reason: 'revoked' };
    try {
      const result = await this.options.refresher(stored.refreshToken);
      if (result === 'revoked') {
        stored.revoked = true;
        await this.options.syncState?.invalidateConnection(stored.key);
        return { ok: false, reason: 'revoked' };
      }
      stored.accessToken = result.accessToken;
      return { ok: true };
    } catch {
      return { ok: false, reason: 'transport' };
    }
  }

  async revoke(key: ConnectionKey): Promise<RevokeResult> {
    const current = await this.current(key);
    if (!current.ok) return { ok: false, reason: 'policy', denial: current.denial };
    if (current.stored) current.stored.revoked = true;
    await this.options.syncState?.invalidateConnection(key);
    return { ok: true };
  }
}

export interface MemoryHttpTransportOptions {
  catalog: OperationCatalog;
  transport: RawTransport;
}

/** 試験専用の `HttpTransport`。目録の `auth: 'none'` の操作だけを送る。 */
export class MemoryHttpTransport implements HttpTransport {
  constructor(private readonly options: MemoryHttpTransportOptions) {}

  async send(request: HttpRequest): Promise<SendResult> {
    const check = await checkCatalogRequest({
      catalog: this.options.catalog,
      request,
      auth: 'none',
    });
    if (!check.ok) return { ok: false, error: { kind: 'catalog', reason: check.reason } };
    try {
      const response = await this.options.transport({
        method: request.method,
        url: request.url,
        headers: normalizeHeaders(request.headers),
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      return {
        ok: true,
        response: { ...response, headers: stripCredentialResponseHeaders(response.headers) },
      };
    } catch {
      return { ok: false, error: { kind: 'transport', phase: 'after-send' } };
    }
  }
}
