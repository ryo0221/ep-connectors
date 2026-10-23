import type { HttpResponse } from '@ep-connectors/core';
import { FakeProvider, json, type ReceivedRequest } from '@ep-connectors/testing';
import { GITHUB_API } from '../catalog.js';

export interface FakeItem {
  kind: 'issue' | 'pullRequest';
  id: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  stateReason?: string | null;
  isDraft?: boolean;
  url?: string;
  author?: string | null;
  labels?: string[];
  assignees?: string[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  mergedAt?: string | null;
}

export interface FakeRepository {
  id: string;
  nameWithOwner: string;
  /** Rename の前の名前。REST は 301 で新しい場所へ誘導する。 */
  formerNames: string[];
  items: FakeItem[];
}

type Override = (request: ReceivedRequest) => HttpResponse | undefined;

/**
 * 決定的な偽の GitHub。確認した前提（設計の「事実（要確認）」）だけを再現する。
 * - GraphQL は `node(id:)` で repository を引き、更新の新しい順に cursor でページを返す。
 *   読めない node は `data.node: null` と `NOT_FOUND` の error を返す。
 * - REST の Issue の一覧は Pull Request も含み、ETag を返し、`If-None-Match` が一致すれば 304。
 *   Rename の前の名前には 301 を返す。
 */
export class FakeGithub {
  readonly provider = new FakeProvider();
  readonly repositories = new Map<string, FakeRepository>();
  private readonly overrides: Override[] = [];

  constructor() {
    this.provider
      .route('POST', `${GITHUB_API}/graphql`, (request) => this.graphql(request))
      .route('GET', `${GITHUB_API}/repos/{owner}/{repo}/issues`, (request, params) =>
        this.probe(request, `${params.owner}/${params.repo}`),
      );
  }

  addRepository(id: string, nameWithOwner: string, items: FakeItem[] = []): FakeRepository {
    const repository = { id, nameWithOwner, formerNames: [], items };
    this.repositories.set(id, repository);
    return repository;
  }

  /** `match` に当たる要求を `skip` 件通した次の一件に、`response` を返す。 */
  failNext(match: 'graphql' | 'probe', response: HttpResponse, skip = 0): void {
    let remaining = skip;
    const override: Override = (request) => {
      const isGraphql = new URL(request.url).pathname === '/graphql';
      if (isGraphql !== (match === 'graphql')) return undefined;
      if (remaining > 0) {
        remaining -= 1;
        return undefined;
      }
      this.overrides.splice(this.overrides.indexOf(override), 1);
      return response;
    };
    this.overrides.push(override);
  }

  graphqlCalls(): ReceivedRequest[] {
    return this.provider.received.filter((request) => new URL(request.url).pathname === '/graphql');
  }

  probeCalls(): ReceivedRequest[] {
    return this.provider.received.filter((request) => request.method === 'GET');
  }

  private override(request: ReceivedRequest): HttpResponse | undefined {
    for (const override of [...this.overrides]) {
      const response = override(request);
      if (response) return response;
    }
    return undefined;
  }

  private graphql(request: ReceivedRequest): HttpResponse {
    const overridden = this.override(request);
    if (overridden) return overridden;
    const body = JSON.parse(request.body ?? '{}') as {
      query: string;
      variables: { repositoryId: string; first: number; after?: string | null };
    };
    const repository = this.repositories.get(body.variables.repositoryId);
    if (!repository) {
      return json(200, {
        data: { node: null },
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }],
      });
    }
    const kind = body.query.includes('pullRequests(') ? 'pullRequest' : 'issue';
    const sorted = repository.items
      .filter((item) => item.kind === kind)
      .sort((a, b) =>
        a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : a.updatedAt < b.updatedAt ? 1 : -1,
      );
    const start = body.variables.after ? Number(atob(body.variables.after)) : 0;
    const nodes = sorted.slice(start, start + body.variables.first);
    const end = start + nodes.length;
    return json(200, {
      data: {
        node: {
          id: repository.id,
          nameWithOwner: repository.nameWithOwner,
          [kind === 'issue' ? 'issues' : 'pullRequests']: {
            pageInfo: { hasNextPage: end < sorted.length, endCursor: btoa(String(end)) },
            nodes: nodes.map((item) => graphqlNode(item)),
          },
        },
      },
    });
  }

  private probe(request: ReceivedRequest, nameWithOwner: string): HttpResponse {
    const overridden = this.override(request);
    if (overridden) return overridden;
    const repositories = [...this.repositories.values()];
    const repository = repositories.find((candidate) => candidate.nameWithOwner === nameWithOwner);
    if (!repository) {
      const moved = repositories.find((candidate) => candidate.formerNames.includes(nameWithOwner));
      return moved
        ? {
            status: 301,
            headers: { location: `${GITHUB_API}/repositories/1/issues` },
            body: '',
          }
        : json(404, { message: 'Not Found' });
    }
    const top = [...repository.items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const etag = `W/"${top ? `${top.id}@${top.updatedAt}` : 'empty'}"`;
    if (request.headers['if-none-match'] === etag)
      return { status: 304, headers: { etag }, body: '' };
    return json(200, top ? [{ node_id: top.id }] : [], { etag });
  }
}

function graphqlNode(item: FakeItem) {
  const labels = item.labels ?? [];
  const assignees = item.assignees ?? [];
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    state: item.state,
    ...(item.kind === 'issue'
      ? { stateReason: item.stateReason ?? null }
      : { isDraft: item.isDraft ?? false, mergedAt: item.mergedAt ?? null }),
    url: item.url ?? `https://github.com/acme/app/issues/${item.number}`,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    closedAt: item.closedAt ?? null,
    author: item.author === null ? null : { login: item.author ?? 'octocat' },
    labels: {
      totalCount: labels.length,
      nodes: labels.slice(0, 20).map((name) => ({ name, color: 'd73a4a' })),
    },
    assignees: {
      totalCount: assignees.length,
      nodes: assignees.slice(0, 10).map((login) => ({ login })),
    },
    milestone: null,
  };
}
