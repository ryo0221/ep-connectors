import { describe, expect, it } from 'vitest';
import type { ConnectionKey, OperationCatalog, SyncScope } from '@ep-connectors/core';
import { checkCatalogRequest } from '@ep-connectors/core';
import {
  ControllablePolicy,
  createLedgerBacking,
  createQueueBacking,
  createSyncBacking,
  createTokenBacking,
  createWebhookBacking,
  fakeWebhook,
  FixedClock,
  json,
  MemoryJobQueue,
  MemoryLedger,
  MemorySyncStateStore,
  MemoryTokenStore,
  MemoryWebhookIntake,
  runDueJobs,
} from '@ep-connectors/testing';
import {
  EVENTS_LIST,
  enqueueReadsForSignal,
  GOOGLE_CALENDAR_CATALOG,
  GOOGLE_CALENDAR_EVENTS_READ_SCOPE,
  googleCalendarReadJobHandler,
  googleCalendarScope,
  readGoogleCalendarRange,
  syncGoogleCalendar,
  syncGoogleCalendarNow,
} from '../src/google/index.js';
import { FakeGoogleCalendar } from './fake-google-calendar.js';

// R1 の Schedule の読取の縦断試験（段階と分野 1）。偽の Google Calendar を、メモリ実装の
// TokenStore・SyncStateStore・JobQueue・WebhookIntake の上に通す。各呼出しで新しい instance を
// 作り、保管だけを共有する（試験の設計 1）。

