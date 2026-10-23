import type {
  Clock,
  ConnectionKey,
  HttpRequest,
  HttpResponse,
  JobHandler,
  JsonValue,
  OperationCapability,
  SendResult,
  SyncEntry,
  SyncScope,
  SyncStateStore,
  TokenStore,
} from '@ep-connectors/core';
import { canonicalJson } from '@ep-connectors/core';
import type { CellValue, TableRangeRead, ValueRender } from '../table-range.js';
import { GOOGLE_SHEETS_PROVIDER, SHEETS_ORIGIN } from './catalog.js';

/** 読む範囲の指定。`range` は A1 表記（例 `'Q1 予算'!A1:F200`）。 */
export interface SheetsRangeTarget {
  spreadsheetId: string;
  range: string;
  /** 既定は `unformatted`（数値・真偽値を型のまま、日付は serial number）。 */
  valueRender?: ValueRender;
}

export interface SheetsReadDeps {
  tokens: TokenStore;
  syncState: SyncStateStore;
  clock: Clock;
  /** 一回で読むセルの上限。越えたら公開せずに失敗する。既定 50,000。 */
  maxCells?: number;
  /** `applyPage` 一回に書く行数。既定 500。 */
  pageRows?: number;
  /** `Retry-After` がない 429・5xx・通信失敗の後に待つ秒数。既定 30。 */
  retryDelaySeconds?: number;
}

export type SheetsReadFailure =
  | 'invalid-target'
  | 'policy'
  | 'catalog'
  | 'revoked'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'invalid-range'
  | 'too-large'
  | 'malformed-response'
  | 'provider-error';

export type SheetsSyncResult =
  | { kind: 'published'; generation: number }
  /** 内容が公開済みの世代と同じで、新しい世代を作らなかった。 */
  | { kind: 'unchanged'; generation: number }
  /** 別の worker が先に新しい世代を公開した。 */
  | { kind: 'superseded' }
  | { kind: 'retry'; notBefore: string; reason: 'rate-limited' | 'unavailable' | 'transport' }
  | { kind: 'failed'; reason: SheetsReadFailure };

const TARGET_PREFIX = `${GOOGLE_SHEETS_PROVIDER}/spreadsheets/`;
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{1,200}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const META_ID = 'meta';
const ROW_PREFIX = 'row:';

/**
 * 範囲を `SyncStateStore` の scope にする。範囲と値の取り出し方を取得条件に含め、条件の違う
 * 写しを流用しない（全体設計 3.6）。不正な指定は送る前に `TypeError` で拒否する。
 */
export function sheetsRangeScope(connection: ConnectionKey, target: SheetsRangeTarget): SyncScope {
  if (connection.provider !== GOOGLE_SHEETS_PROVIDER) {
    throw new TypeError('sheetsRangeScope: connection is not a Google Sheets connection');
  }
  if (!SPREADSHEET_ID.test(target.spreadsheetId)) {
    throw new TypeError('sheetsRangeScope: invalid spreadsheetId');
  }
  if (target.range.length === 0 || target.range.length > 500 || CONTROL.test(target.range)) {
    throw new TypeError('sheetsRangeScope: invalid range');
  }
  return {
    connection,
    target: `${TARGET_PREFIX}${target.spreadsheetId}`,
    query: { range: target.range, valueRender: target.valueRender ?? 'unformatted' },
  };
}

/** Scope から範囲の指定を読み戻す。この adapter の scope でなければ `null`。 */
export function parseSheetsScope(scope: SyncScope): Required<SheetsRangeTarget> | null {
  if (scope.connection.provider !== GOOGLE_SHEETS_PROVIDER) return null;
  if (!scope.target.startsWith(TARGET_PREFIX)) return null;
  const spreadsheetId = scope.target.slice(TARGET_PREFIX.length);
  const query = scope.query;
  if (!isRecord(query) || typeof query.range !== 'string') return null;
  if (query.valueRender !== 'unformatted' && query.valueRender !== 'formatted') return null;
  const target = { spreadsheetId, range: query.range, valueRender: query.valueRender } as const;
  try {
    sheetsRangeScope(scope.connection, target);
  } catch {
    return null;
  }
  return target;
}

export interface SheetsSyncOptions {
  /**
   * 公開済みの世代がこれのときだけ公開する（`read` job の `expectedGeneration`）。省略したら
   * 取得を始めた時点の公開済みの世代を使う。
   */
  expectedGeneration?: number | null;
}

