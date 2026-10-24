import type { CatalogOperation, GraphqlVariableRule, OperationCatalog } from '@ep-connectors/core';
import { graphqlDocumentHash } from '@ep-connectors/core';
import { REPOSITORY_ISSUES, REPOSITORY_PULL_REQUESTS } from './documents.js';

export const GITHUB_PROVIDER = 'github';
/** GitHub.com の API。GitHub Enterprise Server は対象にするかを決めていない（設計の 5）。 */
export const GITHUB_API = 'https://api.github.com';

/** 資源の種類。Host はこの二つを同じ repository の別の識別として認可の対応表に持つ。 */
export const REPOSITORY_RESOURCE = 'github.repository';
/** `owner/name`。ETag の照会（REST）だけが使う。Rename の後は Host の対応表と合わなくなる。 */
export const REPOSITORY_NAME_RESOURCE = 'github.repository-name';

/** App の権限。目録の scope として connection の権限と照合する。 */
export const ISSUES_READ = 'issues:read';
export const PULL_REQUESTS_READ = 'pull_requests:read';

export const OPERATIONS = {
  issues: 'graphql.repositoryIssues',
  pullRequests: 'graphql.repositoryPullRequests',
  probe: 'rest.issues.probe',
} as const;

const PAGE_VARIABLES: Readonly<Record<string, GraphqlVariableRule>> = {
  repositoryId: { type: 'string', required: true, pattern: '^[A-Za-z0-9_=-]{1,128}$' },
  first: { type: 'int', required: true, max: 100 },
  after: { type: 'string', pattern: '^[A-Za-z0-9+/=_-]{1,256}$' },
};

async function graphqlPage(
  name: string,
  document: string,
  scope: string,
): Promise<CatalogOperation> {
  return {
    name,
    method: 'POST',
    origin: GITHUB_API,
    path: '/graphql',
    headers: ['content-type', 'accept'],
    scopes: [scope],
    auth: 'token',
    graphql: {
      documentHash: await graphqlDocumentHash(document),
      kind: 'query',
      variables: PAGE_VARIABLES,
    },
    resources: [{ kind: REPOSITORY_RESOURCE, variable: 'repositoryId' }],
  };
}

/**
 * GitHub の読取の操作の目録。Host は信頼できる側でこれを一度作って `TokenStore` へ渡し、adapter の
 * 実行時の申告で操作を増やさない。
 */
export async function createGithubCatalog(): Promise<OperationCatalog> {
  return {
    provider: GITHUB_PROVIDER,
    operations: [
      await graphqlPage(OPERATIONS.issues, REPOSITORY_ISSUES, ISSUES_READ),
      await graphqlPage(OPERATIONS.pullRequests, REPOSITORY_PULL_REQUESTS, PULL_REQUESTS_READ),
      {
        // GraphQL は条件付き要求に対応しないため、変化の有無だけを REST の ETag で照会する。
        // Issue の一覧は Pull Request も含み、更新の新しい順の先頭一件が変われば ETag が変わる。
        name: OPERATIONS.probe,
        method: 'GET',
        origin: GITHUB_API,
        path: '/repos/{owner}/{repo}/issues',
        query: ['state', 'sort', 'direction', 'per_page'],
        headers: ['accept', 'if-none-match', 'x-github-api-version'],
        scopes: [ISSUES_READ],
        auth: 'token',
        resources: [{ kind: REPOSITORY_NAME_RESOURCE, path: ['owner', 'repo'] }],
      },
    ],
  };
}