const CALENDAR = 'primary';
const WINDOW = { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' };
const RANGE = { from: Date.parse(WINDOW.start), to: Date.parse(WINDOW.end) };

function setup(options: { scopes?: string[] } = {}) {
  const connection: ConnectionKey = {
    principal: 'principal-a',
    provider: 'google',
    tenant: 'consumer',
    account: 'account-a',
    connection: 'connection-a',
    generation: 1,
  };
  const google = new FakeGoogleCalendar();
  const clock = new FixedClock('2026-10-23T09:00:00.000Z');
  const policy = new ControllablePolicy([connection]);
  const syncBacking = createSyncBacking();
  const queueBacking = createQueueBacking();
  const tokenBacking = createTokenBacking([
    {
      key: connection,
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-secret',
      scopes: options.scopes ?? [GOOGLE_CALENDAR_EVENTS_READ_SCOPE],
      revoked: false,
    },
  ]);
  let refreshResult: { accessToken: string } | 'revoked' = { accessToken: 'access-token-2' };
  const refreshes: string[] = [];
  const catalogs: OperationCatalog[] = [GOOGLE_CALENDAR_CATALOG];
  const sync = () => new MemorySyncStateStore(syncBacking);
  const deps = () => ({
    tokens: new MemoryTokenStore({
      backing: tokenBacking,
      catalogs,
      transport: google.provider.transport,
      policy,
      refresher: async (refreshToken: string) => {
        refreshes.push(refreshToken);
        return refreshResult;
      },
      syncState: sync(),
    }),
    sync: sync(),
    queue: new MemoryJobQueue(queueBacking),
    clock,
    retryDelayMs: 30_000,
  });
  const scope = googleCalendarScope({ connection, calendarId: CALENDAR, window: WINDOW });
  const read = (target: SyncScope = scope, range = RANGE) =>
    readGoogleCalendarRange(
      { sync: sync(), policy },
      { sourceHandle: 'source-1', scope: target, range },
    );
  const runJobs = (deliveries?: number) =>
    runDueJobs(queueBacking, {
      now: clock.now(),
      policy,
      handler: googleCalendarReadJobHandler(deps()),
      ...(deliveries === undefined ? {} : { deliveries }),
    });
  return {
    connection,
    google,
    clock,
    policy,
    syncBacking,
    queueBacking,
    deps,
    scope,
    read,
    runJobs,
    refreshes,
    setRefresh: (result: typeof refreshResult) => {
      refreshResult = result;
    },
  };
}

function timed(id: string, day: number, summary = id) {
  const date = `2026-11-${String(day).padStart(2, '0')}`;
  return {
    id,
    summary,
    start: { dateTime: `${date}T10:00:00+09:00` },
    end: { dateTime: `${date}T11:00:00+09:00` },
  };
}

function titles(read: { events: { title?: string }[] }): (string | undefined)[] {
  return read.events.map((event) => event.title);
}

describe('Google Calendar read over the shared ports', () => {
  it('reads every page of the window, then publishes the cache and the sync token together', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    t.google.put(CALENDAR, timed('b', 5));
    t.google.put(CALENDAR, timed('c', 7));
    t.google.put(CALENDAR, timed('first', 1));
    t.google.put(CALENDAR, {
      id: 'december',
      start: { dateTime: '2026-12-05T10:00:00Z' },
      end: { dateTime: '2026-12-05T11:00:00Z' },
    });

    expect(await t.read()).toMatchObject({ complete: false, fetchedAt: null, events: [] });
    const outcome = await syncGoogleCalendar(t.deps(), t.scope);
    expect(outcome).toMatchObject({ kind: 'committed', mode: 'full', pages: 2 });

    const read = await t.read();
    expect(read).toMatchObject({
      sourceHandle: 'source-1',
      generation: '1',
      complete: true,
      missing: [],
      fetchedAt: Date.parse('2026-10-23T09:00:00.000Z'),
    });
    expect(titles(read)).toEqual(['first', 'a', 'b', 'c']);
    expect(read.events[1]).toEqual({
      id: 'a',
      sourceHandle: 'source-1',
      start: Date.parse('2026-11-03T01:00:00Z'),
      end: Date.parse('2026-11-03T02:00:00Z'),
      title: 'a',
    });

    // 全件取得は期間を付けて送り、token は Host だけが付ける。
    const first = new URL(t.google.listRequests[0]?.url ?? '');
    expect(first.searchParams.get('timeMin')).toBe(WINDOW.start);
    expect(first.searchParams.get('timeMax')).toBe(WINDOW.end);
    expect(first.searchParams.get('syncToken')).toBeNull();
    expect(t.google.listRequests.map((request) => request.headers.authorization)).toEqual([
      'Bearer access-token-1',
      'Bearer access-token-1',
    ]);
    expect(JSON.stringify(outcome)).not.toMatch(/access-token|refresh-token/);
  });

  it('applies changes from the sync token, including cancellations and events leaving the window', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    t.google.put(CALENDAR, timed('b', 5));
    await syncGoogleCalendar(t.deps(), t.scope);

    t.google.put(CALENDAR, timed('a', 4, 'a moved'));
    t.google.cancel(CALENDAR, 'b');
    t.google.put(CALENDAR, timed('c', 9));
    // 期間の外へ移った予定は、差分に含まれても cache から外す。
    t.google.put(CALENDAR, {
      id: 'c',
      start: { dateTime: '2027-01-09T10:00:00Z' },
      end: { dateTime: '2027-01-09T11:00:00Z' },
    });
    t.google.put(CALENDAR, timed('d', 20));
    const before = t.google.listRequests.length;

    expect(await syncGoogleCalendar(t.deps(), t.scope)).toMatchObject({
      kind: 'committed',
      mode: 'incremental',
    });
    const incremental = t.google.listRequests.slice(before).map((request) => new URL(request.url));
    expect(incremental[0]?.searchParams.get('syncToken')).toBe('sync-2');
    expect(incremental.every((url) => url.searchParams.get('timeMin') === null)).toBe(true);
    expect(titles(await t.read())).toEqual(['a moved', 'd']);
    const cached = await t.deps().sync.read(t.scope);
    expect(cached?.entries.map((entry) => entry.id)).toEqual(['a', 'd']);
  });

  it('keeps the published generation when a page fails, and catches up from the queue', async () => {
    const t = setup();
    for (const [index, id] of ['a', 'b', 'c'].entries())
      t.google.put(CALENDAR, timed(id, index + 1));
    await syncGoogleCalendar(t.deps(), t.scope);
    const published = await t.read();

    for (const [index, id] of ['d', 'e', 'f'].entries())
      t.google.put(CALENDAR, timed(id, index + 10));
    // 1 ページ目は届き、2 ページ目で通信が切れる。
    t.google.inject(json(200, { items: [], nextPageToken: 'unused' }), 'throw');
    expect(await syncGoogleCalendarNow(t.deps(), t.scope)).toEqual({
      kind: 'deferred',
      notBefore: '2026-10-23T09:00:30.000Z',
      reason: 'transport',
    });
    MemorySyncStateStore.restart(t.syncBacking);
    expect(await t.read()).toEqual(published);
    expect(t.queueBacking.jobs).toMatchObject([
      { job: { kind: 'read', expectedGeneration: 1 }, notBefore: '2026-10-23T09:00:30.000Z' },
    ]);

    await t.runJobs();
    expect(t.queueBacking.jobs[0]?.status).toBe('pending');
    t.clock.advance(30_000);
    await t.runJobs();
    expect(t.queueBacking.jobs[0]?.status).toBe('done');
    expect(titles(await t.read())).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('waits as long as Retry-After says on a rate limit, and does not resend by itself', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    t.google.inject(json(429, { error: { code: 429 } }, { 'retry-after': '120' }));
    expect(await syncGoogleCalendarNow(t.deps(), t.scope)).toMatchObject({
      kind: 'deferred',
      reason: 'rate-limit',
      notBefore: '2026-10-23T09:02:00.000Z',
    });
    expect(t.google.listRequests).toHaveLength(1);

    t.google.inject(
      json(403, { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }),
    );
    t.clock.advance(120_000);
    await t.runJobs();
    expect(t.queueBacking.jobs[0]).toMatchObject({
      status: 'pending',
      notBefore: '2026-10-23T09:02:30.000Z',
    });
    t.clock.advance(30_000);
    await t.runJobs();
    expect(t.queueBacking.jobs[0]?.status).toBe('done');
    expect(titles(await t.read())).toEqual(['a']);
  });

  it('rebuilds only the calendar cache on 410 and leaves the ledger alone', async () => {
    const t = setup();
    const ledger = new MemoryLedger(createLedgerBacking());
    await ledger.claim({
      slot: 'artifact-1/event-1',
      operation: 'op-1',
      planDigest: 'digest-1',
      plan: { title: 'x' },
      steps: ['calendar'],
    });
    const record = await ledger.read('op-1');
    await ledger.acquireStep('op-1', 'calendar', record?.steps.calendar?.generation ?? 0);
    const unresolved = await ledger.listUnresolved();
    expect(unresolved).toHaveLength(1);

    t.google.put(CALENDAR, timed('a', 3));
    t.google.put(CALENDAR, timed('b', 5));
    await syncGoogleCalendar(t.deps(), t.scope);
    t.google.cancel(CALENDAR, 'a');
    t.google.put(CALENDAR, timed('c', 6));
    t.google.expireSyncTokens();

    // 作り直しの全件取得が途中で失敗したら、読む側には incomplete だけが見える。
    t.google.inject(json(410, { error: { code: 410 } }), 'throw');
    expect(await syncGoogleCalendar(t.deps(), t.scope)).toMatchObject({ kind: 'deferred' });
    expect(await t.read()).toMatchObject({ complete: false, events: [], fetchedAt: null });

    expect(await syncGoogleCalendar(t.deps(), t.scope)).toMatchObject({
      kind: 'committed',
      mode: 'full',
    });
    expect(titles(await t.read())).toEqual(['b', 'c']);
    expect(await ledger.listUnresolved()).toEqual(unresolved);
  });

  it('leaves a newer rebuild alone when its own 410 arrives late', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    await syncGoogleCalendar(t.deps(), t.scope);
    t.google.put(CALENDAR, timed('b', 4));
    t.google.expireSyncTokens();

    // 遅い worker の差分の要求が 410 を受け取る前に、別の worker が作り直して公開する。
    const slow = t.deps();
    const tokens = slow.tokens;
    let raced = false;
    slow.tokens = Object.assign(Object.create(tokens) as typeof tokens, {
      send: async (...args: Parameters<typeof tokens.send>) => {
        const sent = await tokens.send(...args);
        if (!raced) {
          raced = true;
          expect(await syncGoogleCalendar(t.deps(), t.scope)).toMatchObject({ mode: 'full' });
        }
        return sent;
      },
    });
    expect(await syncGoogleCalendar(slow, t.scope)).toEqual({ kind: 'superseded' });
    const read = await t.read();
    expect(read.complete).toBe(true);
    expect(titles(read)).toEqual(['a', 'b']);
  });

  it('refreshes once on 401 and sends the same page again', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    t.google.validToken = 'access-token-2';
    expect(await syncGoogleCalendar(t.deps(), t.scope)).toMatchObject({ kind: 'committed' });
    expect(t.refreshes).toEqual(['refresh-token-secret']);
    expect(t.google.listRequests.map((request) => request.headers.authorization)).toEqual([
      'Bearer access-token-1',
      'Bearer access-token-2',
    ]);
  });

  it('stops and drops the sync basis when the refresh says the grant is revoked', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    await syncGoogleCalendar(t.deps(), t.scope);
    t.google.validToken = 'access-token-2';
    t.setRefresh('revoked');
    const outcome = await syncGoogleCalendar(t.deps(), t.scope);
    expect(outcome).toEqual({ kind: 'stopped', reason: 'revoked' });
    expect(await t.read()).toMatchObject({ complete: false, events: [] });
    expect(JSON.stringify(outcome)).not.toMatch(/access-token|refresh-token/);
  });

  it('does not send without the read scope', async () => {
    const t = setup({ scopes: ['https://www.googleapis.com/auth/userinfo.email'] });
    expect(await syncGoogleCalendar(t.deps(), t.scope)).toEqual({
      kind: 'stopped',
      reason: 'catalog',
    });
    expect(t.google.listRequests).toHaveLength(0);
  });

  it('runs no queued read once the connection generation has changed', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    await t.deps().queue.enqueue({ kind: 'read', scope: t.scope, expectedGeneration: null });
    t.policy.decideDispatch(() => ({ ok: false, reason: 'connection-generation-changed' }));
    await t.runJobs();
    expect(t.queueBacking.jobs[0]).toMatchObject({
      status: 'abandoned',
      abandonedReason: 'connection-generation-changed',
    });
    expect(t.google.listRequests).toHaveLength(0);
  });

  it('publishes one generation when the same read job is delivered twice', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    t.google.put(CALENDAR, timed('b', 4));
    t.google.put(CALENDAR, timed('c', 5));
    await t.deps().queue.enqueue({ kind: 'read', scope: t.scope, expectedGeneration: null });
    await t.runJobs(2);
    expect(t.queueBacking.jobs[0]?.status).toBe('done');
    const read = await t.read();
    expect(titles(read)).toEqual(['a', 'b', 'c']);
    // 二つの配送はどちらも全ページを取ったが、公開されたのは一つの世代だけである。
    expect(t.google.listRequests).toHaveLength(4);
    const state = [...t.syncBacking.scopes.values()][0];
    expect(state?.published?.generation).toBe(1);
    expect(state?.staging.size).toBe(1);
  });

  it('turns a verified webhook signal into a re-read, never into the change itself', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    await syncGoogleCalendar(t.deps(), t.scope);
    const subscription = {
      subscription: 'channel-1',
      connection: t.connection,
      target: CALENDAR,
      secret: 'channel-token',
    };
    const intake = new MemoryWebhookIntake(createWebhookBacking([subscription]));

    t.google.put(CALENDAR, timed('b', 4));
    // 本文に何が書かれていても、変更内容としては使わない。
    const verified = await intake.verify(
      await fakeWebhook(subscription, '{"items":[{"id":"evil"}]}', 'message-1'),
    );
    if (!verified.ok) throw new Error('verify failed');
    const other = googleCalendarScope({
      connection: t.connection,
      calendarId: 'other',
      window: WINDOW,
    });
    expect(
      await enqueueReadsForSignal(t.deps().queue, t.deps().sync, verified.signal, [t.scope, other]),
    ).toBe(1);
    await t.runJobs();
    expect(titles(await t.read())).toEqual(['a', 'b']);
  });

  it('reports the part of a range outside the synced window as missing, not free', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 30));
    await syncGoogleCalendar(t.deps(), t.scope);
    const range = {
      from: Date.parse('2026-11-30T00:00:00Z'),
      to: Date.parse('2026-12-02T00:00:00Z'),
    };
    const read = await t.read(t.scope, range);
    expect(read.complete).toBe(false);
    expect(read.missing).toEqual([{ from: Date.parse(WINDOW.end), to: range.to }]);
    expect(titles(read)).toEqual(['a']);
  });

  it('returns nothing from the cache once the connection is no longer the current session', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    await syncGoogleCalendar(t.deps(), t.scope);
    t.policy.setConnections([{ ...t.connection, generation: 2 }]);
    expect(await t.read()).toMatchObject({ complete: false, events: [] });
  });

  it('places all-day events as dates and keeps provider text plain and bounded', async () => {
    const t = setup();
    t.google.put(CALENDAR, {
      id: 'holiday',
      summary: 'Off\u0000<b>day</b>',
      description: 'x'.repeat(2100),
      start: { date: '2026-11-03' },
      end: { date: '2026-11-04' },
    });
    await syncGoogleCalendar(t.deps(), t.scope);
    const [event] = (await t.read()).events;
    expect(event).toMatchObject({
      allDay: { startDate: '2026-11-03', endDate: '2026-11-04' },
      start: Date.parse('2026-11-03T00:00:00Z'),
      title: 'Off<b>day</b>',
    });
    expect([...(event?.notes ?? '')]).toHaveLength(2001);
  });

  it.each([
    ['Asia/Tokyo', '2026-11-03T10:00:00', '2026-11-03T01:00:00Z'],
    ['America/New_York', '2026-11-03T10:00:00', '2026-11-03T15:00:00Z'],
    ['America/New_York', '2026-10-31T10:00:00.250', '2026-10-31T14:00:00.250Z'],
  ])('reads an offset-free time in %s as wall-clock time there', async (timeZone, local, utc) => {
    const t = setup();
    const end = new Date(Date.parse(utc) + 3_600_000).toISOString();
    t.google.put(CALENDAR, {
      id: 'zoned',
      start: { dateTime: local, timeZone },
      end: { dateTime: end },
    });
    await syncGoogleCalendar(
      t.deps(),
      googleCalendarScope({
        connection: t.connection,
        calendarId: CALENDAR,
        window: { start: '2026-10-01T00:00:00Z', end: WINDOW.end },
      }),
    );
    const read = await t.read(
      googleCalendarScope({
        connection: t.connection,
        calendarId: CALENDAR,
        window: { start: '2026-10-01T00:00:00Z', end: WINDOW.end },
      }),
      { from: Date.parse('2026-10-01T00:00:00Z'), to: RANGE.to },
    );
    expect(read.events[0]?.start).toBe(Date.parse(utc));
  });

  it('does not guess the zone of an offset-free time without a known time zone', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    t.google.inject(
      json(200, {
        items: [
          {
            id: 'x',
            start: { dateTime: '2026-11-03T10:00:00', timeZone: 'Mars/Olympus' },
            end: { dateTime: '2026-11-03T11:00:00Z' },
          },
        ],
        nextSyncToken: 'sync-9',
      }),
    );
    expect(await syncGoogleCalendar(t.deps(), t.scope)).toEqual({
      kind: 'failed',
      reason: 'malformed-response',
    });
  });

  it('stops on a response it cannot read instead of publishing part of it', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    await syncGoogleCalendar(t.deps(), t.scope);
    const published = await t.read();
    t.google.put(CALENDAR, timed('b', 4));
    t.google.inject(json(200, { items: [{ id: 'b', start: 'tomorrow' }], nextSyncToken: 'x' }));
    expect(await syncGoogleCalendar(t.deps(), t.scope)).toEqual({
      kind: 'failed',
      reason: 'malformed-response',
    });
    expect(await t.read()).toEqual(published);
  });

  it('does not commit when the page limit is reached', async () => {
    const t = setup();
    for (let day = 1; day <= 5; day += 1) t.google.put(CALENDAR, timed(`e${day}`, day));
    expect(await syncGoogleCalendar({ ...t.deps(), maxPages: 2 }, t.scope)).toEqual({
      kind: 'incomplete',
      reason: 'page-limit',
    });
    expect(await t.read()).toMatchObject({ complete: false });
  });

  it('binds the sync basis to the window: another window starts from a full read', async () => {
    const t = setup();
    t.google.put(CALENDAR, timed('a', 3));
    await syncGoogleCalendar(t.deps(), t.scope);
    const december = googleCalendarScope({
      connection: t.connection,
      calendarId: CALENDAR,
      window: { start: '2026-12-01T00:00:00Z', end: '2027-01-01T00:00:00Z' },
    });
    expect(await syncGoogleCalendar(t.deps(), december)).toMatchObject({ mode: 'full' });
  });
});

