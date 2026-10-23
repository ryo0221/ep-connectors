import type { JsonObject, JsonValue, SyncEntry } from '@ep-connectors/core';
import { plainExternalText } from '../overlay.js';

/**
 * Cache に置く一つの予定。Google の event JSON の全体を写さず、表示と照合に要る field だけを持つ。
 * 文字列は取り込む時点で plain text にする。
 */
export interface CachedGoogleEvent {
  [key: string]: JsonValue | undefined;
  etag: string;
  updated: string;
  start: GoogleTime;
  end: GoogleTime;
  summary?: string;
  description?: string;
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
    if (!span || span.end <= from || span.start >= to) {
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
  if (typeof item.description === 'string') event.description = plainExternalText(item.description);
  if (typeof item.recurringEventId === 'string') event.recurringEventId = item.recurringEventId;
  const original = toTime(item.originalStartTime);
  if (original) event.originalStartTime = original;
  return event;
}

function toTime(value: unknown): GoogleTime | null {
  if (!isObject(value)) return null;
  if (typeof value.date === 'string') return DATE.test(value.date) ? { date: value.date } : null;
  if (typeof value.dateTime === 'string' && !Number.isNaN(Date.parse(value.dateTime))) {
    return typeof value.timeZone === 'string'
      ? { dateTime: value.dateTime, timeZone: value.timeZone }
      : { dateTime: value.dateTime };
  }
  return null;
}

/** 予定の範囲（epoch ms）。終日の予定は UTC の 0 時に置く。 */
export function eventSpan(event: CachedGoogleEvent): { start: number; end: number } | null {
  const start = timeValue(event.start);
  const end = timeValue(event.end);
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

function timeValue(time: GoogleTime): number | null {
  const value = 'date' in time ? Date.parse(`${time.date}T00:00:00Z`) : Date.parse(time.dateTime);
  return Number.isNaN(value) ? null : value;
}

/** Cache の値を予定として読む。自分で書いた値だが、保管は Host のものなので形を確かめる。 */
export function asCachedGoogleEvent(value: JsonValue): CachedGoogleEvent | null {
  if (!isObject(value) || !toTime(value.start) || !toTime(value.end)) return null;
  return value as unknown as CachedGoogleEvent;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
