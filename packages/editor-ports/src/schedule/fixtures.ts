/**
 * Schedule の Host port の fixture。架空のデータだけで、実在の人・アカウント・URL を含めない。
 * 本リポジトリが契約から書いたもので、EditorPlatform の mock Host の出力を写したものではない。
 * 各 fixture の comment の ID は EditorPlatform の検証計画のシナリオ ID。
 */
import type {
  EffectIntent,
  OperationStatus,
  OverlayNotice,
  OverlayRange,
  OverlayRead,
  PreparedPlan,
  ScheduleSourceInfo,
} from './port.js';

const HOUR = 3_600_000;
/** 2026-10-26（月）00:00 UTC から一週間。 */
export const week: OverlayRange = {
  from: Date.UTC(2026, 9, 26),
  to: Date.UTC(2026, 10, 2),
};
const tuesday = Date.UTC(2026, 9, 27);
const thursday = Date.UTC(2026, 9, 29);
const friday = Date.UTC(2026, 9, 30);

export const workSource: ScheduleSourceInfo = {
  handle: 'source-work',
  label: 'Work calendar (synthetic)',
  provider: 'Fake',
  account: 'account 1 (synthetic)',
  access: 'details',
};
export const teamSource: ScheduleSourceInfo = {
  handle: 'source-team',
  label: 'Team availability (synthetic)',
  provider: 'Fake',
  account: 'account 1 (synthetic)',
  access: 'busy',
};
export const sources: ScheduleSourceInfo[] = [workSource, teamSource];
export const generation = 'generation-1';

/** 全ページを読めた読取。時刻のある予定と、終日の予定（終わりの日は含まない）。 */
export const completeRead: OverlayRead = {
  sourceHandle: workSource.handle,
  generation,
  range: week,
  complete: true,
  missing: [],
  fetchedAt: week.from,
  events: [
    {
      id: 'event-sync',
      sourceHandle: workSource.handle,
      start: tuesday + 9 * HOUR,
      end: tuesday + 10 * HOUR,
      title: 'Weekly sync (synthetic)',
      // 未信頼の Provider の文字列。Editor は plain text として扱う（X17）。
      notes: 'Agenda <script>alert(1)</script> https://example.invalid/agenda',
    },
    {
      id: 'event-offsite',
      sourceHandle: workSource.handle,
      start: friday,
      end: friday + 24 * HOUR,
      allDay: { startDate: '2026-10-30', endDate: '2026-10-31' },
      title: 'Offsite (synthetic)',
    },
  ],
};

/** 途中のページで失敗した読取（X10、X16）。読めなかった期間は空きではなく不明。 */
export const incompleteRead: OverlayRead = {
  ...completeRead,
  complete: false,
  missing: [{ from: thursday, to: week.to }],
  events: completeRead.events.filter((e) => e.end <= thursday),
};

/** Busy だけの source の読取（X16）。件名・本文を持たない。 */
export const busyRead: OverlayRead = {
  sourceHandle: teamSource.handle,
  generation,
  range: week,
  complete: true,
  missing: [],
  fetchedAt: week.from,
  events: [
    {
      id: 'busy-thursday',
      sourceHandle: teamSource.handle,
      start: thursday + 13 * HOUR,
      end: thursday + 15 * HOUR,
    },
  ],
};

/** 変更と失効の合図（X03）。内容を運ばない。 */
export const changedNotice: OverlayNotice = { kind: 'changed', sourceHandle: workSource.handle };
export const revokedNotice: OverlayNotice = { kind: 'revoked' };

export const timedIntent: EffectIntent = {
  kind: 'create-event',
  eventId: 'draft-1',
  title: 'Design review (synthetic)',
  time: {
    kind: 'timed',
    startLocal: '2026-11-03T10:00',
    endLocal: '2026-11-03T11:00',
    timeZone: 'Asia/Tokyo',
  },
  conference: 'meet',
};
/** DST の終わりで二度ある時刻は、どちらかを fold で選ぶ（X11）。 */
export const foldedIntent: EffectIntent = {
  kind: 'create-event',
  eventId: 'draft-2',
  title: 'Late call (synthetic)',
  time: {
    kind: 'timed',
    startLocal: '2026-11-01T01:30',
    endLocal: '2026-11-01T01:45',
    timeZone: 'America/New_York',
    startFold: 'later',
    endFold: 'later',
  },
  conference: 'none',
};
/** 本人が選んだときだけ notes を含める。 */
export const allDayIntent: EffectIntent = {
  kind: 'create-event',
  eventId: 'draft-3',
  title: 'Planning day (synthetic)',
  time: { kind: 'allDay', startDate: '2026-11-05', endDateExclusive: '2026-11-06' },
  conference: 'none',
  notes: 'Bring the roadmap (synthetic).',
};

/** Editor が渡す basis。Host は中身を解釈せず、計画に凍結して返す（X04）。 */
export const basis = 'basis-1';
export const plan: PreparedPlan = {
  handle: 'plan-1',
  basis,
  calendar: workSource.label,
  organizer: workSource.account,
  conference: 'Google Meet',
  sends: [
    { label: 'Title', value: timedIntent.title },
    { label: 'When', value: '2026-11-03 10:00 – 2026-11-03 11:00 Asia/Tokyo' },
    { label: 'Meeting', value: 'Google Meet' },
  ],
  notifies: 'No participants (synthetic)',
};

const event = { id: 'event', label: 'Calendar event' };
const meeting = { id: 'meeting', label: 'Meeting' };
const status = (steps: OperationStatus['steps']): OperationStatus => ({
  operation: 'operation-1',
  steps,
});

/** 操作の状態。予定と会議を別の step にする（X07、X13）。 */
export const statuses = {
  queued: status([
    { ...event, state: 'prepared' },
    { ...meeting, state: 'prepared' },
  ]),
  dispatching: status([
    { ...event, state: 'dispatching' },
    { ...meeting, state: 'prepared' },
  ]),
  verified: status([
    { ...event, state: 'verified' },
    { ...meeting, state: 'verified' },
  ]),
  /** 応答がなく、作用の有無が不明（X06）。未送信に戻さない。 */
  unknown: status([
    {
      ...event,
      state: 'unknown',
      detail: 'No response from the calendar. The event may or may not exist.',
    },
    { ...meeting, state: 'prepared' },
  ]),
  /** 予定はでき、会議の生成が受理後に失敗した（X07、X13）。 */
  partial: status([
    { ...event, state: 'verified' },
    { ...meeting, state: 'failed-after-acceptance', detail: 'The meeting could not be created.' },
  ]),
  /** Meet の生成を待っている（X13）。予定の受理だけで参加可能としない。 */
  meetingPending: status([
    { ...event, state: 'verified' },
    { ...meeting, state: 'accepted' },
  ]),
  rejected: status([{ ...event, state: 'rejected', detail: 'The calendar refused the request.' }]),
  /** 計画の後に予定表が変わった（X05）。 */
  conflict: status([
    { ...event, state: 'conflict', detail: 'The calendar changed after planning.' },
  ]),
  /** 未送信を証明できたので取り消せた（X08）。 */
  cancelled: status([
    { ...event, state: 'cancelled-before-dispatch' },
    { ...meeting, state: 'cancelled-before-dispatch' },
  ]),
  /** 送信の後に権限を失った（X03）。実行の可否は step の状態と別に持つ。 */
  revoked: {
    ...status([
      { ...event, state: 'unknown', detail: 'Access was revoked after sending.' },
      { ...meeting, state: 'prepared' },
    ]),
    blocked: 'revoked',
  },
} satisfies Record<string, OperationStatus>;
