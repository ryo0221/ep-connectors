import type { HttpResponse } from '@ep-connectors/core';
import type { ReceivedRequest } from '@ep-connectors/testing';
import { FakeProvider, json } from '@ep-connectors/testing';

export interface FakeEvent {
  id: string;
  summary?: string;
  description?: string;
  start: { dateTime: string; timeZone?: string } | { date: string };
  end: { dateTime: string } | { date: string };
}

interface StoredEvent {
  event: FakeEvent;
  cancelled: boolean;
  /** 最後に変わった変更番号。 */
  seq: number;
}

/**
 * Google Calendar の `events.list` の偽物。公式の仕様（events.list、差分同期のガイド）で確かめた
 * 振る舞いだけを再現する。
 *
 * - `timeMin` / `timeMax` の全件取得は、期間に重なる取消されていない予定を返す。
 * - 最後のページだけが `nextSyncToken` を持ち、途中のページは `nextPageToken` を持つ。
 * - `syncToken` の取得は、その基点より後に変わった予定を、取消（`status: cancelled`）も含めて返す。
 * - 失効した `syncToken` には 410 を返す。
 *
 * 差分の取得が初回の期間で絞られるかは確かめていないため、期間の外の変更も返す側で振る舞う。
 * Access token は `validToken` だけを受け付け、それ以外には 401 を返す。
 */
export class FakeGoogleCalendar {
  readonly provider = new FakeProvider();
  validToken = 'access-token-1';
  pageSize = 2;
  private seq = 0;
  private readonly calendars = new Map<string, Map<string, StoredEvent>>();
  private readonly expiredTokens = new Set<string>();
  /** 次の `events.list` の応答を差し替える。先頭から一つずつ使う。 */
  private readonly injected: (HttpResponse | 'throw')[] = [];

  constructor() {
    this.provider.route(
      'GET',
      'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events',
      (request, params) => this.list(request, params.calendarId as string),
    );
  }

  put(calendarId: string, event: FakeEvent): void {
    this.seq += 1;
    this.calendar(calendarId).set(event.id, { event, cancelled: false, seq: this.seq });
  }

  cancel(calendarId: string, id: string): void {
    const stored = this.calendar(calendarId).get(id);
    if (!stored) throw new Error(`no event ${id}`);
    this.seq += 1;
    stored.cancelled = true;
    stored.seq = this.seq;
  }

  /** 今までに発行した `syncToken` をすべて失効させる。 */
  expireSyncTokens(): void {
    for (let seq = 0; seq <= this.seq; seq += 1) this.expiredTokens.add(syncToken(seq));
  }

  inject(...responses: (HttpResponse | 'throw')[]): void {
    this.injected.push(...responses);
  }

  /** `events.list` に届いた要求。 */
  get listRequests(): ReceivedRequest[] {
    return this.provider.received;
  }

  private calendar(calendarId: string): Map<string, StoredEvent> {
    let calendar = this.calendars.get(calendarId);
    if (!calendar) {
      calendar = new Map();
      this.calendars.set(calendarId, calendar);
    }
    return calendar;
  }

  private list(request: ReceivedRequest, calendarId: string): HttpResponse {
    const injected = this.injected.shift();
    if (injected === 'throw') throw new Error('connection reset');
    if (injected) return injected;
    if (request.headers.authorization !== `Bearer ${this.validToken}`) {
      return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
    }
    const query = new URL(request.url).searchParams;
    const page = query.get('pageToken');
    // pageToken は「どの一覧の何件目からか」を持つ。一覧は最初のページの時点で固定する。
    const cursor = page
      ? (JSON.parse(Buffer.from(page, 'base64url').toString()) as PageCursor)
      : this.firstCursor(query);
    if (!cursor)
      return json(410, { error: { code: 410, message: 'Sync token is no longer valid' } });

    const items = this.select(calendarId, cursor);
    const slice = items.slice(cursor.offset, cursor.offset + this.pageSize);
    const rest = cursor.offset + this.pageSize < items.length;
    const body: Record<string, unknown> = {
      kind: 'calendar#events',
      items: slice.map((stored) =>
        stored.cancelled
          ? { id: stored.event.id, status: 'cancelled' }
          : { ...stored.event, status: 'confirmed', etag: `"e${stored.seq}"`, updated: 'x' },
      ),
    };
    if (rest) {
      body.nextPageToken = Buffer.from(
        JSON.stringify({ ...cursor, offset: cursor.offset + this.pageSize }),
      ).toString('base64url');
    } else {
      body.nextSyncToken = syncToken(cursor.upTo);
    }
    return json(200, body);
  }

  private firstCursor(query: URLSearchParams): PageCursor | null {
    const token = query.get('syncToken');
    if (token !== null) {
      if (this.expiredTokens.has(token) || !token.startsWith('sync-')) return null;
      return { after: Number(token.slice(5)), upTo: this.seq, offset: 0 };
    }
    return {
      after: null,
      upTo: this.seq,
      offset: 0,
      timeMin: query.get('timeMin') ?? '',
      timeMax: query.get('timeMax') ?? '',
    };
  }

  private select(calendarId: string, cursor: PageCursor): StoredEvent[] {
    const all = [...this.calendar(calendarId).values()]
      .filter((stored) => stored.seq <= cursor.upTo)
      .sort((a, b) => (a.event.id < b.event.id ? -1 : 1));
    if (cursor.after !== null) return all.filter((stored) => stored.seq > (cursor.after as number));
    const from = Date.parse(cursor.timeMin ?? '');
    const to = Date.parse(cursor.timeMax ?? '');
    return all.filter((stored) => {
      if (stored.cancelled) return false;
      const start = timeOf(stored.event.start);
      const end = timeOf(stored.event.end);
      return end > from && start < to;
    });
  }
}

interface PageCursor {
  /** 差分の基点の変更番号。全件取得では null。 */
  after: number | null;
  /** 一覧を固定した時点の変更番号。 */
  upTo: number;
  offset: number;
  timeMin?: string;
  timeMax?: string;
}

function syncToken(seq: number): string {
  return `sync-${seq}`;
}

function timeOf(time: { dateTime: string } | { date: string }): number {
  return 'date' in time ? Date.parse(`${time.date}T00:00:00Z`) : Date.parse(time.dateTime);
}
