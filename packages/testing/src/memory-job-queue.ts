import type {
  EnqueueOptions,
  HostPolicy,
  JobHandler,
  JobOutcome,
  JobQueue,
  JobRef,
} from '@ep-connectors/core';

export interface QueuedJob {
  jobId: string;
  job: JobRef;
  notBefore: string | null;
  status: 'pending' | 'done' | 'abandoned';
  abandonedReason?: string;
}

export interface MemoryQueueBacking {
  jobs: QueuedJob[];
  sequence: number;
}

export function createQueueBacking(): MemoryQueueBacking {
  return { jobs: [], sequence: 0 };
}

/** 試験専用の `JobQueue`。実行は `runDueJobs` で明示的に進める。 */
export class MemoryJobQueue implements JobQueue {
  constructor(private readonly backing: MemoryQueueBacking) {}

  async enqueue(job: JobRef, options: EnqueueOptions = {}): Promise<{ jobId: string }> {
    this.backing.sequence += 1;
    const jobId = `job-${this.backing.sequence}`;
    this.backing.jobs.push({
      jobId,
      job: structuredClone(job),
      notBefore: options.notBefore ?? null,
      status: 'pending',
    });
    return { jobId };
  }
}

export interface RunDueOptions {
  now: string;
  policy: HostPolicy;
  handler: JobHandler;
  /** 同じ job を何回配送するか。「一回だけ配送する」保証がないキューを再現する。 */
  deliveries?: number;
}

/**
 * 期限の来た job を配送する。配送ごとに直前で `authorizeDispatch` を呼び、拒否されたら handler を
 * 呼ばずに終える。重複した配送は並行に走らせる。
 */
export async function runDueJobs(
  backing: MemoryQueueBacking,
  options: RunDueOptions,
): Promise<void> {
  const due = backing.jobs.filter(
    (entry) =>
      entry.status === 'pending' &&
      (entry.notBefore === null || Date.parse(entry.notBefore) <= Date.parse(options.now)),
  );
  await Promise.all(
    due.map(async (entry) => {
      const outcomes = await Promise.all(
        Array.from({ length: options.deliveries ?? 1 }, () => deliver(entry, options)),
      );
      settle(entry, outcomes);
    }),
  );
}

async function deliver(entry: QueuedJob, options: RunDueOptions): Promise<JobOutcome> {
  const job = structuredClone(entry.job);
  const decision = await options.policy.authorizeDispatch(job);
  if (!decision.ok) return { kind: 'abandoned', reason: decision.reason };
  return options.handler(job);
}

/**
 * 重複した配送の結果をまとめる。送信権を得られずに何もしなかった配送の `done` で、送信権を持つ
 * 配送が求めた `retry` を消さない。`retry`（最も早い時刻）、`abandoned`、`done` の順に優先する。
 */
function settle(entry: QueuedJob, outcomes: JobOutcome[]): void {
  const retries = outcomes.filter((outcome) => outcome.kind === 'retry');
  if (retries.length > 0) {
    entry.notBefore = retries
      .map((outcome) => outcome.notBefore)
      .reduce((earliest, next) => (Date.parse(next) < Date.parse(earliest) ? next : earliest));
    return;
  }
  const abandoned = outcomes.find((outcome) => outcome.kind === 'abandoned');
  if (abandoned) {
    entry.status = 'abandoned';
    entry.abandonedReason = abandoned.reason;
    return;
  }
  entry.status = 'done';
}
