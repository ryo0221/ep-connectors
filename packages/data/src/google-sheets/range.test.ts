import { describe, expect, it } from 'vitest';
import type { ConnectionKey, HttpResponse, SyncScope, SyncStateStore } from '@ep-connectors/core';
import type { TableRangeRead } from '../table-range.js';
import type { ReceivedRequest } from '@ep-connectors/testing';
import {
  ControllablePolicy,
  createQueueBacking,
  createSyncBacking,
  createTokenBacking,
  FakeProvider,
  FixedClock,
  json,
  MemoryJobQueue,
  MemorySyncStateStore,
  MemoryTokenStore,
  runDueJobs,
} from '@ep-connectors/testing';
import {
  GOOGLE_SHEETS_CATALOG,
  RANGE_RESOURCE,
  SHEETS_ORIGIN,
  SHEETS_READONLY_SCOPE,
  SPREADSHEET_RESOURCE,
} from './catalog.js';
import type { SheetsRangeTarget, SheetsReadDeps } from './range.js';
import {
  readSheetsRange,
  sheetsRangeScope,
  sheetsReadJobHandler,
  syncSheetsRange,
} from './range.js';

const NOW = '2026-10-23T09:00:00.000Z';
const SPREADSHEET = 'sheet-abc_123';
const RANGE = "'Q1 予算'!A1:D10";
const connection: ConnectionKey = {
  principal: 'principal-a',
  provider: 'google-sheets',
  tenant: 'tenant-a',
  account: 'account-a',
  connection: 'connection-a',
  generation: 1,
};
const target: SheetsRangeTarget = { spreadsheetId: SPREADSHEET, range: RANGE };

interface FakeRange {
  resolved: string;
  /** 末尾の空のセル・行を省いた、Sheets が返す形の値。 */
  values?: unknown[][];
}

/**
 * 偽の Google Sheets。`values:batchGet` の応答の形と、末尾の空のセル・行を省くこと、
 * 解決できない範囲を 400 で返すこと（要確認、Data 接続の設計 2）だけを再現する。
 */
class FakeSheets {
  readonly provider = new FakeProvider();
  /** 有効な access token。 */
  token = 'access-1';
  spreadsheets = new Map<string, Map<string, FakeRange>>();
  /** 次の応答を差し替える。 */
  override:
    | ((request: ReceivedRequest) => HttpResponse | undefined | Promise<HttpResponse | undefined>)
    | null = null;

