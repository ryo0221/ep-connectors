import type {
  Clock,
  ConnectionKey,
  HttpRequest,
  HttpResponse,
  JobHandler,
  JobQueue,
  JobRef,
  PolicyDenial,
  SendError,
  SyncScope,
  SyncStateStore,
  TokenStore,
  WebhookSignal,
} from '@ep-connectors/core';
import { canonicalJson, sameConnectionGeneration } from '@ep-connectors/core';
import { EVENTS_LIST, GOOGLE_API_ORIGIN, GOOGLE_PROVIDER } from './catalog.js';
import { parseEventsPage } from './events.js';

/** 一つの calendar を固定した期間で読む同期の対象。 */
export interface GoogleCalendarSource {
  connection: ConnectionKey;
  calendarId: string;
  /** ISO 8601。Google の `timeMin`（含む）と `timeMax`（含まない）に当たる。 */
  window: { start: string; end: string };
}

/**
 * 取得条件。差分の取得では初回と同じ条件で送る必要があるため（`syncToken` と一緒に送れない
 * `timeMin` / `timeMax` を除く）、版を含めて scope に束縛し、条件を変えたら別の基点にする。
 */
export const GOOGLE_EVENTS_QUERY = {
  api: 'calendar/v3',
  operation: EVENTS_LIST,
  singleEvents: true,
  maxResults: 250,
  version: 1,
} as const;

export function googleCalendarScope(source: GoogleCalendarSource): SyncScope {
  return {
    connection: source.connection,
    target: source.calendarId,
    query: { ...GOOGLE_EVENTS_QUERY },
    window: { ...source.window },
  };
}

export function isGoogleCalendarScope(scope: SyncScope): boolean {
  return (
    scope.connection.provider === GOOGLE_PROVIDER &&
    scope.window !== undefined &&
    canonicalJson(scope.query) === canonicalJson({ ...GOOGLE_EVENTS_QUERY })
  );
}

/**
 * `SyncStateStore` へ保管する基点。`syncToken` と、その基点を取った時刻を一つの記録にする。
 * Store にとっては不透明な文字列である。
 */
interface GoogleSyncBasis {
  v: 1;
  syncToken: string;
  /** 最初のページを送る直前の時刻。公開した内容は、少なくともこの時刻までの変更を含む。 */
  fetchedAt: string;
}

export function parseSyncBasis(cursor: string | null): GoogleSyncBasis | null {
  if (cursor === null) return null;
  try {
    const value: unknown = JSON.parse(cursor);
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as GoogleSyncBasis).v === 1 &&
      typeof (value as GoogleSyncBasis).syncToken === 'string' &&
      typeof (value as GoogleSyncBasis).fetchedAt === 'string'
    ) {
      return value as GoogleSyncBasis;
    }
  } catch {
    // 読めない基点は、ないものとして作り直す。
  }
  return null;
}

export interface GoogleCalendarReadDeps {
  tokens: TokenStore;
  sync: SyncStateStore;
  clock: Clock;
  /** 一回の同期で辿るページの上限。超えたら公開せずに `incomplete` で終える。 */
  maxPages?: number;
  /** Provider が待機を指示しなかった一時的な失敗の後に待つ時間。 */
  retryDelayMs?: number;
}

export type GoogleSyncOutcome =
  /** 全ページを適用し、cache と基点を一体で公開した。 */
  | { kind: 'committed'; generation: number; mode: 'full' | 'incremental'; pages: number }
  /** 別の worker が先に公開した。こちらの staging は公開しない。 */
  | { kind: 'superseded' }
  /** 一時的な失敗（rate limit、5xx、通信）。公開済みの世代はそのまま。`notBefore` 以降に再取得する。 */
  | { kind: 'deferred'; notBefore: string; reason: 'rate-limit' | 'server' | 'transport' }
  /** ページの上限に達した。公開しない。 */
  | { kind: 'incomplete'; reason: 'page-limit' }
  /** 接続が失効した、または Host が送信を許可しなかった。再取得しない。 */
  | { kind: 'stopped'; reason: 'revoked' | PolicyDenial | 'catalog' }
  /** 応答の形が合わない、想定しない status。再取得しても直らないため止める。 */
  | { kind: 'failed'; reason: 'malformed-response' | 'unexpected-status'; status?: number };

