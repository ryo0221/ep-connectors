import type {
  Clock,
  HttpRequest,
  HttpResponse,
  JobHandler,
  PublishedSync,
  SendError,
  SendResult,
  SyncScope,
  SyncStateStore,
  TokenStore,
} from '@ep-connectors/core';
import { GITHUB_API, OPERATIONS } from './catalog.js';
import { REPOSITORY_ISSUES, REPOSITORY_PULL_REQUESTS } from './documents.js';
import type { GithubWorkItem, WorkItemsCursor } from './dto.js';
import {
  decodeCursor,
  encodeCursor,
  MalformedResponse,
  parseWorkItemsPage,
  workItemsRepository,
} from './dto.js';

export interface GithubReadDeps {
  tokens: TokenStore;
  sync: SyncStateStore;
  clock: Clock;
  options?: GithubReadOptions;
}

export interface GithubReadOptions {
  /** GraphQL の一ページの件数（上限 100）。 */
  pageSize?: number;
  /** 全件の照合の間隔。差分の読取では見えない削除・移動・他の repository への transfer を拾う。 */
  fullReconcileIntervalMs?: number;
  /** Rate limit 以外の一時障害の後に待つ時間。 */
  retryDelayMs?: number;
  /**
   * 合図による再取得で、合図の時刻からどれだけ遡って読むか。GitHub と Host の時計のずれと、更新から
   * 配送までの遅れを見込む。
   */
  signalLookbackMs?: number;
}

const DEFAULTS = {
  pageSize: 50,
  fullReconcileIntervalMs: 6 * 60 * 60 * 1000,
  retryDelayMs: 60 * 1000,
  signalLookbackMs: 5 * 60 * 1000,
};

export type SyncOutcome =
  /** ETag の照会が 304。何も公開しない。 */
  | { kind: 'unchanged'; generation: number }
  | { kind: 'published'; generation: number; mode: 'full' | 'delta'; fetched: number }
  /** 別の worker が先に公開した。こちらの staging は公開しない。 */
  | { kind: 'superseded'; current: number | null }
  /** 全ページを取れなかった。公開済みの写しは残し、空や削除として扱わない。 */
  | { kind: 'incomplete'; reason: 'rate-limited' | 'transport' | 'server'; notBefore: string }
  | {
      kind: 'unavailable';
      reason: 'policy' | 'revoked' | 'catalog' | 'not-found' | 'malformed' | 'not-a-github-scope';
    };

type Mode = { kind: 'full' } | { kind: 'delta'; base: PublishedSync; cursor: WorkItemsCursor };

/**
 * Repository の Issue / Pull Request の一覧を一回同期する。呼出しの間に状態を持ち越さず、基点は
 * `SyncStateStore` の公開の印から読む。
 *
 * 1. 全件の照合の時期でなければ、REST の ETag で変化を照会する。304 なら何もしない。照会が見るのは
 *    更新の新しい順の先頭一件の表現だけで、repository 全体の変化の保証ではない。そのため Webhook の
 *    合図（`requestedAt`）による再取得では照会を省く。
 * 2. 変化があれば、更新の新しい順に GraphQL で読み、基点（`watermark`）より古い item で止める。
 *    合図による再取得では、合図の時刻から `signalLookbackMs` 遡った時刻まで読む。
 *    全件の照合では baseline から作り直す。
 * 3. 全ページを適用してから、cache と基点を世代の CAS で一体に公開する。
 */