/**
 * 範囲を取得し、内容が変わっていれば新しい世代として公開する（Data 接続の設計 3）。
 *
 * Sheets の値には差分の基点がないため、毎回範囲の全体を baseline として取り直し、全行を staging へ
 * 書いてから `commit` で公開する。基点（cursor）には内容の hash を置き、同じ内容なら世代を進めない。
 * 二つの worker が同時に走っても、公開済みの世代の CAS で公開は一つだけになる。
 */
export async function syncSheetsRange(
  deps: SheetsReadDeps,
  scope: SyncScope,
  options: SheetsSyncOptions = {},
): Promise<SheetsSyncResult> {
  const target = parseSheetsScope(scope);
  if (!target) return { kind: 'failed', reason: 'invalid-target' };
  const published = await deps.syncState.read(scope);
  const current = published?.generation ?? null;
  const expected = options.expectedGeneration === undefined ? current : options.expectedGeneration;
  // 期待した世代より後の世代が公開済みなら、この取得は別の取得に追い越されている。
  if (current !== expected) return { kind: 'superseded' };

  // 公開済みの世代がないときは、送る前に staging を作っておく。送信中に `revoke` で接続の写しが
  // 無効になると staging も消え、取得した値を公開できなくなる。公開済みの世代があるときは、
  // 無効化で `commit` の世代の CAS が通らなくなる。
  let staged = expected === null ? await deps.syncState.stage(scope, null) : null;

  const sent = await sendWithRefresh(deps, scope.connection, buildRequest(target));
  if (sent.kind !== 'response') return sent.result;
  const response = sent.response;

  if (response.status === 403 || response.status === 404) {
    // 読めなくなった表の写しを本人向けにも残さない。
    await deps.syncState.invalidate(scope);
    return { kind: 'failed', reason: response.status === 403 ? 'forbidden' : 'not-found' };
  }
  if (response.status === 400) return { kind: 'failed', reason: 'invalid-range' };
  if (response.status === 429) return retry(deps, response, 'rate-limited');
  if (response.status >= 500) return retry(deps, response, 'unavailable');
  if (response.status !== 200) return { kind: 'failed', reason: 'provider-error' };

  const parsed = parseValues(response.body, target.spreadsheetId, deps.maxCells ?? 50_000);
  if (!parsed.ok) return { kind: 'failed', reason: parsed.reason };
  const contentHash = await hashContent(parsed.resolvedRange, parsed.rows);
  if (published && published.cursor === contentHash) {
    return { kind: 'unchanged', generation: published.generation };
  }

  staged ??= await deps.syncState.stage(scope, null);
  if (!staged.ok) return { kind: 'superseded' };
  const meta: JsonValue = {
    provider: GOOGLE_SHEETS_PROVIDER,
    container: target.spreadsheetId,
    requestedRange: target.range,
    resolvedRange: parsed.resolvedRange,
    valueRender: target.valueRender,
    columnCount: parsed.columnCount,
    rowCount: parsed.rows.length,
    fetchedAt: deps.clock.now(),
    contentHash,
  };
  const entries: SyncEntry[] = [
    { id: META_ID, value: meta },
    ...parsed.rows.map((row, index) => ({ id: rowId(index), value: row })),
  ];
  const pageRows = Math.max(1, deps.pageRows ?? 500);
  for (let start = 0; start < entries.length; start += pageRows) {
    const page = await deps.syncState.applyPage(scope, staged.stagedGeneration, {
      upserts: entries.slice(start, start + pageRows),
      removals: [],
    });
    if (!page.ok) return retryAt(deps, 0, 'transport');
  }
  const committed = await deps.syncState.commit(
    scope,
    expected,
    staged.stagedGeneration,
    contentHash,
  );
  if (!committed.ok) {
    return committed.reason === 'generation-mismatch'
      ? { kind: 'superseded' }
      : retryAt(deps, 0, 'transport');
  }
  return { kind: 'published', generation: committed.generation };
}