const DEFAULT_MAX_PAGES = 100;
const DEFAULT_RETRY_DELAY_MS = 60_000;

/**
 * Google Calendar の `events.list` で一つの calendar を同期する。基点がなければ期間を指定した
 * 全件の取得、あれば `syncToken` からの差分の取得を行い、全ページを新しい世代の staging へ
 * 適用してから、cache と次の基点を `commit` で一体に公開する（全体設計 3.6、Schedule 設計 5）。
 *
 * - 410 は基点の失効であり、その scope の cache と基点だけを無効にして全件を取り直す。台帳・
 *   未解決の operation・Host の binding には触れない。
 * - 401 は一度だけ `refresh` してから同じページを送り直す。
 * - Rate limit と一時障害では送り直さずに `deferred` を返す。Retry は `JobQueue` だけで行う。
 */
export async function syncGoogleCalendar(
  deps: GoogleCalendarReadDeps,
  scope: SyncScope,
): Promise<GoogleSyncOutcome> {
  const first = await syncOnce(deps, scope);
  if (first.kind !== 'gone') return first;
  // 410 を受けた基点がまだ公開されているときだけ無効にする。別の worker が先に作り直して
  // 公開した世代を消さない。
  if (!(await invalidateIfPublished(deps.sync, scope, first.generation))) {
    return { kind: 'superseded' };
  }
  const rebuilt = await syncOnce(deps, scope);
  // 作り直しの全件取得でも 410 なら、想定しない応答として止める。
  return rebuilt.kind === 'gone'
    ? { kind: 'failed', reason: 'unexpected-status', status: 410 }
    : rebuilt;
}

async function syncOnce(
  deps: GoogleCalendarReadDeps,
  scope: SyncScope,
): Promise<GoogleSyncOutcome | { kind: 'gone'; generation: number }> {
  const window = scope.window;
  if (!window) throw new TypeError('A Google Calendar scope needs a fixed window.');
  const published = await deps.sync.read(scope);
  let basis = parseSyncBasis(published?.cursor ?? null);
  let expected = published?.generation ?? null;
  if (published && !basis) {
    // 読めない基点の上に差分を重ねない。
    if (!(await invalidateIfPublished(deps.sync, scope, published.generation))) {
      return { kind: 'superseded' };
    }
    expected = null;
    basis = null;
  }
  const mode = basis ? 'incremental' : 'full';
  const startedAt = deps.clock.now();
  const staged = await deps.sync.stage(scope, expected);
  if (!staged.ok) return { kind: 'superseded' };

  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  let pageToken: string | undefined;
  for (let pages = 1; ; pages += 1) {
    const request = eventsListRequest(scope.target, window, basis?.syncToken, pageToken);
    const sent = await sendWithRefresh(deps.tokens, scope.connection, request);
    if (!sent.ok) return fromSendError(deps, sent.error);
    const { response } = sent;
    if (response.status === 410 && expected !== null) return { kind: 'gone', generation: expected };
    if (response.status !== 200) return fromStatus(deps, response);

    const page = parseEventsPage(response.body, window);
    if (!page.ok) return { kind: 'failed', reason: 'malformed-response' };
    const applied = await deps.sync.applyPage(scope, staged.stagedGeneration, page.items);
    if (!applied.ok) return { kind: 'superseded' };

    if (page.nextPageToken !== undefined) {
      if (pages >= maxPages) return { kind: 'incomplete', reason: 'page-limit' };
      pageToken = page.nextPageToken;
      continue;
    }
    if (page.nextSyncToken === undefined) return { kind: 'failed', reason: 'malformed-response' };
    const next: GoogleSyncBasis = {
      v: 1,
      syncToken: page.nextSyncToken,
      fetchedAt: startedAt,
    };
    const committed = await deps.sync.commit(
      scope,
      expected,
      staged.stagedGeneration,
      JSON.stringify(next),
    );
    if (!committed.ok) return { kind: 'superseded' };
    return { kind: 'committed', generation: committed.generation, mode, pages };
  }
}

