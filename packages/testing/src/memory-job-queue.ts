import type { EnqueueOptions, HostPolicy, JobHandler, JobQueue, JobRef } from '@ep-connectors/core';

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
    due.flatMap((entry) =>
      Array.from({ length: options.deliveries ?? 1 }, () => deliver(entry, options)),
    ),
  );
}

async function deliver(entry: QueuedJob, options: RunDueOptions): Promise<void> {
  const job = structuredClone(entry.job);
  const decision = await options.policy.authorizeDispatch(job);
  if (!decision.ok) {
    entry.status = 'abandoned';
    entry.abandonedReason = decision.reason;
    return;
  }
  const outcome = await options.handler(job);
  if (entry.status !== 'pending') return;
  if (outcome.kind === 'done') entry.status = 'done';
  else if (outcome.kind === 'retry') entry.notBefore = outcome.notBefore;
  else {
    entry.status = 'abandoned';
    entry.abandonedReason = outcome.reason;
  }
}
