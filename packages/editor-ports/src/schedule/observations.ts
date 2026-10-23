/**
 * Schedule の Host port の値が Editor–Host 契約を守っているかの検査。EditorPlatform から写したものでは
 * なく、本リポジトリが契約の文書（3、5、9）と検証計画の「接続」列から書いたもの。Adapter の戻り値と
 * fixture の両方に使う。問題がなければ空の配列を返す。
 */
import type {
  OperationStatus,
  OverlayNotice,
  OverlayRange,
  OverlayRead,
  PreparedPlan,
  ScheduleSourceInfo,
  StepState,
} from './port.js';

export const stepStates = [
  'prepared',
  'dispatching',
  'accepted',
  'failed-after-acceptance',
  'unknown',
  'verified',
  'rejected',
  'conflict',
  'cancelled-before-dispatch',
] as const satisfies readonly StepState[];
// StepState が増えたら、ここで型の誤りになる。
const allStepStates: Exclude<StepState, (typeof stepStates)[number]> extends never ? true : never =
  true;
void allStepStates;

const date = /^\d{4}-\d{2}-\d{2}$/;
const detailFields = new Set(['id', 'sourceHandle', 'start', 'end', 'allDay', 'title', 'notes']);
const busyFields = new Set(['id', 'sourceHandle', 'start', 'end', 'allDay']);
const sameRange = (a: OverlayRange, b: OverlayRange) => a.from === b.from && a.to === b.to;

/**
 * 読取の結果（X03、X10、X16）。要求した source・期間・接続の世代の結果であること、完全でない読取を
 * 完全と言わないこと、busy だけの source に件名・本文を入れないこと、決めた field の外を足さないこと。
 */
export function overlayReadProblems(
  read: OverlayRead,
  request: { source: ScheduleSourceInfo; range: OverlayRange; generation?: string },
): string[] {
  const problems: string[] = [];
  const { source, range } = request;
  if (read.sourceHandle !== source.handle) problems.push('read is for another source');
  if (!sameRange(read.range, range)) problems.push('read is for another range');
  if (!read.generation) problems.push('read has no connection generation');
  else if (request.generation !== undefined && read.generation !== request.generation)
    problems.push('read is from another connection generation');
  if (read.complete && read.missing.length) problems.push('complete read has missing ranges');
  for (const gap of read.missing)
    if (!(gap.from < gap.to && gap.from >= range.from && gap.to <= range.to))
      problems.push(`missing range ${gap.from}–${gap.to} is outside the read`);
  const fields = source.access === 'busy' ? busyFields : detailFields;
  for (const event of read.events) {
    const at = `event ${event.id}`;
    if (!event.id) problems.push('event has no id');
    if (event.sourceHandle !== source.handle) problems.push(`${at} is from another source`);
    if (!(event.start < event.end)) problems.push(`${at} does not end after it starts`);
    else if (!(event.end > range.from && event.start < range.to))
      problems.push(`${at} is outside the read range`);
    if (event.allDay) {
      const { startDate, endDate } = event.allDay;
      if (!date.test(startDate) || !date.test(endDate) || !(startDate < endDate))
        problems.push(`${at} has invalid all-day dates (end is exclusive)`);
    }
    for (const field of Object.keys(event))
      if (!fields.has(field))
        problems.push(
          source.access === 'busy' && detailFields.has(field)
            ? `${at} carries ${field} from a busy-only source`
            : `${at} carries the unknown field ${field}`,
        );
  }
  return problems;
}

/** 変更の合図（X03、X17）。内容や命令を運ばない。 */
export function overlayNoticeProblems(notice: OverlayNotice): string[] {
  const problems: string[] = [];
  if (notice.kind !== 'changed' && notice.kind !== 'revoked')
    problems.push(`unknown notice ${String(notice.kind)}`);
  for (const field of Object.keys(notice))
    if (field !== 'kind' && field !== 'sourceHandle') problems.push(`notice carries ${field}`);
  return problems;
}

/** 計画（X04）。Editor が渡した basis を、そのまま凍結して返す。 */
export function preparedPlanProblems(plan: PreparedPlan, basis: string): string[] {
  const problems: string[] = [];
  if (!plan.handle) problems.push('plan has no handle');
  if (plan.basis !== basis) problems.push('plan is frozen on another basis');
  return problems;
}

/** 操作の状態（契約 5）。Step を一つの成否に潰さず、実行の可否は step の状態と別に持つ。 */
export function operationStatusProblems(status: OperationStatus): string[] {
  const problems: string[] = [];
  if (!status.operation) problems.push('status has no operation');
  if (!status.steps.length) problems.push('status has no steps');
  const ids = new Set<string>();
  for (const step of status.steps) {
    if (ids.has(step.id)) problems.push(`step ${step.id} appears twice`);
    ids.add(step.id);
    if (!(stepStates as readonly string[]).includes(step.state))
      problems.push(`step ${step.id} has the unknown state ${step.state}`);
  }
  if (status.blocked !== undefined && status.blocked !== 'revoked')
    problems.push(`unknown block ${String(status.blocked)}`);
  return problems;
}

const unsent: readonly StepState[] = ['prepared', 'cancelled-before-dispatch'];

/**
 * 同じ操作の、前後二回の状態（X06、X08）。送信した可能性のある step を未送信へ戻さない。送信後の
 * 取消を `cancelled-before-dispatch` にしない。消えた step も問題にする。照合で未送信を証明して
 * （`OperationLedger.release` が受けた証拠で）`prepared` へ戻した step は `provenUnsent` に挙げる。
 */
export function operationProgressProblems(
  before: OperationStatus,
  after: OperationStatus,
  options: { provenUnsent?: readonly string[] } = {},
): string[] {
  const problems = operationStatusProblems(after);
  if (after.operation !== before.operation) problems.push('status is for another operation');
  for (const earlier of before.steps) {
    const later = after.steps.find((s) => s.id === earlier.id);
    if (!later) problems.push(`step ${earlier.id} disappeared`);
    else if (
      !unsent.includes(earlier.state) &&
      unsent.includes(later.state) &&
      !options.provenUnsent?.includes(earlier.id)
    )
      problems.push(`step ${earlier.id} went from ${earlier.state} back to ${later.state}`);
  }
  return problems;
}
