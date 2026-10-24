import { describe, expect, it } from 'vitest';
import type { CatalogOperation, OperationCatalog } from './catalog.js';
import { checkCatalogRequest, graphqlDocumentHash } from './catalog.js';

const LIST_ISSUES = `
  # 一覧の読取
  query ListIssues($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(first: $first, after: $after) { nodes { id title } }
    }
  }
`;

async function githubCatalog(): Promise<OperationCatalog> {
  return {
    provider: 'github',
    operations: [
      {
        name: 'issues.list',
        method: 'POST',
        origin: 'https://api.github.com',
        path: '/graphql',
        headers: ['content-type'],
        scopes: ['issues:read'],
        auth: 'token',
        graphql: {
          documentHash: await graphqlDocumentHash(LIST_ISSUES),
          kind: 'query',
          variables: {
            owner: { type: 'string', required: true },
            name: { type: 'string', required: true },
            first: { type: 'int', required: true, max: 100 },
            after: { type: 'string', pattern: '^[A-Za-z0-9+/=]+$' },
          },
        },
      },
    ],
  };
}

async function check(body: unknown) {
  return checkCatalogRequest({
    catalog: await githubCatalog(),
    auth: 'token',
    grantedScopes: ['issues:read'],
    request: {
      operation: 'issues.list',
      method: 'POST',
      url: 'https://api.github.com/graphql',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  });
}

const variables = { owner: 'ryo0221', name: 'ep-connectors', first: 20 };

describe('GraphQL operations in the catalog', () => {
  it('accepts the registered document regardless of whitespace and comments', async () => {
    const reformatted = LIST_ISSUES.replace('# 一覧の読取', '').replace(/\s+/g, '  ');
    expect((await check({ query: reformatted, variables, operationName: 'ListIssues' })).ok).toBe(
      true,
    );
  });

  it.each([
    ['an extra field', LIST_ISSUES.replace('id title', 'id title body')],
    ['an alias', LIST_ISSUES.replace('issues(', 'all: issues(')],
    [
      'a mutation under the same name',
      LIST_ISSUES.replace('query ListIssues', 'mutation ListIssues'),
    ],
  ])('rejects a document with %s under the same operationName', async (_label, query) => {
    expect(await check({ query, variables, operationName: 'ListIssues' })).toMatchObject({
      ok: false,
      reason: 'graphql-document',
    });
  });

  it.each([
    ['a missing required variable', { owner: 'ryo0221', first: 20 }],
    ['an unknown variable', { ...variables, extra: 'x' }],
    ['a count over the limit', { ...variables, first: 101 }],
    ['a wrong type', { ...variables, first: '20' }],
    ['a cursor of the wrong form', { ...variables, after: '"}injected' }],
  ])('rejects %s', async (_label, vars) => {
    expect(await check({ query: LIST_ISSUES, variables: vars })).toMatchObject({
      ok: false,
      reason: 'graphql-variables',
    });
  });

  it('rejects extra top-level keys in the body', async () => {
    expect(await check({ query: LIST_ISSUES, variables, extensions: {} })).toMatchObject({
      ok: false,
      reason: 'graphql-document',
    });
  });
});

describe('path and origin matching', () => {
  const catalog: OperationCatalog = {
    provider: 'google',
    operations: [
      {
        name: 'events.list',
        method: 'GET',
        origin: 'https://www.googleapis.com',
        path: '/calendar/v3/calendars/{calendarId}/events',
        query: ['pageToken', 'syncToken', 'timeMin', 'timeMax'],
        scopes: ['calendar.readonly'],
        auth: 'token',
      },
    ],
  };
  const run = (url: string) =>
    checkCatalogRequest({
      catalog,
      auth: 'token',
      grantedScopes: ['calendar.readonly'],
      request: { operation: 'events.list', method: 'GET', url },
    });

  it('accepts an encoded calendar ID in one segment', async () => {
    expect(
      (
        await run(
          'https://www.googleapis.com/calendar/v3/calendars/a%40example.com/events?pageToken=x',
        )
      ).ok,
    ).toBe(true);
  });

  it.each([
    'https://www.googleapis.com.evil.test/calendar/v3/calendars/a/events',
    'https://www.googleapis.com/calendar/v3/calendars/a/events#fragment',
    'https://www.googleapis.com/calendar/v3/calendars//events',
    'https://www.googleapis.com/calendar/v3/calendars/a/b/events',
    'https://www.googleapis.com/calendar/v3/calendars/%E0%A4%A/events',
  ])('rejects %s', async (url) => {
    expect((await run(url)).ok).toBe(false);
  });
});

describe('resources bound to a request', () => {
  const catalog: OperationCatalog = {
    provider: 'github',
    operations: [
      {
        name: 'issues.probe',
        method: 'GET',
        origin: 'https://api.github.com',
        path: '/repos/{owner}/{repo}/issues',
        scopes: ['issues:read'],
        auth: 'token',
        resources: [{ kind: 'github.repository-name', path: ['owner', 'repo'] }],
      },
      {
        name: 'issues.node',
        method: 'POST',
        origin: 'https://api.github.com',
        path: '/graphql',
        headers: ['content-type'],
        scopes: ['issues:read'],
        auth: 'token',
        graphql: {
          documentHash: '',
          kind: 'query',
          variables: { repositoryId: { type: 'string' } },
        },
        resources: [{ kind: 'github.repository', variable: 'repositoryId' }],
      },
    ],
  };
  const node = 'query Node($repositoryId: ID!) { node(id: $repositoryId) { id } }';

  async function withHash(): Promise<OperationCatalog> {
    const [probe, graphql] = catalog.operations as [CatalogOperation, CatalogOperation];
    return {
      ...catalog,
      operations: [
        probe,
        {
          ...graphql,
          graphql: { ...graphql.graphql!, documentHash: await graphqlDocumentHash(node) },
        },
      ],
    };
  }

  it('returns the decoded path values as one resource', async () => {
    const result = await checkCatalogRequest({
      catalog,
      auth: 'token',
      grantedScopes: ['issues:read'],
      request: {
        operation: 'issues.probe',
        method: 'GET',
        url: 'https://api.github.com/repos/ryo0221/ep-connectors/issues',
      },
    });
    expect(result).toMatchObject({
      ok: true,
      resources: [{ kind: 'github.repository-name', id: 'ryo0221/ep-connectors' }],
    });
  });

  it('returns a GraphQL variable as the resource', async () => {
    const request = (variables: unknown) => ({
      operation: 'issues.node',
      method: 'POST' as const,
      url: 'https://api.github.com/graphql',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: node, variables }),
    });
    const input = {
      catalog: await withHash(),
      auth: 'token' as const,
      grantedScopes: ['issues:read'],
    };
    expect(
      await checkCatalogRequest({ ...input, request: request({ repositoryId: 'R_1' }) }),
    ).toMatchObject({ ok: true, resources: [{ kind: 'github.repository', id: 'R_1' }] });
    // 資源を取り出せない要求は、認可を問えないため送らない。
    expect(await checkCatalogRequest({ ...input, request: request({}) })).toMatchObject({
      ok: false,
      reason: 'resource',
    });
  });

  it('returns a query value as the resource only when it is given once', async () => {
    const sheets: OperationCatalog = {
      provider: 'google-sheets',
      operations: [
        {
          name: 'values.batchGet',
          method: 'GET',
          origin: 'https://sheets.googleapis.com',
          path: '/v4/spreadsheets/{spreadsheetId}/values:batchGet',
          query: ['ranges'],
          scopes: ['sheets'],
          auth: 'token',
          resources: [
            { kind: 'sheet', path: ['spreadsheetId'] },
            { kind: 'range', query: 'ranges' },
          ],
        },
      ],
    };
    const check = (query: string) =>
      checkCatalogRequest({
        catalog: sheets,
        auth: 'token',
        grantedScopes: ['sheets'],
        request: {
          operation: 'values.batchGet',
          method: 'GET',
          url: `https://sheets.googleapis.com/v4/spreadsheets/abc/values:batchGet${query}`,
        },
      });
    expect(await check('?ranges=Sheet1%21A1%3AB2')).toMatchObject({
      ok: true,
      resources: [
        { kind: 'sheet', id: 'abc' },
        { kind: 'range', id: 'Sheet1!A1:B2' },
      ],
    });
    expect(await check('')).toMatchObject({ ok: false, reason: 'resource' });
    expect(await check('?ranges=A1&ranges=B2')).toMatchObject({ ok: false, reason: 'resource' });
  });
});

