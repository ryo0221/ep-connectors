import { describe, expect, it } from 'vitest';
import { runDueJobs } from '@ep-connectors/testing';
import { workItemsScope } from './dto.js';
import { readWorkItems } from './read.js';
import { createGithubReadHandler, syncWorkItems } from './sync.js';
import type { FakeItem } from './test/fake-github.js';
import { githubHarness, T } from './test/harness.js';

const issue = (number: number, minute: number, extra: Partial<FakeItem> = {}): FakeItem => ({
  kind: 'issue',
  id: `I_${number}`,
  number,
  title: `Issue ${number}`,
  state: 'OPEN',
  createdAt: T(0),
  updatedAt: T(minute),
  ...extra,
});

const pull = (number: number, minute: number, extra: Partial<FakeItem> = {}): FakeItem => ({
  kind: 'pullRequest',
  id: `PR_${number}`,
  number,
  title: `Pull ${number}`,
  state: 'OPEN',
  createdAt: T(0),
  updatedAt: T(minute),
  ...extra,
});

async function arrange(options: Parameters<typeof githubHarness>[0] = {}) {
  const harness = await githubHarness(options);
  const repository = harness.github.addRepository('R_a', 'acme/app', [
    issue(1, 10, { labels: ['bug'], assignees: ['alice'] }),
    issue(2, 20, { state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: T(20) }),
    pull(3, 30, { state: 'MERGED', mergedAt: T(30), closedAt: T(30) }),
    pull(4, 5, { isDraft: true }),
  ]);
  harness.authorize('R_a', 'acme/app');
  const scope = workItemsScope(harness.connection, 'R_a');
  const read = () =>
    readWorkItems({ policy: harness.policy, sync: harness.sync() }, harness.connection, 'R_a');
  return { ...harness, repository, scope, read };
}