  constructor() {
    this.provider.route(
      'GET',
      `${SHEETS_ORIGIN}/v4/spreadsheets/{spreadsheetId}/values:batchGet`,
      async (request, params) => {
        const overridden = await this.override?.(request);
        if (overridden) return overridden;
        if (request.headers.authorization !== `Bearer ${this.token}`) {
          return json(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
        }
        const ranges = this.spreadsheets.get(params.spreadsheetId as string);
        if (!ranges) return json(404, { error: { code: 404, status: 'NOT_FOUND' } });
        const url = new URL(request.url);
        const requested = url.searchParams.getAll('ranges');
        const valueRanges = requested.map((range) => ranges.get(range));
        if (valueRanges.some((range) => range === undefined)) {
          return json(400, { error: { code: 400, status: 'INVALID_ARGUMENT' } });
        }
        return json(200, {
          spreadsheetId: params.spreadsheetId,
          valueRanges: valueRanges.map((range) => ({
            range: range?.resolved,
            majorDimension: 'ROWS',
            ...(range?.values ? { values: range.values } : {}),
          })),
        });
      },
    );
  }

  set(spreadsheetId: string, range: string, value: FakeRange): void {
    const ranges = this.spreadsheets.get(spreadsheetId) ?? new Map<string, FakeRange>();
    ranges.set(range, value);
    this.spreadsheets.set(spreadsheetId, ranges);
  }

  get received(): ReceivedRequest[] {
    return this.provider.received;
  }
}

function arrange(options: { scopes?: string[]; refresh?: 'ok' | 'revoked' } = {}) {
  const sheets = new FakeSheets();
  sheets.set(SPREADSHEET, RANGE, {
    resolved: "'Q1 予算'!A1:D10",
    values: [
      ['項目', '金額', '確定', '備考'],
      ['会場', 120000, true],
      ['', 4500.5, false, '交通費'],
    ],
  });
  const policy = new ControllablePolicy([connection]);
  const clock = new FixedClock(NOW);
  const syncBacking = createSyncBacking();
  const tokenBacking = createTokenBacking([
    {
      key: connection,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      scopes: options.scopes ?? [SHEETS_READONLY_SCOPE],
      revoked: false,
    },
  ]);
  // 差し口は呼出しごとに新しい instance を作り、保管だけを共有する（試験の設計 1）。
  const syncState = (): SyncStateStore => new MemorySyncStateStore(syncBacking);
  const deps = (overrides: Partial<SheetsReadDeps> = {}): SheetsReadDeps => ({
    tokens: new MemoryTokenStore({
      backing: tokenBacking,
      catalogs: [GOOGLE_SHEETS_CATALOG],
      transport: sheets.provider.transport,
      policy,
      syncState: syncState(),
      refresher: async () => {
        if (options.refresh === 'revoked') return 'revoked';
        sheets.token = 'access-2';
        return { accessToken: 'access-2' };
      },
    }),
    syncState: syncState(),
    clock,
    ...overrides,
  });
  const readCopy = async (target: SyncScope): Promise<TableRangeRead | null> => {
    const result = await readSheetsRange({ policy, syncState: syncState() }, target);
    return result.ok ? result.read : null;
  };
  return { sheets, policy, clock, syncBacking, syncState, deps, readCopy };
}

const scope = sheetsRangeScope(connection, target);

describe('Google Sheets range read', () => {
  it('reads a range through the token store and publishes it as one generation', async () => {
    const { sheets, deps, readCopy } = arrange();
    expect(await readCopy(scope)).toBeNull();

    const result = await syncSheetsRange(deps(), scope);
    expect(result).toMatchObject({ kind: 'published' });

    const read = await readCopy(scope);
    expect(read).toMatchObject({
      source: {
        provider: 'google-sheets',
        container: SPREADSHEET,
        requestedRange: RANGE,
        resolvedRange: "'Q1 予算'!A1:D10",
      },
      valueRender: 'unformatted',
      columnCount: 4,
      fetchedAt: NOW,
      rows: [
        ['項目', '金額', '確定', '備考'],
        ['会場', 120000, true, null],
        [null, 4500.5, false, '交通費'],
      ],
    });
    expect(read?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Adapter は認証の header を付けず、Host が付けた token で一回だけ送られる。
    expect(sheets.received).toHaveLength(1);
    const sent = sheets.received[0] as ReceivedRequest;
    expect(sent.headers.authorization).toBe('Bearer access-1');
    const url = new URL(sent.url);
    expect(url.pathname).toBe(`/v4/spreadsheets/${SPREADSHEET}/values:batchGet`);
    expect(url.searchParams.getAll('ranges')).toEqual([RANGE]);
    expect(url.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
    expect(url.searchParams.get('dateTimeRenderOption')).toBe('SERIAL_NUMBER');
  });

  it('publishes an empty range as zero rows', async () => {
    const { sheets, deps, readCopy } = arrange();
    sheets.set(SPREADSHEET, 'Empty!A1:C3', { resolved: 'Empty!A1:C3' });
    const empty = sheetsRangeScope(connection, {
      spreadsheetId: SPREADSHEET,
      range: 'Empty!A1:C3',
    });
    expect(await syncSheetsRange(deps(), empty)).toMatchObject({ kind: 'published' });
    expect(await readCopy(empty)).toMatchObject({ rows: [], columnCount: 0 });
  });

  it('keeps the generation when the content has not changed and advances it when it has', async () => {
    const { sheets, deps, readCopy, clock } = arrange();
    const first = await syncSheetsRange(deps(), scope);
    if (first.kind !== 'published') throw new Error('expected a published generation');

    clock.advance(60_000);
    expect(await syncSheetsRange(deps(), scope)).toEqual({
      kind: 'unchanged',
      generation: first.generation,
    });
    expect((await readCopy(scope))?.fetchedAt).toBe(NOW);

    sheets.set(SPREADSHEET, RANGE, { resolved: "'Q1 予算'!A1:D10", values: [['項目'], ['会場']] });
    const second = await syncSheetsRange(deps(), scope);
    expect(second).toMatchObject({ kind: 'published' });
    const read = await readCopy(scope);
    expect(read?.generation).toBeGreaterThan(first.generation);
    expect(read?.rows).toEqual([['項目'], ['会場']]);
  });

  it('does not share a copy between different ranges or value renderings', async () => {
    const { sheets, deps, readCopy } = arrange();
    sheets.set(SPREADSHEET, RANGE, { resolved: "'Q1 予算'!A1:D10", values: [['1,200']] });
    await syncSheetsRange(deps(), scope);
    const formatted = sheetsRangeScope(connection, { ...target, valueRender: 'formatted' });
    expect(await readCopy(formatted)).toBeNull();
    await syncSheetsRange(deps(), formatted);
    const sent = new URL((sheets.received[1] as ReceivedRequest).url);
    expect(sent.searchParams.get('valueRenderOption')).toBe('FORMATTED_VALUE');
    expect(sent.searchParams.has('dateTimeRenderOption')).toBe(false);
    expect((await readCopy(formatted))?.valueRender).toBe('formatted');
  });

  it('publishes one generation when the same read job is delivered twice', async () => {
    const { deps, readCopy, policy, syncBacking } = arrange();
    const queue = createQueueBacking();
    await new MemoryJobQueue(queue).enqueue({ kind: 'read', scope, expectedGeneration: null });
    await runDueJobs(queue, {
      now: NOW,
      policy,
      handler: (job) => sheetsReadJobHandler(deps())(job),
      deliveries: 2,
    });
    expect(queue.jobs[0]?.status).toBe('done');
    const read = await readCopy(scope);
    expect(read?.rows).toHaveLength(3);
    // 二つの配送が staging を作っても、公開されるのは一つで、残りは公開されない。
    const state = [...syncBacking.scopes.values()][0];
    expect(state?.published?.generation).toBe(read?.generation);
  });

  it('does not publish a second generation for a delayed duplicate of a read job', async () => {
    const { sheets, deps, readCopy } = arrange();
    // 先に届いた配送が公開した後で、同じ job（期待する世代は null）の配送が遅れて走る。
    expect(await syncSheetsRange(deps(), scope, { expectedGeneration: null })).toMatchObject({
      kind: 'published',
    });
    const first = await readCopy(scope);
    sheets.set(SPREADSHEET, RANGE, { resolved: RANGE, values: [['changed']] });
    expect(
      await sheetsReadJobHandler(deps())({ kind: 'read', scope, expectedGeneration: null }),
    ).toEqual({ kind: 'done' });
    expect(await readCopy(scope)).toEqual(first);
    expect(sheets.received).toHaveLength(1);
  });

  it('does not publish values fetched while the connection was revoked', async () => {
    const { sheets, deps, readCopy } = arrange();
    // 初回の取得の送信中に接続が解除される。
    sheets.override = async () => {
      expect(await deps().tokens.revoke(connection)).toEqual({ ok: true });
      return undefined;
    };
    expect(await syncSheetsRange(deps(), scope)).toMatchObject({ kind: 'retry' });
    expect(await readCopy(scope)).toBeNull();
  });

  it('does not keep values fetched while the connection was revoked over a published copy', async () => {
    const { sheets, deps, readCopy } = arrange();
    await syncSheetsRange(deps(), scope);
    sheets.set(SPREADSHEET, RANGE, { resolved: RANGE, values: [['changed']] });
    sheets.override = async () => {
      await deps().tokens.revoke(connection);
      return undefined;
    };
    expect(await syncSheetsRange(deps(), scope)).toEqual({ kind: 'superseded' });
    expect(await readCopy(scope)).toBeNull();
  });

  it('does not run a read job whose dispatch is denied', async () => {
    const { deps, sheets, policy } = arrange();
    const queue = createQueueBacking();
    await new MemoryJobQueue(queue).enqueue({ kind: 'read', scope, expectedGeneration: null });
    policy.decideDispatch(() => ({ ok: false, reason: 'revoked' }));
    await runDueJobs(queue, { now: NOW, policy, handler: sheetsReadJobHandler(deps()) });
    expect(queue.jobs[0]).toMatchObject({ status: 'abandoned', abandonedReason: 'revoked' });
    expect(sheets.received).toHaveLength(0);
  });

  it('leaves the previous generation visible when a restart interrupts the staging', async () => {
    const { sheets, deps, syncState, readCopy, syncBacking } = arrange();
    await syncSheetsRange(deps(), scope);
    const before = await readCopy(scope);

    sheets.set(SPREADSHEET, RANGE, {
      resolved: "'Q1 予算'!A1:D10",
      values: Array.from({ length: 7 }, (_, index) => [`row ${index}`]),
    });
    // 二ページ目を書いた後に止まる保管。
    const crashing = syncState();
    let pages = 0;
    const applyPage = crashing.applyPage.bind(crashing);
    crashing.applyPage = async (...args) => {
      pages += 1;
      if (pages > 2) throw new Error('process stopped');
      return applyPage(...args);
    };
    await expect(
      syncSheetsRange(deps({ syncState: crashing, pageRows: 2 }), scope),
    ).rejects.toThrow('process stopped');
    MemorySyncStateStore.restart(syncBacking);
    expect(await readCopy(scope)).toEqual(before);

    // 再起動の後は公開済みの世代から取り直し、取りこぼしがない。
    expect(await syncSheetsRange(deps({ pageRows: 2 }), scope)).toMatchObject({
      kind: 'published',
    });
    expect((await readCopy(scope))?.rows).toHaveLength(7);
  });

  it('refreshes once on 401 and resends', async () => {
    const { sheets, deps } = arrange();
    // Provider 側で token が失効している。Refresh で Provider 側の token も access-2 になる。
    sheets.token = 'rotated';
    expect(await syncSheetsRange(deps(), scope)).toMatchObject({ kind: 'published' });
    expect(sheets.received.map((request) => request.headers.authorization)).toEqual([
      'Bearer access-1',
      'Bearer access-2',
    ]);
  });

  it('stops and drops the cached copy when the refresh token is revoked', async () => {
    const { sheets, deps, readCopy } = arrange({ refresh: 'revoked' });
    await syncSheetsRange(deps(), scope);
    sheets.token = 'rotated';
    expect(await syncSheetsRange(deps(), scope)).toEqual({ kind: 'failed', reason: 'revoked' });
    expect(await readCopy(scope)).toBeNull();
    expect(await syncSheetsRange(deps(), scope)).toEqual({ kind: 'failed', reason: 'revoked' });
    expect(sheets.received).toHaveLength(2);
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not-found'],
  ] as const)('drops the cached copy when the sheet answers %i', async (status, reason) => {
    const { sheets, deps, readCopy } = arrange();
    await syncSheetsRange(deps(), scope);
    sheets.override = () => json(status, { error: { code: status } });
    expect(await syncSheetsRange(deps(), scope)).toEqual({ kind: 'failed', reason });
    expect(await readCopy(scope)).toBeNull();
  });

  it('keeps the published copy and reports an unresolvable range', async () => {
    const { deps, readCopy } = arrange();
    await syncSheetsRange(deps(), scope);
    const renamed = sheetsRangeScope(connection, { ...target, range: 'Renamed!A1:B2' });
    expect(await syncSheetsRange(deps(), renamed)).toEqual({
      kind: 'failed',
      reason: 'invalid-range',
    });
    expect(await readCopy(scope)).not.toBeNull();
  });

  it.each([
    ['429 with Retry-After', json(429, {}, { 'retry-after': '120' }), 'rate-limited', 120],
    ['429 with a long Retry-After', json(429, {}, { 'retry-after': '7200' }), 'rate-limited', 7200],
    ['429 without Retry-After', json(429, {}), 'rate-limited', 30],
    ['503', json(503, {}), 'unavailable', 30],
  ] as const)(
    'asks to retry after %s without publishing',
    async (_label, response, reason, wait) => {
      const { sheets, deps, readCopy, policy } = arrange();
      sheets.override = () => response;
      const result = await syncSheetsRange(deps(), scope);
      expect(result).toEqual({
        kind: 'retry',
        reason,
        notBefore: new Date(Date.parse(NOW) + wait * 1000).toISOString(),
      });
      expect(await readCopy(scope)).toBeNull();

      const queue = createQueueBacking();
      await new MemoryJobQueue(queue).enqueue({ kind: 'read', scope, expectedGeneration: null });
      await runDueJobs(queue, { now: NOW, policy, handler: sheetsReadJobHandler(deps()) });
      expect(queue.jobs[0]).toMatchObject({
        status: 'pending',
        notBefore: new Date(Date.parse(NOW) + wait * 1000).toISOString(),
      });
    },
  );

  it.each([
    ['a nested object', [['ok', { formula: '=A1' }]]],
    ['a non-row value', ['flat']],
  ])('rejects a response with %s and publishes nothing', async (_label, values) => {
    const { sheets, deps, readCopy } = arrange();
    sheets.set(SPREADSHEET, RANGE, { resolved: RANGE, values: values as unknown[][] });
    expect(await syncSheetsRange(deps(), scope)).toEqual({
      kind: 'failed',
      reason: 'malformed-response',
    });
    expect(await readCopy(scope)).toBeNull();
  });

  it('rejects a response for another spreadsheet', async () => {
    const { sheets, deps } = arrange();
    sheets.override = () =>
      json(200, { spreadsheetId: 'other', valueRanges: [{ range: RANGE, values: [['x']] }] });
    expect(await syncSheetsRange(deps(), scope)).toEqual({
      kind: 'failed',
      reason: 'malformed-response',
    });
  });

  it('refuses a range larger than the cell limit without publishing', async () => {
    const { sheets, deps, readCopy } = arrange();
    sheets.set(SPREADSHEET, RANGE, {
      resolved: RANGE,
      values: Array.from({ length: 11 }, () => [1, 2, 3]),
    });
    expect(await syncSheetsRange(deps({ maxCells: 30 }), scope)).toEqual({
      kind: 'failed',
      reason: 'too-large',
    });
    expect(await readCopy(scope)).toBeNull();
  });

  it.each([
    ['another spreadsheet', { spreadsheetId: 'other-project', range: RANGE }],
    [
      'another range of the allowed spreadsheet',
      { spreadsheetId: SPREADSHEET, range: 'Salaries!A1:Z9' },
    ],
  ])('does not send for %s that the project may not read', async (_label, other) => {
    const { sheets, deps, policy } = arrange();
    sheets.set(other.spreadsheetId, other.range, { resolved: other.range, values: [['secret']] });
    // Host は project に登録された（spreadsheet、範囲）の組だけを許す。
    policy.decideResources(
      (_key, resource) =>
        (resource.kind === SPREADSHEET_RESOURCE && resource.id === SPREADSHEET) ||
        (resource.kind === RANGE_RESOURCE && resource.id === RANGE),
    );
    expect(await syncSheetsRange(deps(), sheetsRangeScope(connection, other))).toEqual({
      kind: 'failed',
      reason: 'not-authorized',
    });
    expect(sheets.received).toHaveLength(0);
    expect(await syncSheetsRange(deps(), scope)).toMatchObject({ kind: 'published' });
  });

  it('checks the project authorization each time the copy is shown', async () => {
    const { sheets, deps, policy, syncState, readCopy } = arrange();
    await syncSheetsRange(deps(), scope);
    expect(await readCopy(scope)).not.toBeNull();

    // Project から外されると、写しが残っていても返さない。
    policy.decideResources((_key, resource) => resource.kind !== SPREADSHEET_RESOURCE);
    expect(await readSheetsRange({ policy, syncState: syncState() }, scope)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    // 次の取得は送らずに止まり、写しを捨てる。
    expect(await syncSheetsRange(deps(), scope)).toEqual({
      kind: 'failed',
      reason: 'not-authorized',
    });
    expect(sheets.received).toHaveLength(1);
    policy.decideResources(() => true);
    expect(await readSheetsRange({ policy, syncState: syncState() }, scope)).toEqual({
      ok: false,
      reason: 'not-synced',
    });
  });

  it('does not show the copy to a session that no longer holds the connection', async () => {
    const { deps, policy, syncState } = arrange();
    await syncSheetsRange(deps(), scope);
    // 利用者が space から退室し、Host の session からこの接続が外れた。
    policy.setConnections([]);
    expect(await readSheetsRange({ policy, syncState: syncState() }, scope)).toEqual({
      ok: false,
      reason: 'not-current-session',
    });
  });

  it('does not send when the connection lacks the read-only scope', async () => {
    const { sheets, deps } = arrange({ scopes: ['https://www.googleapis.com/auth/drive.file'] });
    expect(await syncSheetsRange(deps(), scope)).toEqual({ kind: 'failed', reason: 'catalog' });
    expect(sheets.received).toHaveLength(0);
  });

  it('does not send for a connection that is not the current session', async () => {
    const { sheets, deps } = arrange();
    const stale = sheetsRangeScope({ ...connection, generation: 0 }, target);
    expect(await syncSheetsRange(deps(), stale)).toEqual({ kind: 'failed', reason: 'policy' });
    expect(sheets.received).toHaveLength(0);
  });

  it.each([
    ['a spreadsheet ID with a slash', { spreadsheetId: 'a/b', range: 'A1' }],
    ['a spreadsheet ID with dots', { spreadsheetId: '..', range: 'A1' }],
    ['an empty range', { spreadsheetId: SPREADSHEET, range: '' }],
    ['a range with a newline', { spreadsheetId: SPREADSHEET, range: 'A1\nB2' }],
  ])('rejects %s before sending', (_label, invalid) => {
    expect(() => sheetsRangeScope(connection, invalid)).toThrow(TypeError);
  });

  it('accepts a sheet name with a slash because the range goes in the query', async () => {
    const { sheets, deps, readCopy } = arrange();
    const slashed = { spreadsheetId: SPREADSHEET, range: "'2026/10'!A1:B2" };
    sheets.set(SPREADSHEET, slashed.range, { resolved: slashed.range, values: [['a', 'b']] });
    const slashedScope = sheetsRangeScope(connection, slashed);
    expect(await syncSheetsRange(deps(), slashedScope)).toMatchObject({ kind: 'published' });
    expect((await readCopy(slashedScope))?.rows).toEqual([['a', 'b']]);
  });

  it('abandons a read job for another provider', async () => {
    const { deps } = arrange();
    const other = { ...scope, connection: { ...connection, provider: 'fake' } };
    expect(
      await sheetsReadJobHandler(deps())({ kind: 'read', scope: other, expectedGeneration: null }),
    ).toEqual({ kind: 'abandoned', reason: 'unsupported-job' });
  });
});