/** 公開済みの世代から読取の DTO を組み立てる。まだ公開されていなければ `null`。 */
export async function readSheetsRange(
  syncState: SyncStateStore,
  scope: SyncScope,
): Promise<TableRangeRead | null> {
  const published = await syncState.read(scope);
  if (!published) return null;
  const meta = published.entries.find((entry) => entry.id === META_ID)?.value;
  if (!isMeta(meta)) return null;
  const rows: CellValue[][] = [];
  for (const entry of published.entries) {
    if (!entry.id.startsWith(ROW_PREFIX)) continue;
    const index = Number(entry.id.slice(ROW_PREFIX.length));
    if (!Number.isInteger(index) || !isRow(entry.value)) return null;
    rows[index] = entry.value;
  }
  // 公開は一体で行われるため欠けはないはずだが、欠けた写しを完全なものとして返さない。
  if (rows.length !== meta.rowCount || rows.some((row) => row === undefined)) return null;
  return {
    source: {
      provider: meta.provider,
      container: meta.container,
      requestedRange: meta.requestedRange,
      resolvedRange: meta.resolvedRange,
    },
    valueRender: meta.valueRender,
    rows,
    columnCount: meta.columnCount,
    generation: published.generation,
    fetchedAt: meta.fetchedAt,
    contentHash: meta.contentHash,
  };
}

/**
 * `read` job の handler（全体設計 3.4）。Host のキューは実行の直前に `authorizeDispatch` を済ませて
 * から呼ぶ。この adapter の scope でない job は実行しない。
 */
export function sheetsReadJobHandler(deps: SheetsReadDeps): JobHandler {
  return async (job) => {
    if (job.kind !== 'read' || !parseSheetsScope(job.scope)) {
      return { kind: 'abandoned', reason: 'unsupported-job' };
    }
    const result = await syncSheetsRange(deps, job.scope, {
      expectedGeneration: job.expectedGeneration,
    });
    switch (result.kind) {
      case 'published':
      case 'unchanged':
      case 'superseded':
        return { kind: 'done' };
      case 'retry':
        return { kind: 'retry', notBefore: result.notBefore };
      case 'failed':
        return { kind: 'abandoned', reason: result.reason };
    }
  };
}

/**
 * 能力の宣言（全体設計 4）。実接続の試験（R2）で確かめるまで `unverified` とする。
 * 書込みは R1 では持たない。
 */
export function googleSheetsCapabilities(): OperationCapability[] {
  return [
    { operation: 'data.range.read', status: { available: false, reason: 'unverified' } },
    {
      operation: 'data.range.write',
      status: { available: false, reason: 'unsupported-by-provider' },
    },
  ];
}

function buildRequest(target: Required<SheetsRangeTarget>): HttpRequest {
  const url = new URL(
    `${SHEETS_ORIGIN}/v4/spreadsheets/${encodeURIComponent(target.spreadsheetId)}/values:batchGet`,
  );
  url.searchParams.append('ranges', target.range);
  url.searchParams.set('majorDimension', 'ROWS');
  if (target.valueRender === 'formatted') {
    url.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');
  } else {
    url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
    url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');
  }
  return { operation: 'sheets.values.batchGet', method: 'GET', url: url.toString() };
}

type Sent =
  | { kind: 'response'; response: HttpResponse }
  | { kind: 'done'; result: SheetsSyncResult };

/** 401 なら一度だけ refresh して送り直す。Token は Host の中に留まる。 */
async function sendWithRefresh(
  deps: SheetsReadDeps,
  key: ConnectionKey,
  request: HttpRequest,
): Promise<Sent> {
  let result = await deps.tokens.send(key, request);
  if (result.ok && result.response.status === 401) {
    const refreshed = await deps.tokens.refresh(key);
    if (!refreshed.ok) {
      if (refreshed.reason === 'transport')
        return { kind: 'done', result: retryAt(deps, null, 'transport') };
      return {
        kind: 'done',
        result: { kind: 'failed', reason: refreshed.reason === 'revoked' ? 'revoked' : 'policy' },
      };
    }
    result = await deps.tokens.send(key, request);
    if (result.ok && result.response.status === 401) {
      return { kind: 'done', result: { kind: 'failed', reason: 'unauthorized' } };
    }
  }
  return fromSend(deps, result);
}

function fromSend(deps: SheetsReadDeps, result: SendResult): Sent {
  if (result.ok) return { kind: 'response', response: result.response };
  switch (result.error.kind) {
    case 'policy':
      return { kind: 'done', result: { kind: 'failed', reason: 'policy' } };
    case 'catalog':
      return { kind: 'done', result: { kind: 'failed', reason: 'catalog' } };
    case 'revoked':
      return { kind: 'done', result: { kind: 'failed', reason: 'revoked' } };
    case 'transport':
      // 読取は外部に結果を残さないため、送信後の失敗でも取り直してよい。
      return { kind: 'done', result: retryAt(deps, null, 'transport') };
  }
}