export async function syncWorkItems(
  deps: GithubReadDeps,
  scope: SyncScope,
  request: { full?: boolean; requestedAt?: string } = {},
): Promise<SyncOutcome> {
  const options = { ...DEFAULTS, ...deps.options };
  const repositoryId = workItemsRepository(scope);
  if (!repositoryId) return { kind: 'unavailable', reason: 'not-a-github-scope' };

  const published = await deps.sync.read(scope);
  const cursor = decodeCursor(published?.cursor ?? null);
  const now = deps.clock.now();
  const due =
    !cursor ||
    Date.parse(now) - Date.parse(cursor.fullReconciledAt) >= options.fullReconcileIntervalMs;

  let mode: Mode = { kind: 'full' };
  let etag: string | null = null;
  const requestedAt = request.requestedAt ? Date.parse(request.requestedAt) : NaN;
  if (published && cursor && !due && !request.full && !Number.isNaN(requestedAt)) {
    mode = { kind: 'delta', base: published, cursor };
    etag = cursor.etag;
  } else if (published && cursor && !due && !request.full) {
    // 照会は取得の前に行う。取得の途中の変化は次の照会で ETag の違いとして現れる。
    const probe = await probeChanges(deps, scope, cursor, options.retryDelayMs);
    if (probe.kind === 'unchanged') return { kind: 'unchanged', generation: published.generation };
    if (probe.kind === 'outcome') return probe.outcome;
    if (probe.kind === 'changed') {
      mode = { kind: 'delta', base: published, cursor };
      etag = probe.etag;
    }
    // `moved`（rename・transfer、名前の認可が合わない）は node ID で全件を読み直す。
  }

  const staged = await deps.sync.stage(scope, mode.kind === 'delta' ? mode.base.generation : null);
  if (!staged.ok)
    return { kind: 'superseded', current: (await deps.sync.read(scope))?.generation ?? null };

  const watermark = mode.kind === 'delta' ? mode.cursor.watermark : null;
  // 読取を止める時刻。合図による再取得では、先頭以外の item の変化も拾えるよう合図の時刻から遡る。
  const stopBefore =
    watermark === null
      ? null
      : Number.isNaN(requestedAt)
        ? Date.parse(watermark)
        : Math.min(Date.parse(watermark), requestedAt - options.signalLookbackMs);
  let repository = cursor?.repository ?? { id: repositoryId, nameWithOwner: '' };
  let newest = watermark;
  let scanStart: number | null = null;
  let fetched = 0;

  for (const kind of ['issue', 'pullRequest'] as const) {
    let after: string | null = null;
    for (;;) {
      const page = await fetchPage(deps, scope, repositoryId, kind, after, options);
      if (page.kind === 'outcome') {
        if (page.outcome.kind === 'unavailable' && page.outcome.reason === 'not-found') {
          // 読めなくなった repository の写しを表示し続けない（設計 2.1）。
          await deps.sync.invalidate(scope);
        }
        return page.outcome;
      }
      repository = page.repository;
      // 走査の始まりの時刻（GitHub の Date header、なければ Clock）。走査の途中で更新された item は
      // 読んだページの先頭へ移って読み落とすことがあるため、基点をこの時刻より先へ進めない。
      scanStart ??= page.serverTime ?? Date.parse(now);
      let reachedBase = false;
      const upserts = [];
      for (const item of page.items) {
        if (stopBefore !== null && Date.parse(item.updatedAt) < stopBefore) {
          reachedBase = true;
          break;
        }
        fetched += 1;
        if (newest === null || Date.parse(item.updatedAt) > Date.parse(newest)) {
          newest = item.updatedAt;
        }
        upserts.push({ id: item.id, value: item });
      }
      const applied = await deps.sync.applyPage(scope, staged.stagedGeneration, {
        upserts,
        removals: [],
      });
      if (!applied.ok) return { kind: 'superseded', current: null };
      if (reachedBase || !page.hasNextPage) break;
      after = page.endCursor;
    }
  }

  const next: WorkItemsCursor = {
    version: 1,
    repository,
    etag,
    watermark:
      newest !== null && scanStart !== null && Date.parse(newest) > scanStart
        ? new Date(scanStart).toISOString()
        : newest,
    fullReconciledAt: mode.kind === 'full' ? now : mode.cursor.fullReconciledAt,
    fetchedAt: now,
  };
  const committed = await deps.sync.commit(
    scope,
    published?.generation ?? null,
    staged.stagedGeneration,
    encodeCursor(next),
  );
  if (!committed.ok) return { kind: 'superseded', current: committed.current };
  return { kind: 'published', generation: committed.generation, mode: mode.kind, fetched };
}

type Probe =
  | { kind: 'unchanged' }
  | { kind: 'changed'; etag: string | null }
  | { kind: 'moved' }
  | { kind: 'outcome'; outcome: SyncOutcome };