describe('Google Calendar catalog', () => {
  const base = `https://www.googleapis.com/calendar/v3/calendars/primary/events`;
  const check = (url: string, method: 'GET' | 'DELETE' = 'GET') =>
    checkCatalogRequest({
      catalog: GOOGLE_CALENDAR_CATALOG,
      request: { operation: EVENTS_LIST, method, url },
      auth: 'token',
      grantedScopes: [GOOGLE_CALENDAR_EVENTS_READ_SCOPE],
    });

  it.each([
    ['a full read', `${base}?timeMin=a&timeMax=b&singleEvents=true&maxResults=250`, true],
    ['a delta read', `${base}?syncToken=s&pageToken=p&singleEvents=true`, true],
    ['a free-text query', `${base}?q=secret`, false],
    [
      'another calendar path',
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      false,
    ],
    ['another origin', 'https://evil.example/calendar/v3/calendars/primary/events', false],
    ['a path traversal', 'https://www.googleapis.com/calendar/v3/calendars/%2E%2E/events', false],
  ])('%s', async (_label, url, ok) => {
    expect((await check(url)).ok).toBe(ok);
  });

  it('has no write operation', async () => {
    expect(
      GOOGLE_CALENDAR_CATALOG.operations.every((operation) => operation.method === 'GET'),
    ).toBe(true);
    expect((await check(base, 'DELETE')).ok).toBe(false);
  });
});
