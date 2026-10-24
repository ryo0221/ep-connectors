import { describe, expect, it } from 'vitest';
import { runDueJobs } from '@ep-connectors/testing';
import { GITHUB_API, OPERATIONS } from './catalog.js';
import { REPOSITORY_ISSUES } from './documents.js';
import { workItemsScope } from './dto.js';
import { readWorkItems } from './read.js';
import { createGithubReadHandler, syncWorkItems } from './sync.js';
import type { FakeItem } from './test/fake-github.js';
import { ACCESS_TOKEN, githubHarness, T } from './test/harness.js';

const item = (id: string, title: string): FakeItem => ({
  kind: 'issue',
  id,
  number: 1,
  title,
  state: 'OPEN',
  createdAt: T(0),
  updatedAt: T(1),
});

/** 一つの installation に二つの project の repository が入っている。principal-a は repo-a だけを読める。 */
async function arrange() {
  const harness = await githubHarness();
  harness.github.addRepository('R_a', 'acme/app', [item('I_a', 'public plan')]);
  harness.github.addRepository('R_b', 'acme/secret', [item('I_b', 'confidential roadmap')]);
  harness.authorize('R_a', 'acme/app');
  const read = (repositoryId: string) =>
    readWorkItems(
      { policy: harness.policy, sync: harness.sync() },
      harness.connection,
      repositoryId,
    );
  return { ...harness, read };
}

function graphqlRequest(query: string, repositoryId: string) {
  return {
    operation: OPERATIONS.issues,
    method: 'POST' as const,
    url: `${GITHUB_API}/graphql`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      operationName: 'RepositoryIssues',
      variables: { repositoryId, first: 10 },
    }),
  };
}

describe('the fixed GraphQL documents', () => {
  it('sends the registered document for an authorized repository', async () => {
    const { tokens, connection, github } = await arrange();
    const result = await tokens().send(connection, graphqlRequest(REPOSITORY_ISSUES, 'R_a'));
    expect(result.ok && result.response.status).toBe(200);
    expect(github.provider.received[0]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it.each([
    ['an added field', REPOSITORY_ISSUES.replace('id number title', 'id number title body')],
    ['an alias', REPOSITORY_ISSUES.replace('issues(first', 'everything: issues(first')],
    [
      'another repository inside the document',
      REPOSITORY_ISSUES.replace(
        'node(id: $repositoryId)',
        'node(id: $repositoryId) { id } other: node(id: $repositoryId)',
      ),
    ],
  ])('rejects %s under the same operationName', async (_label, query) => {
    const { tokens, connection, github } = await arrange();
    const result = await tokens().send(connection, graphqlRequest(query, 'R_a'));
    expect(result).toEqual({ ok: false, error: { kind: 'catalog', reason: 'graphql-document' } });
    expect(github.provider.received).toHaveLength(0);
  });

  it('does not send a registered document whose repository variable is outside the authorization', async () => {
    const { tokens, connection, github } = await arrange();
    const result = await tokens().send(connection, graphqlRequest(REPOSITORY_ISSUES, 'R_b'));
    expect(result).toEqual({ ok: false, error: { kind: 'policy', reason: 'forbidden' } });
    expect(github.provider.received).toHaveLength(0);
  });

  it('does not probe a repository by a name outside the authorization', async () => {
    const { tokens, connection, github } = await arrange();
    const result = await tokens().send(connection, {
      operation: OPERATIONS.probe,
      method: 'GET',
      url: `${GITHUB_API}/repos/acme/secret/issues?per_page=1`,
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'policy' } });
    expect(github.provider.received).toHaveLength(0);
  });
});

describe('repository authorization inside one installation', () => {
  it('does not fetch an unauthorized repository on request', async () => {
    const { deps, connection, github, read } = await arrange();
    expect(await syncWorkItems(deps(), workItemsScope(connection, 'R_b'))).toEqual({
      kind: 'unavailable',
      reason: 'policy',
    });
    expect(github.provider.received).toHaveLength(0);
    expect(await read('R_b')).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('does not run a read job for an unauthorized repository', async () => {
    const { deps, connection, github, policy, queue, queueBacking } = await arrange();
    await queue().enqueue({
      kind: 'read',
      scope: workItemsScope(connection, 'R_b'),
      expectedGeneration: null,
    });
    await runDueJobs(queueBacking, {
      now: '2026-10-23T00:00:00.000Z',
      policy,
      handler: createGithubReadHandler(deps()),
    });
    expect(queueBacking.jobs[0]).toMatchObject({
      status: 'abandoned',
      abandonedReason: 'forbidden',
    });
    expect(github.provider.received).toHaveLength(0);
  });

  it('stops showing the cached copy once the repository leaves the mapping', async () => {
    const { deps, connection, authorized, read } = await arrange();
    await syncWorkItems(deps(), workItemsScope(connection, 'R_a'));
    expect((await read('R_a')).ok).toBe(true);

    authorized.delete('R_a');
    expect(await read('R_a')).toEqual({ ok: false, reason: 'forbidden' });
    // 再取得も止まる。
    expect(await syncWorkItems(deps(), workItemsScope(connection, 'R_a'))).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('invalidates the copy when GitHub no longer resolves the repository', async () => {
    const { deps, connection, github, sync, clock } = await arrange();
    const scope = workItemsScope(connection, 'R_a');
    await syncWorkItems(deps(), scope);
    github.repositories.delete('R_a');
    clock.advance(6 * 60 * 60 * 1000);
    expect(await syncWorkItems(deps(), scope)).toEqual({
      kind: 'unavailable',
      reason: 'not-found',
    });
    expect(await sync().read(scope)).toBeNull();
  });

  it('checks by node ID and invalidates the copy when the probe is denied', async () => {
    const { deps, connection, github, sync, read, clock } = await arrange();
    const scope = workItemsScope(connection, 'R_a');
    await syncWorkItems(deps(), scope);
    // GitHub 側で権限を失った。Host の対応表には残っている。
    github.repositories.delete('R_a');
    github.failNext('probe', {
      status: 403,
      headers: {},
      body: '{"message":"Resource not accessible by integration"}',
    });
    clock.advance(60_000);
    expect(await syncWorkItems(deps(), scope)).toEqual({
      kind: 'unavailable',
      reason: 'not-found',
    });
    expect(await sync().read(scope)).toBeNull();
    expect(await read('R_a')).toEqual({ ok: false, reason: 'not-synced' });
  });

  it('keeps the installation token out of everything it returns', async () => {
    const { deps, connection, read } = await arrange();
    const outcome = await syncWorkItems(deps(), workItemsScope(connection, 'R_a'));
    const result = await read('R_a');
    expect(JSON.stringify([outcome, result])).not.toContain(ACCESS_TOKEN);
  });
});