describe('fixed query parameters', () => {
  const catalog: OperationCatalog = {
    provider: 'google',
    operations: [
      {
        name: 'events.list',
        method: 'GET',
        origin: 'https://www.googleapis.com',
        path: '/calendar/v3/calendars/{calendarId}/events',
        query: ['pageToken'],
        fixedQuery: { fields: 'items(id),nextPageToken' },
        scopes: ['calendar.readonly'],
        auth: 'token',
      },
    ],
  };
  const run = (query: string) =>
    checkCatalogRequest({
      catalog,
      auth: 'token',
      grantedScopes: ['calendar.readonly'],
      request: {
        operation: 'events.list',
        method: 'GET',
        url: `https://www.googleapis.com/calendar/v3/calendars/primary/events${query}`,
      },
    });
  const fields = encodeURIComponent('items(id),nextPageToken');

  it('accepts the declared value exactly once', async () => {
    expect((await run(`?fields=${fields}&pageToken=x`)).ok).toBe(true);
  });

  it.each([
    ['missing', '?pageToken=x'],
    ['a different value', `?fields=${encodeURIComponent('items')}`],
    ['given twice', `?fields=${fields}&fields=${fields}`],
  ])('rejects a request with the fixed parameter %s', async (_label, query) => {
    expect(await run(query)).toMatchObject({ ok: false, reason: 'fixed-query' });
  });
});
