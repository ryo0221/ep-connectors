import type { Clock, ConnectionKey, IdSource, OperationCatalog } from '@ep-connectors/core';

export const FAKE_API = 'https://api.fake.test';
export const FAKE_FILES = 'https://files.fake.test';
export const FAKE_ELSEWHERE = 'https://elsewhere.fake.test';

/** 契約試験で使う偽の Provider の目録。 */
export const CONTRACT_CATALOG: OperationCatalog = {
  provider: 'fake',
  operations: [
    {
      name: 'items.list',
      method: 'GET',
      origin: FAKE_API,
      path: '/v1/items',
      query: ['pageToken', 'syncToken'],
      scopes: ['items.read'],
      auth: 'token',
    },
    {
      name: 'items.get',
      method: 'GET',
      origin: FAKE_API,
      path: '/v1/items/{itemId}',
      scopes: ['items.read'],
      auth: 'token',
    },
    {
      name: 'items.create',
      method: 'POST',
      origin: FAKE_API,
      path: '/v1/items',
      headers: ['content-type', 'idempotency-key'],
      scopes: ['items.write'],
      auth: 'token',
    },
    {
      name: 'items.moved',
      method: 'GET',
      origin: FAKE_API,
      path: '/v1/moved',
      scopes: ['items.read'],
      auth: 'token',
    },
    {
      name: 'items.flaky',
      method: 'GET',
      origin: FAKE_API,
      path: '/v1/flaky',
      scopes: ['items.read'],
      auth: 'token',
    },
    {
      name: 'admin.purge',
      method: 'POST',
      origin: FAKE_API,
      path: '/v1/admin/purge',
      scopes: ['admin'],
      auth: 'token',
    },
    {
      name: 'files.download',
      method: 'GET',
      origin: FAKE_FILES,
      path: '/signed/{fileId}',
      query: ['sig'],
      scopes: [],
      auth: 'none',
    },
  ],
};

/** 契約試験の connection が同意を得ている scope。`admin` は含めない。 */
export const CONTRACT_SCOPES = ['items.read', 'items.write'];

export function contractConnection(overrides: Partial<ConnectionKey> = {}): ConnectionKey {
  return {
    principal: 'principal-a',
    provider: 'fake',
    tenant: 'tenant-a',
    account: 'account-a',
    connection: 'connection-a',
    generation: 1,
    ...overrides,
  };
}

export class FixedClock implements Clock {
  constructor(private current: string = '2026-01-01T00:00:00.000Z') {}
  now(): string {
    return this.current;
  }
  set(iso: string): void {
    this.current = iso;
  }
  advance(milliseconds: number): void {
    this.current = new Date(Date.parse(this.current) + milliseconds).toISOString();
  }
}

export class SequentialIds implements IdSource {
  private counter = 0;
  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }
}
