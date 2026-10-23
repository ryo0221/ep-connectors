import { describe, expect, it } from 'vitest';
import type { InboundWebhook } from '@ep-connectors/core';
import { runDueJobs } from '@ep-connectors/testing';
import { workItemsScope } from './dto.js';
import { readWorkItems } from './read.js';
import { createGithubReadHandler } from './sync.js';
import type { FakeItem } from './test/fake-github.js';
import { githubHarness, T } from './test/harness.js';
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  GithubWebhookIntake,
  githubSignature,
  SIGNATURE_HEADER,
  workItemsJob,
} from './webhook.js';

const SECRET = 'webhook-secret';

async function arrange() {
  const harness = await githubHarness();
  const repository = harness.github.addRepository('R_a', 'acme/app', [
    {
      kind: 'issue',
      id: 'I_1',
      number: 1,
      title: 'current title',
      state: 'OPEN',
      createdAt: T(0),
      updatedAt: T(10),
    },
  ]);
  harness.authorize('R_a', 'acme/app');
  const deliveries = new Set<string>();
  const intake = new GithubWebhookIntake({
    secret: async () => SECRET,
    resolve: async (installationId, repositoryId) =>
      installationId === 1 && harness.authorized.has(repositoryId)
        ? { connection: harness.connection, subscription: 'installation-1' }
        : null,
    recordDelivery: async (deliveryId) => {
      if (deliveries.has(deliveryId)) return false;
      deliveries.add(deliveryId);
      return true;
    },
  });
  return { ...harness, repository, intake };
}

async function webhook(
  payload: unknown,
  deliveryId: string,
  secret = SECRET,
): Promise<InboundWebhook> {
  const body = JSON.stringify(payload);
  return {
    headers: {
      [SIGNATURE_HEADER]: await githubSignature(secret, body),
      [DELIVERY_HEADER]: deliveryId,
      [EVENT_HEADER]: 'issues',
    },
    body,
    receivedAt: '2026-10-23T00:00:00.000Z',
  };
}

const issueEdited = (title: string) => ({
  action: 'edited',
  installation: { id: 1 },
  repository: { node_id: 'R_a', full_name: 'acme/app' },
  issue: { node_id: 'I_1', title, updated_at: T(1) },
});

describe('a change that the ETag probe cannot see', () => {
  it('is read on the webhook signal even while the probe returns 304', async () => {
    const harness = await githubHarness();
    const { github, deps, policy, queue, queueBacking, sync, connection, clock } = harness;
    const minutesAgo = (minutes: number) =>
      new Date(Date.parse(clock.now()) - minutes * 60_000).toISOString();
    const base = {
      kind: 'issue' as const,
      state: 'OPEN' as const,
      createdAt: minutesAgo(60),
    };
    const repository = github.addRepository('R_a', 'acme/app', [
      { ...base, id: 'I_A', number: 1, title: 'A', updatedAt: minutesAgo(1) },
      { ...base, id: 'I_B', number: 2, title: 'B', updatedAt: minutesAgo(10) },
    ]);
    harness.authorize('R_a', 'acme/app');
    const handler = createGithubReadHandler(deps());
    const read = () => readWorkItems({ policy, sync: sync() }, connection, 'R_a');
    const titleOfB = async () => {
      const result = await read();
      return result.ok ? result.items.find((item) => item.id === 'I_B')?.title : undefined;
    };
    const job = {
      kind: 'read' as const,
      scope: workItemsScope(connection, 'R_a'),
      expectedGeneration: null,
    };

    // 全件を読み、次の照会で ETag を得る。
    await handler(job);
    await handler(job);

    // 先頭ではない B が変わり、更新の新しい順の先頭一件（A）の表現は変わらない。
    const b = repository.items.find((item) => item.id === 'I_B') as FakeItem;
    b.title = 'B edited';
    b.updatedAt = minutesAgo(2);

    // 定期の再取得は 304 で何も読まない。
    const graphqlBefore = github.graphqlCalls().length;
    expect(await handler(job)).toEqual({ kind: 'done' });
    expect(github.probeCalls().at(-1)).toBeDefined();
    expect(github.graphqlCalls()).toHaveLength(graphqlBefore);
    expect(await titleOfB()).toBe('B');

    // Webhook の合図による再取得は照会を省き、合図の時刻から遡って読む。
    const request = await webhook(
      { action: 'edited', installation: { id: 1 }, repository: { node_id: 'R_a' } },
      'd-b',
    );
    const intake = new GithubWebhookIntake({
      secret: async () => SECRET,
      resolve: async () => ({ connection, subscription: 'installation-1' }),
      recordDelivery: async () => true,
    });
    const verified = await intake.verify({ ...request, receivedAt: clock.now() });
    if (!verified.ok) throw new Error(verified.reason);
    await queue().enqueue(workItemsJob(verified.signal, clock.now()));
    const probesBefore = github.probeCalls().length;
    await runDueJobs(queueBacking, { now: clock.now(), policy, handler });
    expect(github.probeCalls()).toHaveLength(probesBefore);
    expect(await titleOfB()).toBe('B edited');
  });
});

describe('GitHub webhooks', () => {
  it('turns a signed delivery into a signal for the repository', async () => {
    const { intake, connection } = await arrange();
    expect(await intake.verify(await webhook(issueEdited('x'), 'd-1'))).toEqual({
      ok: true,
      signal: { connection, subscription: 'installation-1', target: 'R_a', deliveryId: 'd-1' },
    });
  });

  it('rejects a forged signature without spending the delivery ID', async () => {
    const { intake } = await arrange();
    expect(await intake.verify(await webhook(issueEdited('x'), 'd-1', 'wrong'))).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    expect((await intake.verify(await webhook(issueEdited('x'), 'd-1'))).ok).toBe(true);
  });

  it('handles a redelivery only once', async () => {
    const { intake } = await arrange();
    const request = await webhook(issueEdited('x'), 'd-1');
    expect((await intake.verify(request)).ok).toBe(true);
    expect(await intake.verify(request)).toEqual({ ok: false, reason: 'duplicate-delivery' });
  });

  it('ignores a repository outside the mapping', async () => {
    const { intake } = await arrange();
    const payload = { ...issueEdited('x'), repository: { node_id: 'R_b' } };
    expect(await intake.verify(await webhook(payload, 'd-1'))).toEqual({
      ok: false,
      reason: 'unknown-subscription',
    });
  });

  it('refetches on the signal, so a late old notification cannot overwrite the current state', async () => {
    const { intake, deps, policy, queue, queueBacking, sync, connection } = await arrange();
    // 古い通知（本文の title は古い）が後から届いても、本文は使わず GitHub から読み直す。
    for (const [title, id] of [
      ['newer title', 'd-2'],
      ['stale title', 'd-1'],
      ['newer title', 'd-2'],
    ] as const) {
      const request = await webhook(issueEdited(title), id);
      const verified = await intake.verify(request);
      if (verified.ok) await queue().enqueue(workItemsJob(verified.signal, request.receivedAt));
    }
    expect(queueBacking.jobs).toHaveLength(2);
    await runDueJobs(queueBacking, {
      now: '2026-10-23T00:00:00.000Z',
      policy,
      handler: createGithubReadHandler(deps()),
    });
    const result = await readWorkItems({ policy, sync: sync() }, connection, 'R_a');
    expect(result.ok && result.items.map((item) => item.title)).toEqual(['current title']);
  });
});