describe('the first sync', () => {
  it('reads every issue and pull request by the repository node ID and publishes them together', async () => {
    const { deps, scope, read, github } = await arrange();
    expect(await syncWorkItems(deps(), scope)).toMatchObject({
      kind: 'published',
      mode: 'full',
      fetched: 4,
    });
    // 名前をまだ知らないので ETag の照会はせず、GraphQL だけで読む。
    expect(github.probeCalls()).toHaveLength(0);
    expect(github.graphqlCalls()).toHaveLength(2);

    const result = await read();
    if (!result.ok) throw new Error(result.reason);
    expect(result.items.map((item) => item.id)).toEqual(['PR_3', 'I_2', 'I_1', 'PR_4']);
    expect(result.items[1]).toMatchObject({
      kind: 'issue',
      state: 'closed',
      stateReason: 'notPlanned',
      closedAt: T(20),
    });
    expect(result.items[0]).toMatchObject({
      kind: 'pullRequest',
      state: 'merged',
      mergedAt: T(30),
    });
    expect(result.items[3]).toMatchObject({ draft: true, stateReason: null });
    expect(result.items[2]).toMatchObject({
      labels: [{ name: 'bug', color: 'd73a4a' }],
      labelsComplete: true,
      assignees: ['alice'],
    });
    expect(result.provenance).toMatchObject({
      repository: { id: 'R_a', nameWithOwner: 'acme/app' },
      fetchedAt: '2026-10-23T00:00:00.000Z',
      fullReconciledAt: '2026-10-23T00:00:00.000Z',
      etag: null,
    });
    expect(result.provenance.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('follows GraphQL cursors until the last page', async () => {
    const { deps, scope, read, repository, github } = await arrange({ pageSize: 2 });
    repository.items.push(issue(5, 1), issue(6, 2), issue(7, 3));
    await syncWorkItems(deps(), scope);
    // Issue 5 件で 3 ページ、Pull Request 2 件で 1 ページ。
    expect(github.graphqlCalls()).toHaveLength(4);
    const result = await read();
    expect(result.ok && result.items).toHaveLength(7);
  });
});

describe('change detection with the ETag', () => {
  it('skips GraphQL entirely while the conditional probe returns 304', async () => {
    const { deps, scope, github, clock } = await arrange();
    await syncWorkItems(deps(), scope);
    // 全件の照合の直後は ETag を持たない。一度目の照会で ETag を得て、差分を読む。
    clock.advance(60_000);
    expect(await syncWorkItems(deps(), scope)).toMatchObject({ kind: 'published', mode: 'delta' });
    const graphqlBefore = github.graphqlCalls().length;

    clock.advance(60_000);
    const unchanged = await syncWorkItems(deps(), scope);
    expect(unchanged.kind).toBe('unchanged');
    expect(github.graphqlCalls()).toHaveLength(graphqlBefore);
    const lastProbe = github.probeCalls().at(-1);
    expect(lastProbe?.headers['if-none-match']).toBe('W/"PR_3@' + T(30) + '"');
    expect(new URL(lastProbe?.url ?? '').searchParams.get('sort')).toBe('updated');
  });

  it('reads only the items updated since the base and stops paging there', async () => {
    const { deps, scope, read, repository, github, clock } = await arrange({ pageSize: 1 });
    repository.items.push(issue(5, 1), issue(6, 2), issue(7, 3));
    await syncWorkItems(deps(), scope);
    clock.advance(60_000);
    await syncWorkItems(deps(), scope);

    const target = repository.items.find((item) => item.id === 'I_1') as FakeItem;
    target.title = 'Issue 1 renamed';
    target.updatedAt = T(40);
    const before = github.graphqlCalls().length;
    clock.advance(60_000);
    expect(await syncWorkItems(deps(), scope)).toMatchObject({
      kind: 'published',
      mode: 'delta',
      // 基点と同じ時刻の item（PR_3）は取り直す。同じ時刻の更新を取りこぼさないため。
      fetched: 2,
    });
    // Issue も Pull Request も、基点より古い item が現れた 2 ページ目で止まる（全 7 件は読まない）。
    expect(github.graphqlCalls().length - before).toBe(4);
    const result = await read();
    if (!result.ok) throw new Error(result.reason);
    expect(result.items[0]).toMatchObject({ id: 'I_1', title: 'Issue 1 renamed' });
    expect(result.items).toHaveLength(7);
  });

  it('drops deleted or transferred items at the periodic full reconciliation, not in a delta', async () => {
    const { deps, scope, read, repository, clock } = await arrange({
      fullReconcileIntervalMs: 60 * 60 * 1000,
    });
    await syncWorkItems(deps(), scope);
    repository.items = repository.items.filter((item) => item.id !== 'I_2');
    repository.items.push(issue(9, 50));

    clock.advance(60_000);
    await syncWorkItems(deps(), scope);
    let result = await read();
    expect(result.ok && result.items.map((item) => item.id)).toContain('I_2');

    clock.advance(60 * 60 * 1000);
    expect(await syncWorkItems(deps(), scope)).toMatchObject({ kind: 'published', mode: 'full' });
    result = await read();
    expect(result.ok && result.items.map((item) => item.id)).not.toContain('I_2');
    expect(result.ok && result.provenance.fullReconciledAt).toBe(clock.now());
  });

  it('reads the repository again by node ID after a rename', async () => {
    const { deps, scope, read, repository, authorize, clock } = await arrange();
    await syncWorkItems(deps(), scope);
    repository.formerNames.push('acme/app');
    repository.nameWithOwner = 'acme/renamed';
    authorize('R_a', 'acme/renamed');

    clock.advance(60_000);
    expect(await syncWorkItems(deps(), scope)).toMatchObject({ kind: 'published', mode: 'full' });
    const result = await read();
    expect(result.ok && result.provenance.repository.nameWithOwner).toBe('acme/renamed');
  });
});

describe('incomplete reads', () => {
  const RESET = '2026-10-23T07:00:00.000Z';
  const rateLimited = {
    status: 403,
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Date.parse(RESET) / 1000),
    },
    body: '{"message":"API rate limit exceeded"}',
  };

  it('keeps the published copy when the rate limit stops pagination halfway', async () => {
    const { deps, scope, read, repository, github, clock } = await arrange({ pageSize: 1 });
    await syncWorkItems(deps(), scope);
    const before = await read();

    repository.items = repository.items.filter((item) => item.id !== 'I_1');
    clock.advance(6 * 60 * 60 * 1000); // 全件の照合の時期
    github.failNext('graphql', rateLimited, 1);
    expect(await syncWorkItems(deps(), scope)).toEqual({
      kind: 'incomplete',
      reason: 'rate-limited',
      notBefore: RESET,
    });
    // 取れなかった範囲を空や削除として扱わず、前の写しをそのまま見せる。
    expect(await read()).toEqual(before);
  });

  it('treats a GraphQL RATE_LIMITED error as incomplete and honours Retry-After', async () => {
    const { deps, scope, read, github } = await arrange();
    github.failNext('graphql', {
      status: 200,
      headers: { 'retry-after': '120' },
      body: JSON.stringify({ data: null, errors: [{ type: 'RATE_LIMITED' }] }),
    });
    expect(await syncWorkItems(deps(), scope)).toEqual({
      kind: 'incomplete',
      reason: 'rate-limited',
      notBefore: '2026-10-23T00:02:00.000Z',
    });
    expect(await read()).toEqual({ ok: false, reason: 'not-synced' });
  });

  it('hands the wait to the JobQueue as a retry', async () => {
    const { deps, scope, github, policy, queue, queueBacking } = await arrange();
    github.failNext('graphql', rateLimited);
    await queue().enqueue({ kind: 'read', scope, expectedGeneration: null });
    await runDueJobs(queueBacking, {
      now: '2026-10-23T00:00:00.000Z',
      policy,
      handler: createGithubReadHandler(deps()),
    });
    expect(queueBacking.jobs[0]).toMatchObject({ status: 'pending', notBefore: RESET });
  });

  it('publishes nothing when a node has a shape it does not know', async () => {
    const { deps, scope, read, repository } = await arrange();
    repository.items.push(issue(9, 1, { state: 'LOCKED' as FakeItem['state'] }));
    expect(await syncWorkItems(deps(), scope)).toEqual({
      kind: 'unavailable',
      reason: 'malformed',
    });
    expect(await read()).toEqual({ ok: false, reason: 'not-synced' });
  });
});

describe('duplicate and concurrent reads', () => {
  it('publishes one generation when the same read job is delivered twice at once', async () => {
    const { deps, scope, policy, queue, queueBacking, sync, syncBacking } = await arrange();
    await queue().enqueue({ kind: 'read', scope, expectedGeneration: null });
    await runDueJobs(queueBacking, {
      now: '2026-10-23T00:00:00.000Z',
      policy,
      handler: (job) => createGithubReadHandler(deps())(job),
      deliveries: 2,
    });
    const published = await sync().read(scope);
    expect(published?.entries).toHaveLength(4);
    // 二つの staging のうち公開されたのは一つだけで、もう一つは公開されずに残る。
    expect(syncBacking.nextGeneration - 1).toBe(2);
    expect(published?.generation).toBeLessThanOrEqual(2);
    expect(queueBacking.jobs[0]?.status).toBe('done');
  });

  it('loses the CAS instead of overwriting a newer generation', async () => {
    const { deps, scope, sync } = await arrange();
    const first = syncWorkItems(deps(), scope);
    const second = syncWorkItems(deps(), scope);
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['published', 'superseded']);
    const winner = outcomes.find((outcome) => outcome.kind === 'published');
    expect((await sync().read(scope))?.generation).toBe(
      winner?.kind === 'published' ? winner.generation : -1,
    );
  });
});
