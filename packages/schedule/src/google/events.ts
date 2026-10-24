import type { JsonObject, JsonValue, SyncEntry } from '@ep-connectors/core';
import { plainExternalText } from '../overlay.js';

/**
 * Cache に置く一つの予定。Google の event JSON の全体を写さず、表示と照合に要る field だけを持つ。メモ
 * （`description`）は受け取らず、持たない（参加者のメールや会議の URL が書かれることが多いため）。
 * 文字列は取り込む時点で plain text にする。
 */
export interface CachedGoogleEvent {
  [key: string]: JsonValue | undefined;
  etag: string;
  updated: string;
  start: GoogleTime;
  end: GoogleTime;
  summary?: string;
  /** 繰り返しの発生回。発生回は `recurringEventId + originalStartTime` で識別する（Provider Notes 8）。 */
  recurringEventId?: string;
  originalStartTime?: GoogleTime;
}

export type GoogleTime = { dateTime: string; timeZone?: string } | { date: string };

/** 一ページの item を分けた結果。 */
export interface ParsedItems {
  upserts: SyncEntry[];
  /** `status: cancelled` の予定と、取得期間の外へ出た予定。 */
  removals: string[];
}

export type ParsedPage =
  | { ok: true; items: ParsedItems; nextPageToken?: string; nextSyncToken?: string }
  | { ok: false };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `events.list` の応答を読む。応答は未信頼の入力として扱い、形が合わなければページごと失敗にする。
 * 取得期間 `window` と重ならない予定は、cache に置かず削除として扱う（差分の応答が期間の外の変更を
 * 含むかは実接続で確かめていないため、含む側で振る舞う）。
 */
export function parseEventsPage(body: string, window: { start: string; end: string }): ParsedPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false };
  }
  if (!isObject(parsed)) return { ok: false };
  const { items = [], nextPageToken, nextSyncToken } = parsed;
  if (!Array.isArray(items)) return { ok: false };
  if (nextPageToken !== undefined && typeof nextPageToken !== 'string') return { ok: false };
  if (nextSyncToken !== undefined && typeof nextSyncToken !== 'string') return { ok: false };

  const from = Date.parse(window.start);
  const to = Date.parse(window.end);
  const result: ParsedItems = { upserts: [], removals: [] };
  for (const item of items) {
    if (!isObject(item) || typeof item.id !== 'string' || item.id === '') return { ok: false };
    if (item.status === 'cancelled') {
      result.removals.push(item.id);
      continue;
    }
    const event = toCachedEvent(item);
    if (!event) return { ok: false };
    const span = eventSpan(event);
    // 日付が読めない、終わりが始まりより前の予定は、削除として扱わずにページごと失敗にする。
    if (!span) return { ok: false };
    if (span.end <= from || span.start >= to) {
      result.removals.push(item.id);
      continue;
    }
    result.upserts.push({ id: item.id, value: event as JsonObject });
  }
  return {
    ok: true,
    items: result,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
    ...(nextSyncToken === undefined ? {} : { nextSyncToken }),
  };
}

function toCachedEvent(item: Record<string, unknown>): CachedGoogleEvent | null {
  const start = toTime(item.start);
  const end = toTime(item.end);
  if (!start || !end) return null;
  const event: CachedGoogleEvent = {
    etag: typeof item.etag === 'string' ? item.etag : '',
    updated: typeof item.updated === 'string' ? item.updated : '',
    start,
    end,
  };
  if (typeof item.summary === 'string') event.summary = plainExternalText(item.summary, 500);
  if (typeof item.recurringEventId === 'string') event.recurringEventId = item.recurringEventId;
  const original = toTime(item.originalStartTime);
  if (original) event.originalStartTime = original;
  return event;
}

function toTime(value: unknown): GoogleTime | null {
  if (!isObject(value)) return null;
  if (typeof value.date === 'string') return DATE.test(value.date) ? { date: value.date } : null;
  if (typeof value.dateTime !== 'string') return null;
  const time: GoogleTime =
    typeof value.timeZone === 'string'
      ? { dateTime: value.dateTime, timeZone: value.timeZone }
      : { dateTime: value.dateTime };
  return timeValue(time) === null ? null : time;
}

/** 予定の範囲（epoch ms）。終日の予定は UTC の 0 時に置く。 */
export function eventSpan(event: CachedGoogleEvent): { start: number; end: number } | null {
  const start = timeValue(event.start);
  const end = timeValue(event.end);
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

function timeValue(time: GoogleTime): number | null {
  if ('date' in time) return finite(Date.parse(`${time.date}T00:00:00Z`));
  if (OFFSET.test(time.dateTime)) return finite(Date.parse(time.dateTime));
  // Offset のない `dateTime` は `timeZone` の壁時計の時刻である。実行環境の timezone で読まない。
  return time.timeZone === undefined ? null : zonedTime(time.dateTime, time.timeZone);
}

const OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/**
 * IANA timezone の壁時計の時刻を epoch ms にする。DST で存在しない時刻・二重になる時刻は、
 * 前後の offset のどちらかに寄せる（表示のための読取であり、書込みには使わない）。
 */
function zonedTime(local: string, timeZone: string): number | null {
  const match = LOCAL.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi, sec = '0', ms = '0'] = match;
  const wall = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +sec, +ms.padEnd(3, '0'));
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
  const offsetAt = (instant: number): number => {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    const asUtc = Date.UTC(
      +parts.year!,
      +parts.month! - 1,
      +parts.day!,
      +parts.hour!,
      +parts.minute!,
      +parts.second!,
    );
    // 書式は秒までなので、比べる時刻も秒に切り捨てる。
    return asUtc - Math.floor(instant / 1000) * 1000;
  };
  const first = wall - offsetAt(wall);
  return finite(wall - offsetAt(first));
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Cache の値を予定として読む。自分で書いた値だが、保管は Host のものなので形を確かめる。 */
export function asCachedGoogleEvent(value: JsonValue): CachedGoogleEvent | null {
  if (!isObject(value) || !toTime(value.start) || !toTime(value.end)) return null;
  return value as unknown as CachedGoogleEvent;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
