import type { HostPolicy, SyncScope, SyncStateStore } from '@ep-connectors/core';
import type { OverlayEvent, OverlayRange, OverlayRead } from '../overlay.js';
import { uncovered } from '../overlay.js';
import { eventSpan, asCachedGoogleEvent } from './events.js';
import { parseSyncBasis } from './sync.js';

export interface GoogleCalendarRangeRequest {
  /** Host が付けた source handle。DTO にそのまま載せる。 */
  sourceHandle: string;
  scope: SyncScope;
  range: OverlayRange;
}

/**
 * 公開済みの世代だけから期間の予定を返す。Provider へは送らない。
 *
 * - 接続が現在の session のものでなければ、cache の中身を返さない。
 * - 公開済みの世代がない（初回の取得前、410 や失効の後の作り直しの途中）なら `complete: false`。
 * - 同期の期間の外は `missing` に入れ、`complete: false` にする。空きとして返さない。
 */
export async function readGoogleCalendarRange(
  deps: { sync: SyncStateStore; policy: HostPolicy },
  request: GoogleCalendarRangeRequest,
): Promise<OverlayRead> {
  const { scope, range, sourceHandle } = request;
  const empty: OverlayRead = {
    sourceHandle,
    generation: String(scope.connection.generation),
    range,
    complete: false,
    missing: [range],
    fetchedAt: null,
    events: [],
  };
  const decision = await deps.policy.authorizeConnection(scope.connection);
  if (!decision.ok || !scope.window) return empty;
  const published = await deps.sync.read(scope);
  const basis = parseSyncBasis(published?.cursor ?? null);
  if (!published || !basis) return empty;

  const window = { from: Date.parse(scope.window.start), to: Date.parse(scope.window.end) };
  const missing = uncovered(range, window);
  const events: OverlayEvent[] = [];
  for (const entry of published.entries) {
    const event = asCachedGoogleEvent(entry.value);
    if (!event) continue;
    const span = eventSpan(event);
    if (!span || span.end <= range.from || span.start >= range.to) continue;
    const overlay: OverlayEvent = { id: entry.id, sourceHandle, start: span.start, end: span.end };
    if ('date' in event.start && 'date' in event.end) {
      overlay.allDay = { startDate: event.start.date, endDate: event.end.date };
    }
    if (event.summary !== undefined) overlay.title = event.summary;
    if (event.description !== undefined) overlay.notes = event.description;
    events.push(overlay);
  }
  events.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    sourceHandle,
    generation: String(scope.connection.generation),
    range,
    complete: missing.length === 0,
    missing,
    fetchedAt: Date.parse(basis.fetchedAt),
    events,
  };
}
