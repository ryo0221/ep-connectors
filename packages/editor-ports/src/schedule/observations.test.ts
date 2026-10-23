import { describe, expect, it } from 'vitest';
import * as fixtures from './fixtures.js';
import {
  operationProgressProblems,
  operationStatusProblems,
  overlayNoticeProblems,
  overlayReadProblems,
  preparedPlanProblems,
} from './observations.js';
import type {
  EffectIntent,
  OperationStatus,
  OverlayEvent,
  OverlayRead,
  ScheduleEffectPort,
  ScheduleReadPort,
} from './port.js';

const { workSource, teamSource, week, generation, statuses } = fixtures;
const work = { source: workSource, range: week, generation };
const team = { source: teamSource, range: week, generation };

describe('fixtures', () => {
  it('meet the contract', () => {
    expect(overlayReadProblems(fixtures.completeRead, work)).toEqual([]);
    expect(overlayReadProblems(fixtures.incompleteRead, work)).toEqual([]);
    expect(overlayReadProblems(fixtures.busyRead, team)).toEqual([]);
    expect(overlayNoticeProblems(fixtures.changedNotice)).toEqual([]);
    expect(overlayNoticeProblems(fixtures.revokedNotice)).toEqual([]);
    expect(preparedPlanProblems(fixtures.plan, fixtures.basis)).toEqual([]);
    for (const status of Object.values(statuses))
      expect(operationStatusProblems(status)).toEqual([]);
  });

  it('are plain JSON values', () => {
    for (const value of Object.values(fixtures))
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it('serve as the return values of the ports', async () => {
    const reads: Record<string, OverlayRead> = {
      [workSource.handle]: fixtures.completeRead,
      [teamSource.handle]: fixtures.busyRead,
    };
    const read: ScheduleReadPort = {
      listSources: async () => fixtures.sources,
      readRange: async ({ sourceHandle }) => reads[sourceHandle]!,
    };
    const intents: EffectIntent[] = [];
    const effects: ScheduleEffectPort = {
      prepare: async (intent, basis) => (intents.push(intent), { ...fixtures.plan, basis }),
      requestExecution: async () => statuses.dispatching,
      getStatus: async () => statuses.partial,
      cancelPending: async () => statuses.partial,
    };
    const signal = new AbortController().signal;
    for (const source of await read.listSources(signal)) {
      const result = await read.readRange({ sourceHandle: source.handle, range: week }, signal);
      expect(overlayReadProblems(result, { source, range: week, generation })).toEqual([]);
    }
    const plan = await effects.prepare(fixtures.timedIntent, 'basis-2', signal);
    expect(preparedPlanProblems(plan, 'basis-2')).toEqual([]);
    const sent = await effects.requestExecution(plan.handle);
    expect(operationProgressProblems(sent, await effects.getStatus(sent.operation))).toEqual([]);
    expect(intents).toEqual([fixtures.timedIntent]);
  });
});

describe('observations catch', () => {
  it('a late read from another source, range or generation (X03)', () => {
    expect(overlayReadProblems(fixtures.busyRead, work)).toContain('read is for another source');
    expect(
      overlayReadProblems(fixtures.completeRead, { ...work, range: { ...week, to: week.to + 1 } }),
    ).toContain('read is for another range');
    expect(overlayReadProblems(fixtures.completeRead, { ...work, generation: 'old' })).toContain(
      'read is from another connection generation',
    );
  });

  it('a read that calls itself complete with ranges missing (X10)', () => {
    const read = { ...fixtures.incompleteRead, complete: true };
    expect(overlayReadProblems(read, work)).toContain('complete read has missing ranges');
  });

  it('titles, notes and unknown fields on a busy-only source (X16)', () => {
    const leaking = {
      ...fixtures.busyRead.events[0]!,
      title: 'Secret (synthetic)',
      attendees: ['someone@example.invalid'],
    } as OverlayEvent;
    expect(overlayReadProblems({ ...fixtures.busyRead, events: [leaking] }, team)).toEqual([
      'event busy-thursday carries title from a busy-only source',
      'event busy-thursday carries the unknown field attendees',
    ]);
  });

  it('events outside the read and all-day dates read as inclusive', () => {
    const [timed, allDay] = fixtures.completeRead.events as [OverlayEvent, OverlayEvent];
    const outside = { ...timed, start: week.to, end: week.to + 1 };
    const inclusive = { ...allDay, allDay: { startDate: '2026-10-30', endDate: '2026-10-30' } };
    expect(
      overlayReadProblems({ ...fixtures.completeRead, events: [outside, inclusive] }, work),
    ).toEqual([
      'event event-sync is outside the read range',
      'event event-offsite has invalid all-day dates (end is exclusive)',
    ]);
  });

  it('content carried by a notice (X17)', () => {
    const notice = { kind: 'changed', title: 'Moved (synthetic)' } as never;
    expect(overlayNoticeProblems(notice)).toEqual(['notice carries title']);
  });

  it('a plan frozen on another basis (X04)', () => {
    expect(preparedPlanProblems(fixtures.plan, 'basis-2')).toEqual([
      'plan is frozen on another basis',
    ]);
  });

  it('an unknown step returned to unsent (X06)', () => {
    expect(operationProgressProblems(statuses.unknown, statuses.queued)).toEqual([
      'step event went from unknown back to prepared',
    ]);
    // 照合で未送信を証明して戻した step は問題にしない。
    expect(
      operationProgressProblems(statuses.unknown, statuses.queued, { provenUnsent: ['event'] }),
    ).toEqual([]);
  });

  it('a cancel after dispatch reported as cancelled before dispatch (X08)', () => {
    expect(operationProgressProblems(statuses.dispatching, statuses.cancelled)).toEqual([
      'step event went from dispatching back to cancelled-before-dispatch',
    ]);
    expect(operationProgressProblems(statuses.queued, statuses.cancelled)).toEqual([]);
  });

  it('steps collapsed or duplicated (X07)', () => {
    const collapsed: OperationStatus = { ...statuses.partial, steps: [] };
    expect(operationProgressProblems(statuses.partial, collapsed)).toEqual([
      'status has no steps',
      'step event disappeared',
      'step meeting disappeared',
    ]);
    const twice = {
      ...statuses.verified,
      steps: [...statuses.verified.steps, statuses.verified.steps[0]!],
    };
    expect(operationStatusProblems(twice)).toEqual(['step event appears twice']);
  });
});
