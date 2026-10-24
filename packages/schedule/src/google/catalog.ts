import type { OperationCatalog } from '@ep-connectors/core';

export const GOOGLE_PROVIDER = 'google';
export const GOOGLE_API_ORIGIN = 'https://www.googleapis.com';

/** 予定を読むだけの scope。`calendar.readonly` より狭い。 */
export const GOOGLE_CALENDAR_EVENTS_READ_SCOPE =
  'https://www.googleapis.com/auth/calendar.events.readonly';

export const EVENTS_LIST = 'calendar.events.list';

/**
 * `events.list` で受け取る field。読取が使う field だけにし、参加者・主催者・作成者・会議の URL・
 * メモ（`description`）を Google から受け取らない。`nextSyncToken` も `fields` に載せないと返らない。
 */
export const GOOGLE_EVENTS_FIELDS =
  'items(id,etag,status,updated,start,end,summary,recurringEventId,originalStartTime),nextPageToken,nextSyncToken';

/**
 * Google Calendar の操作の目録（全体設計 3.2.1）。R1 は読取だけで、書込みの操作を載せない。
 * `pageToken` と `syncToken` は URL ではなく不透明な値なので、送り先は常にこの origin と path になる。
 */
export const GOOGLE_CALENDAR_CATALOG: OperationCatalog = {
  provider: GOOGLE_PROVIDER,
  operations: [
    {
      name: EVENTS_LIST,
      method: 'GET',
      origin: GOOGLE_API_ORIGIN,
      path: '/calendar/v3/calendars/{calendarId}/events',
      query: ['timeMin', 'timeMax', 'singleEvents', 'maxResults', 'pageToken', 'syncToken'],
      fixedQuery: { fields: GOOGLE_EVENTS_FIELDS },
      scopes: [GOOGLE_CALENDAR_EVENTS_READ_SCOPE],
      auth: 'token',
    },
  ],
};