/**
 * 公開済みの世代が `generation` のままなら scope を無効にする。Core の `invalidate` は世代を
 * 取らないため、読んでから無効にするまでの間に別の worker が公開した場合は防げない。その間は
 * 短く、失っても次の同期で作り直せる cache だけである。
 */
async function invalidateIfPublished(
  sync: SyncStateStore,
  scope: SyncScope,
  generation: number,
): Promise<boolean> {
  if ((await sync.read(scope))?.generation !== generation) return false;
  await sync.invalidate(scope);
  return true;
}

function eventsListRequest(
  calendarId: string,
  window: { start: string; end: string },
  syncToken: string | undefined,
  pageToken: string | undefined,
): HttpRequest {
  const url = new URL(
    `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    GOOGLE_API_ORIGIN,
  );
  if (syncToken === undefined) {
    url.searchParams.set('timeMin', window.start);
    url.searchParams.set('timeMax', window.end);
  } else {
    url.searchParams.set('syncToken', syncToken);
  }
  url.searchParams.set('singleEvents', String(GOOGLE_EVENTS_QUERY.singleEvents));
  url.searchParams.set('maxResults', String(GOOGLE_EVENTS_QUERY.maxResults));
  if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
  return { operation: EVENTS_LIST, method: 'GET', url: url.toString() };
}

type Sent = { ok: true; response: HttpResponse } | { ok: false; error: SendError };

async function sendWithRefresh(
  tokens: TokenStore,
  key: ConnectionKey,
  request: HttpRequest,
): Promise<Sent> {
  const sent = await tokens.send(key, request);
  if (!sent.ok || sent.response.status !== 401) return sent;
  const refreshed = await tokens.refresh(key);
  if (!refreshed.ok) {
    return refreshed.reason === 'revoked'
      ? { ok: false, error: { kind: 'revoked' } }
      : { ok: false, error: { kind: 'transport', phase: 'before-send' } };
  }
  return tokens.send(key, request);
}

function fromSendError(deps: GoogleCalendarReadDeps, error: SendError): GoogleSyncOutcome {
  switch (error.kind) {
    case 'revoked':
      return { kind: 'stopped', reason: 'revoked' };
    case 'policy':
      return { kind: 'stopped', reason: error.reason };
    case 'catalog':
      return { kind: 'stopped', reason: 'catalog' };
    case 'transport':
      return { kind: 'deferred', notBefore: later(deps, null), reason: 'transport' };
  }
}

function fromStatus(deps: GoogleCalendarReadDeps, response: HttpResponse): GoogleSyncOutcome {
  if (response.status === 401) return { kind: 'stopped', reason: 'revoked' };
  if (response.status === 429 || (response.status === 403 && isRateLimit(response.body))) {
    return {
      kind: 'deferred',
      notBefore: later(deps, response.headers['retry-after'] ?? null),
      reason: 'rate-limit',
    };
  }
  if (response.status >= 500) {
    return {
      kind: 'deferred',
      notBefore: later(deps, response.headers['retry-after'] ?? null),
      reason: 'server',
    };
  }
  return { kind: 'failed', reason: 'unexpected-status', status: response.status };
}

/** Google の 403 のうち、利用量の制限によるもの（`rateLimitExceeded`、`userRateLimitExceeded`）。 */
function isRateLimit(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { errors?: { reason?: unknown }[] } };
    return (parsed.error?.errors ?? []).some(
      (error) => error.reason === 'rateLimitExceeded' || error.reason === 'userRateLimitExceeded',
    );
  } catch {
    return false;
  }
}

/** `Retry-After`（秒か HTTP 日付）があれば従い、なければ既定の時間だけ待つ。 */
function later(deps: GoogleCalendarReadDeps, retryAfter: string | null): string {
  const now = Date.parse(deps.clock.now());
  const fallback = now + (deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  if (retryAfter === null) return new Date(fallback).toISOString();
  const trimmed = retryAfter.trim();
  if (/^\d+$/.test(trimmed)) return new Date(now + Number(trimmed) * 1000).toISOString();
  const date = Date.parse(trimmed);
  return new Date(Number.isNaN(date) ? fallback : Math.max(now, date)).toISOString();
}

/**
 * 呼出し元が今すぐ同期し、一時的な失敗なら `JobQueue` へ再取得を預ける。
 */
export async function syncGoogleCalendarNow(
  deps: GoogleCalendarReadDeps & { queue: JobQueue },
  scope: SyncScope,
): Promise<GoogleSyncOutcome> {
  const outcome = await syncGoogleCalendar(deps, scope);
  if (outcome.kind === 'deferred') {
    const published = await deps.sync.read(scope);
    await deps.queue.enqueue(readJob(scope, published?.generation ?? null, deps.clock.now()), {
      notBefore: outcome.notBefore,
    });
  }
  return outcome;
}

export function readJob(
  scope: SyncScope,
  expectedGeneration: number | null,
  requestedAt: string,
): JobRef {
  return { kind: 'read', scope, expectedGeneration, requestedAt };
}

/**
 * Host のキューが呼ぶ handler。Google Calendar の `read` job だけを扱う。Host は呼ぶ直前に
 * `HostPolicy.authorizeDispatch` で確かめる（`JobQueue` の契約）。同時に二度配送されても、世代の
 * CAS により公開されるのは一つだけである。`requestedAt` よりあとに始めた取得がすでに公開されて
 * いれば、遅れて届いた配送は取りに行かずに終える。
 */
export function googleCalendarReadJobHandler(deps: GoogleCalendarReadDeps): JobHandler {
  return async (job) => {
    if (job.kind !== 'read' || !isGoogleCalendarScope(job.scope)) {
      return { kind: 'abandoned', reason: 'not-a-google-calendar-read' };
    }
    if (
      job.requestedAt !== undefined &&
      (await coveredSince(deps.sync, job.scope, job.requestedAt))
    ) {
      return { kind: 'done' };
    }
    const outcome = await syncGoogleCalendar(deps, job.scope);
    switch (outcome.kind) {
      case 'committed':
        return { kind: 'done' };
      case 'superseded':
        // 先に公開した取得が、取り直しの要る時刻より前に始まっていたら、その変更を含まない。
        if (
          job.requestedAt !== undefined &&
          (await coveredSince(deps.sync, job.scope, job.requestedAt))
        ) {
          return { kind: 'done' };
        }
        return { kind: 'retry', notBefore: deps.clock.now() };
      case 'deferred':
        return { kind: 'retry', notBefore: outcome.notBefore };
      case 'incomplete':
      case 'stopped':
      case 'failed':
        return { kind: 'abandoned', reason: `${outcome.kind}:${outcome.reason}` };
    }
  };
}

/**
 * 公開済みの世代が `requestedAt` よりあとに始めた取得のものか。そうなら、その時点までの変更は
 * 公開済みであり、取り直さなくてよい。
 */
async function coveredSince(
  sync: SyncStateStore,
  scope: SyncScope,
  requestedAt: string,
): Promise<boolean> {
  const basis = parseSyncBasis((await sync.read(scope))?.cursor ?? null);
  if (!basis) return false;
  const fetched = Date.parse(basis.fetchedAt);
  const requested = Date.parse(requestedAt);
  // 同じ時刻は前後を決められないため、取り直す側に倒す。
  return !Number.isNaN(fetched) && !Number.isNaN(requested) && fetched > requested;
}

/**
 * Webhook の合図を受けて、合図の接続と対象に当たる scope の再取得を預ける。通知の本文は使わず、
 * 通知だけで同期を完了としない（全体設計 3.5）。
 */
export async function enqueueReadsForSignal(
  queue: JobQueue,
  sync: SyncStateStore,
  signal: WebhookSignal,
  watched: readonly SyncScope[],
  /** 通知を受けた時刻（`InboundWebhook.receivedAt`）。 */
  receivedAt: string,
): Promise<number> {
  let count = 0;
  for (const scope of watched) {
    if (!sameConnectionGeneration(scope.connection, signal.connection)) continue;
    if (scope.target !== signal.target) continue;
    const published = await sync.read(scope);
    await queue.enqueue(readJob(scope, published?.generation ?? null, receivedAt));
    count += 1;
  }
  return count;
}