async function probeChanges(
  deps: GithubReadDeps,
  scope: SyncScope,
  cursor: WorkItemsCursor,
  retryDelayMs: number,
): Promise<Probe> {
  const [owner, name] = cursor.repository.nameWithOwner.split('/');
  if (!owner || !name) return { kind: 'moved' };
  const url = new URL(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`,
  );
  url.search = new URLSearchParams({
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: '1',
  }).toString();
  const result = await sendRefreshing(deps, scope, {
    operation: OPERATIONS.probe,
    method: 'GET',
    url: url.href,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(cursor.etag ? { 'if-none-match': cursor.etag } : {}),
    },
  });
  if (!result.ok) {
    // 名前での認可は rename の後に Host の対応表と合わなくなる。node ID での読取で確かめ直す。
    if (result.error.kind === 'policy') return { kind: 'moved' };
    return { kind: 'outcome', outcome: sendFailure(result.error, deps.clock, retryDelayMs) };
  }
  const response = result.response;
  if (response.status === 304) return { kind: 'unchanged' };
  if (response.status === 200) return { kind: 'changed', etag: response.headers.etag ?? null };
  // 403 も、権限を失ったのかを node ID での読取で確かめる。読めなければそこで写しを無効にする。
  if ([301, 302, 307, 308, 404, 410].includes(response.status)) return { kind: 'moved' };
  if (response.status === 403 && !rateLimitTime(response, deps.clock)) return { kind: 'moved' };
  return { kind: 'outcome', outcome: httpFailure(response, deps.clock, retryDelayMs) };
}

/**
 * 401 なら一度だけ refresh して送り直す。Installation token は短時間で失効するため、401 を失効と
 * 決めつけない。Refresh が `revoked` なら接続の失効、通信の失敗なら送信前の失敗として返す。
 */
async function sendRefreshing(
  deps: GithubReadDeps,
  scope: SyncScope,
  request: HttpRequest,
): Promise<SendResult> {
  const first = await deps.tokens.send(scope.connection, request);
  if (!first.ok || first.response.status !== 401) return first;
  const refreshed = await deps.tokens.refresh(scope.connection);
  if (!refreshed.ok) {
    return {
      ok: false,
      error:
        refreshed.reason === 'revoked'
          ? { kind: 'revoked' }
          : { kind: 'transport', phase: 'before-send' },
    };
  }
  return deps.tokens.send(scope.connection, request);
}

type Page =
  | {
      kind: 'page';
      repository: WorkItemsCursor['repository'];
      items: GithubWorkItem[];
      endCursor: string | null;
      hasNextPage: boolean;
      /** 応答の Date header の時刻（epoch ms）。 */
      serverTime: number | null;
    }
  | { kind: 'outcome'; outcome: SyncOutcome };

async function fetchPage(
  deps: GithubReadDeps,
  scope: SyncScope,
  repositoryId: string,
  kind: GithubWorkItem['kind'],
  after: string | null,
  options: typeof DEFAULTS,
): Promise<Page> {
  const issue = kind === 'issue';
  const result = await sendRefreshing(deps, scope, {
    operation: issue ? OPERATIONS.issues : OPERATIONS.pullRequests,
    method: 'POST',
    url: `${GITHUB_API}/graphql`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: issue ? REPOSITORY_ISSUES : REPOSITORY_PULL_REQUESTS,
      operationName: issue ? 'RepositoryIssues' : 'RepositoryPullRequests',
      variables: { repositoryId, first: Math.min(options.pageSize, 100), after },
    }),
  });
  const fail = (outcome: SyncOutcome): Page => ({ kind: 'outcome', outcome });
  if (!result.ok) return fail(sendFailure(result.error, deps.clock, options.retryDelayMs));
  const response = result.response;
  if (response.status !== 200) return fail(httpFailure(response, deps.clock, options.retryDelayMs));

  let body: { data?: unknown; errors?: { type?: unknown }[] };
  try {
    body = JSON.parse(response.body) as typeof body;
  } catch {
    return fail({ kind: 'unavailable', reason: 'malformed' });
  }
  const errorTypes = (Array.isArray(body.errors) ? body.errors : []).map((error) => error?.type);
  if (errorTypes.includes('RATE_LIMITED')) {
    return fail({
      kind: 'incomplete',
      reason: 'rate-limited',
      notBefore: rateLimitTime(response, deps.clock) ?? later(deps.clock, options.retryDelayMs),
    });
  }
  if (errorTypes.includes('NOT_FOUND') || errorTypes.includes('FORBIDDEN')) {
    return fail({ kind: 'unavailable', reason: 'not-found' });
  }
  if (errorTypes.length > 0) {
    // 部分的な data は全ページの一部として扱わない。
    return fail({
      kind: 'incomplete',
      reason: 'server',
      notBefore: later(deps.clock, options.retryDelayMs),
    });
  }
  try {
    const page = parseWorkItemsPage(kind, body.data);
    if (!page) return fail({ kind: 'unavailable', reason: 'not-found' });
    if (page.repository.id !== repositoryId)
      return fail({ kind: 'unavailable', reason: 'malformed' });
    const date = Date.parse(response.headers.date ?? '');
    return { kind: 'page', ...page, serverTime: Number.isNaN(date) ? null : date };
  } catch (error) {
    if (error instanceof MalformedResponse)
      return fail({ kind: 'unavailable', reason: 'malformed' });
    throw error;
  }
}

function sendFailure(error: SendError, clock: Clock, retryDelayMs: number): SyncOutcome {
  switch (error.kind) {
    case 'policy':
      return { kind: 'unavailable', reason: 'policy' };
    case 'catalog':
      return { kind: 'unavailable', reason: 'catalog' };
    case 'revoked':
      return { kind: 'unavailable', reason: 'revoked' };
    case 'transport':
      // 読取なので、送信後に応答がなくても取り直してよい。
      return { kind: 'incomplete', reason: 'transport', notBefore: later(clock, retryDelayMs) };
  }
}

function httpFailure(response: HttpResponse, clock: Clock, retryDelayMs: number): SyncOutcome {
  const limited = rateLimitTime(response, clock);
  if (limited) return { kind: 'incomplete', reason: 'rate-limited', notBefore: limited };
  if (response.status === 401) return { kind: 'unavailable', reason: 'revoked' };
  if (response.status === 403 || response.status === 404) {
    return { kind: 'unavailable', reason: 'not-found' };
  }
  return { kind: 'incomplete', reason: 'server', notBefore: later(clock, retryDelayMs) };
}

/**
 * Rate limit の待機の終わり。`Retry-After`（秒）を優先し、残量が 0 なら `x-ratelimit-reset`
 * （epoch 秒）まで待つ。どちらもない secondary rate limit は 1 分待つ。Rate limit でなければ `null`。
 */
function rateLimitTime(response: HttpResponse, clock: Clock): string | null {
  const retryAfter = response.headers['retry-after'];
  const remaining = response.headers['x-ratelimit-remaining'];
  const reset = response.headers['x-ratelimit-reset'];
  const limited =
    response.status === 429 ||
    ((response.status === 403 || response.status === 200) &&
      (retryAfter !== undefined || remaining === '0')) ||
    (response.status === 403 && /rate limit/i.test(response.body));
  if (!limited) return null;
  const now = Date.parse(clock.now());
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter)) {
    return new Date(now + Number(retryAfter) * 1000).toISOString();
  }
  if (reset !== undefined && /^\d+$/.test(reset)) {
    return new Date(Math.max(now, Number(reset) * 1000)).toISOString();
  }
  return new Date(now + 60 * 1000).toISOString();
}

function later(clock: Clock, milliseconds: number): string {
  return new Date(Date.parse(clock.now()) + milliseconds).toISOString();
}

/**
 * `read` job の処理。Host のキューは実行の直前に `authorizeDispatch` で repository の閲覧の認可を
 * 確かめてから呼ぶ。同じ job が二重に配送されても、公開されるのは CAS に勝った一つの世代だけである。
 * CAS に負けた job は捨てずに retry にし、勝った世代を基に照会し直す。
 */
export function createGithubReadHandler(deps: GithubReadDeps): JobHandler {
  return async (job) => {
    if (job.kind !== 'read') return { kind: 'abandoned', reason: 'not-a-read-job' };
    const outcome = await syncWorkItems(
      deps,
      job.scope,
      job.requestedAt === undefined ? {} : { requestedAt: job.requestedAt },
    );
    switch (outcome.kind) {
      case 'unchanged':
      case 'published':
        return { kind: 'done' };
      case 'superseded':
        // 先に公開した世代が、この job の取得より新しいとは限らない。公開された世代を基に読み直す。
        return { kind: 'retry', notBefore: deps.clock.now() };
      case 'incomplete':
        return { kind: 'retry', notBefore: outcome.notBefore };
      case 'unavailable':
        return { kind: 'abandoned', reason: outcome.reason };
    }
  };
}
