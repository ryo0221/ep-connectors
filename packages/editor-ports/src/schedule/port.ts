// EditorPlatform の Host port から写した、公開してよい型。手で直さず
// `npm run editor-ports:sync -- <editor-platform の checkout>` で写し直す。
// 写した元の commit と symbol は upstream.json にある。

// packages/schedule/src/zone.ts

export type Fold = 'earlier' | 'later';
/** A wall-clock time in some zone, YYYY-MM-DDTHH:mm. */
export type LocalDateTime = string;

// packages/schedule/src/model.ts

export const conferences = ['none', 'meet', 'teams', 'zoom'] as const;
export type ConferencePreference = (typeof conferences)[number];
export interface TimedTime {
  kind: 'timed';
  startLocal: LocalDateTime;
  endLocal: LocalDateTime;
  /** Canonical IANA zone of both wall times. */
  timeZone: string;
  /** Required only when the wall time occurs twice in the zone. */
  startFold?: Fold;
  endFold?: Fold;
}
export interface AllDayTime {
  kind: 'allDay';
  startDate: string;
  /** The day after the last day, as in calendar providers. Never converted through UTC. */
  endDateExclusive: string;
}
export type EventTime = TimedTime | AllDayTime;

// packages/schedule/src/host.ts

export interface ScheduleSourceInfo {
  /** Opaque Host handle for one connected calendar of the current principal. */
  handle: string;
  label: string;
  provider: string;
  account: string;
  /** busy: the Host can read only free/busy intervals for this source. */
  access: 'details' | 'busy';
}
/** One external event as the current principal may see it. Never stored in Schedule content. */
export interface OverlayEvent {
  id: string;
  sourceHandle: string;
  start: number;
  end: number;
  /** Calendar dates of an all-day event, end exclusive. Placed as dates, never through a zone. */
  allDay?: { startDate: string; endDate: string };
  /** Absent for busy-only sources. Plain text from an untrusted provider. */
  title?: string;
  notes?: string;
}
export interface OverlayRange {
  from: number;
  to: number;
}
export interface OverlayRead {
  sourceHandle: string;
  /** Connection generation; a read from an older generation is never shown. */
  generation: string;
  range: OverlayRange;
  /** false when a page failed, a limit was hit or access could not be confirmed. */
  complete: boolean;
  /** Ranges that were not read. They are unknown, not free. */
  missing: OverlayRange[];
  fetchedAt: number;
  events: OverlayEvent[];
}
export interface OverlayNotice {
  kind: 'changed' | 'revoked';
  sourceHandle?: string;
}
export interface ScheduleReadPort {
  listSources(signal: AbortSignal): Promise<ScheduleSourceInfo[]>;
  readRange(
    request: { sourceHandle: string; range: OverlayRange },
    signal: AbortSignal,
  ): Promise<OverlayRead>;
  /** Change or revocation signals only; never content or commands. */
  watch?(notify: (notice: OverlayNotice) => void): () => void;
}
/** What the Editor asks the Host to plan. Internal links are never part of an intent. */
export interface EffectIntent {
  kind: 'create-event';
  eventId: string;
  title: string;
  time: EventTime;
  conference: ConferencePreference;
  /** Only when the person chose to include the notes in the invitation. */
  notes?: string;
}
export interface PreparedPlan {
  handle: string;
  /** The Editor basis the Host froze into the plan. */
  basis: string;
  calendar: string;
  organizer: string;
  conference: string;
  /** Exactly what the Host will send, from the Host's stored plan. */
  sends: { label: string; value: string }[];
  notifies: string;
}
export type StepState =
  | 'prepared'
  | 'dispatching'
  | 'accepted'
  | 'failed-after-acceptance'
  | 'unknown'
  | 'verified'
  | 'rejected'
  | 'conflict'
  | 'cancelled-before-dispatch';
export interface OperationStep {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
}
export interface OperationStatus {
  operation: string;
  steps: OperationStep[];
  /** Execution availability, separate from step states. */
  blocked?: 'revoked';
}
export interface ScheduleEffectPort {
  prepare(intent: EffectIntent, basis: string, signal: AbortSignal): Promise<PreparedPlan>;
  requestExecution(planHandle: string): Promise<OperationStatus>;
  getStatus(operation: string): Promise<OperationStatus>;
  cancelPending(operation: string): Promise<OperationStatus>;
}