function retry(
  deps: SheetsReadDeps,
  response: HttpResponse,
  reason: 'rate-limited' | 'unavailable',
): SheetsSyncResult {
  const header = response.headers['retry-after'];
  const seconds = header !== undefined && /^\d+$/.test(header) ? Number(header) : null;
  return retryAt(deps, seconds !== null && Number.isSafeInteger(seconds) ? seconds : null, reason);
}

function retryAt(
  deps: SheetsReadDeps,
  seconds: number | null,
  reason: 'rate-limited' | 'unavailable' | 'transport',
): SheetsSyncResult {
  const delay = (seconds ?? deps.retryDelaySeconds ?? 30) * 1000;
  return {
    kind: 'retry',
    notBefore: new Date(Date.parse(deps.clock.now()) + delay).toISOString(),
    reason,
  };
}

type Parsed =
  | { ok: true; resolvedRange: string; rows: CellValue[][]; columnCount: number }
  | { ok: false; reason: 'malformed-response' | 'too-large' };

/**
 * `values:batchGet` の応答を検査して行に直す。応答は未信頼の入力として、形の合わない値を受け付けない。
 * 空の文字列は空のセルと区別できないため `null` にし、行を最も長い行の幅に `null` で揃える。
 */
function parseValues(body: string, spreadsheetId: string, maxCells: number): Parsed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'malformed-response' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.valueRanges) || parsed.valueRanges.length !== 1) {
    return { ok: false, reason: 'malformed-response' };
  }
  if (parsed.spreadsheetId !== undefined && parsed.spreadsheetId !== spreadsheetId) {
    return { ok: false, reason: 'malformed-response' };
  }
  const valueRange: unknown = parsed.valueRanges[0];
  if (!isRecord(valueRange) || typeof valueRange.range !== 'string') {
    return { ok: false, reason: 'malformed-response' };
  }
  if (valueRange.majorDimension !== undefined && valueRange.majorDimension !== 'ROWS') {
    return { ok: false, reason: 'malformed-response' };
  }
  const values = valueRange.values ?? [];
  if (!Array.isArray(values)) return { ok: false, reason: 'malformed-response' };

  const rows: CellValue[][] = [];
  let columnCount = 0;
  for (const row of values) {
    if (!Array.isArray(row)) return { ok: false, reason: 'malformed-response' };
    const cells: CellValue[] = [];
    for (const cell of row) {
      if (cell === null || cell === '') cells.push(null);
      else if (typeof cell === 'string') cells.push(cell);
      else if (typeof cell === 'boolean') cells.push(cell);
      else if (typeof cell === 'number' && Number.isFinite(cell)) cells.push(cell);
      else return { ok: false, reason: 'malformed-response' };
    }
    columnCount = Math.max(columnCount, cells.length);
    rows.push(cells);
    if (rows.length * columnCount > maxCells) return { ok: false, reason: 'too-large' };
  }
  for (const row of rows) while (row.length < columnCount) row.push(null);
  return { ok: true, resolvedRange: valueRange.range, rows, columnCount };
}

async function hashContent(resolvedRange: string, rows: CellValue[][]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson({ resolvedRange, rows })),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));
  return `sha256:${hex.join('')}`;
}

function rowId(index: number): string {
  return `${ROW_PREFIX}${String(index).padStart(8, '0')}`;
}

interface StoredMeta {
  provider: string;
  container: string;
  requestedRange: string;
  resolvedRange: string;
  valueRender: ValueRender;
  columnCount: number;
  rowCount: number;
  fetchedAt: string;
  contentHash: string;
}

function isMeta(value: unknown): value is StoredMeta {
  return (
    isRecord(value) &&
    typeof value.provider === 'string' &&
    typeof value.container === 'string' &&
    typeof value.requestedRange === 'string' &&
    typeof value.resolvedRange === 'string' &&
    (value.valueRender === 'unformatted' || value.valueRender === 'formatted') &&
    Number.isInteger(value.columnCount) &&
    Number.isInteger(value.rowCount) &&
    typeof value.fetchedAt === 'string' &&
    typeof value.contentHash === 'string'
  );
}

function isRow(value: unknown): value is CellValue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (cell) =>
        cell === null ||
        typeof cell === 'string' ||
        typeof cell === 'boolean' ||
        typeof cell === 'number',
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
