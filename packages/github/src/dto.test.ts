import { describe, expect, it } from 'vitest';
import { graphqlDocumentHash } from '@ep-connectors/core';
import { createGithubCatalog, OPERATIONS } from './catalog.js';
import { REPOSITORY_ISSUES, REPOSITORY_PULL_REQUESTS } from './documents.js';
import { parseWorkItem } from './dto.js';

const node = {
  id: 'I_1',
  number: 1,
  title: 'ok',
  state: 'OPEN',
  stateReason: null,
  url: 'https://github.com/acme/app/issues/1',
  createdAt: '2026-10-22T00:00:00Z',
  updatedAt: '2026-10-22T00:00:00Z',
  closedAt: null,
  author: { login: 'octocat' },
  labels: { totalCount: 25, nodes: [{ name: 'bug', color: 'javascript:' }] },
  assignees: { totalCount: 0, nodes: [] },
  milestone: { title: 'v1', dueOn: null },
};

describe('the catalog', () => {
  it('registers the hash of each fixed document', async () => {
    const catalog = await createGithubCatalog();
    const hash = (name: string) =>
      catalog.operations.find((operation) => operation.name === name)?.graphql?.documentHash;
    expect(hash(OPERATIONS.issues)).toBe(await graphqlDocumentHash(REPOSITORY_ISSUES));
    expect(hash(OPERATIONS.pullRequests)).toBe(await graphqlDocumentHash(REPOSITORY_PULL_REQUESTS));
    expect(catalog.operations.every((operation) => operation.resources?.length === 1)).toBe(true);
  });
});

describe('untrusted values from GitHub', () => {
  it('returns titles as plain text without control or bidirectional characters', () => {
    const item = parseWorkItem('issue', { ...node, title: 'a‮b\u0007c\nd' });
    expect(item.title).toBe('abc\nd');
  });

  it('keeps only github.com URLs and well-formed label colors', () => {
    const item = parseWorkItem('issue', { ...node, url: 'https://evil.test/phish' });
    expect(item.url).toBeNull();
    expect(item.labels).toEqual([{ name: 'bug', color: '' }]);
    expect(item.labelsComplete).toBe(false);
    expect(item.milestone).toEqual({ title: 'v1', dueOn: null });
  });

  it.each([
    ['an unknown state', { state: 'LOCKED' }],
    ['a pull request state on an issue', { state: 'MERGED' }],
    ['a malformed time', { updatedAt: 'yesterday' }],
    ['a missing number', { number: '1' }],
  ])('rejects %s', (_label, change) => {
    expect(() => parseWorkItem('issue', { ...node, ...change })).toThrow();
  });
});
