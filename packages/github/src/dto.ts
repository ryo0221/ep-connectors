import type { SyncScope } from '@ep-connectors/core';
import { canonicalJson } from '@ep-connectors/core';

/**
 * Issue / Pull Request の一覧の一行（R1 の読取の DTO）。表・Kanban・Timeline の行として読む。
 * GitHub 上で変わり続ける値の、取得した時点の写しである（設計 1.1）。本文は R1 では読まない。
 */
export type GithubWorkItem = {
  kind: 'issue' | 'pullRequest';
  /** GraphQL の node ID。 */
  id: string;
  number: number;
  /** 制御文字と双方向の書式文字を除いた plain text。 */
  title: string;
  state: 'open' | 'closed' | 'merged';
  /** Issue の閉じた理由。Pull Request と、理由のない Issue では `null`。 */
  stateReason: 'completed' | 'notPlanned' | 'reopened' | 'duplicate' | null;
  draft: boolean;
  /** `https://github.com/` の URL だけを残す。自動で開かない。 */
  url: string | null;
  author: string | null;
  labels: { name: string; color: string }[];
  /** Label が読取の上限（20）を越えて欠けていれば `false`。 */
  labelsComplete: boolean;
  assignees: string[];
  assigneesComplete: boolean;
  milestone: { title: string; dueOn: string | null } | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
};

export interface GithubRepositoryRef {
  /** GraphQL の node ID。認可と同期の基点はこれに束縛する。 */
  id: string;
  /** 取得した時点の `owner/name`。Rename で変わる。 */
  nameWithOwner: string;
}

/** 一覧の取得の出典（設計 1.1）。公開済みの写しは、全ページを取り終えたものだけである。 */
export interface WorkItemsProvenance {
  repository: GithubRepositoryRef;
  /** `SyncStateStore` の公開済みの世代。 */
  generation: number;
  /** 最後に公開した取得の時刻。 */
  fetchedAt: string;
  /** 最後に全件を照合した時刻。差分の取得では見えない削除・移動は、この時点までしか反映していない。 */
  fullReconciledAt: string;
  /** 変化の照会に使った ETag。全件の照合の直後は `null`。 */
  etag: string | null;
  /** `items` を正規化した JSON の hash（`sha256:<hex>`）。 */
  contentHash: string;
}

const WORK_ITEMS_QUERY = { kind: 'github.workItems', version: 1 };
const TARGET_PREFIX = 'github.repository:';

/** Repository の Issue / Pull Request の一覧を同期する scope。 */
export function workItemsScope(
  connection: SyncScope['connection'],
  repositoryId: string,
): SyncScope {
  return { connection, target: `${TARGET_PREFIX}${repositoryId}`, query: WORK_ITEMS_QUERY };
}

/** `workItemsScope` で作った scope なら repository の node ID を返す。 */
export function workItemsRepository(scope: SyncScope): string | null {
  if (!scope.target.startsWith(TARGET_PREFIX) || scope.window) return null;
  if (canonicalJson(scope.query) !== canonicalJson(WORK_ITEMS_QUERY)) return null;
  const id = scope.target.slice(TARGET_PREFIX.length);
  return id === '' ? null : id;
}

/** 公開の印の中にだけ置く同期の基点。 */
export interface WorkItemsCursor {
  version: 1;
  repository: GithubRepositoryRef;
  etag: string | null;
  /** 取得した item の `updatedAt` の最大。差分の読取はこれより古い item で止める。 */
  watermark: string | null;
  fullReconciledAt: string;
  fetchedAt: string;
}

export function encodeCursor(cursor: WorkItemsCursor): string {
  return JSON.stringify(cursor);
}

export function decodeCursor(text: string | null): WorkItemsCursor | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<WorkItemsCursor>;
    if (
      value.version !== 1 ||
      typeof value.repository?.id !== 'string' ||
      typeof value.repository.nameWithOwner !== 'string' ||
      typeof value.fullReconciledAt !== 'string' ||
      typeof value.fetchedAt !== 'string'
    ) {
      return null;
    }
    return value as WorkItemsCursor;
  } catch {
    return null;
  }
}

// ---- 応答の解釈。外部から読んだ値は未信頼の入力として、形を確かめてから DTO にする。

// 制御文字を除くための正規表現なので、制御文字を含めてよい。
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩]/g;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export class MalformedResponse extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedResponse('expected an object');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new MalformedResponse('expected a string');
  return value.replace(UNSAFE_TEXT, '');
}

function time(value: unknown): string {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) {
    throw new MalformedResponse('expected an ISO time');
  }
  return value;
}

function optional<T>(value: unknown, read: (value: unknown) => T): T | null {
  return value === null || value === undefined ? null : read(value);
}

function githubUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function connection<T>(value: unknown, read: (node: Record<string, unknown>) => T) {
  const page = record(value);
  if (!Array.isArray(page.nodes) || typeof page.totalCount !== 'number') {
    throw new MalformedResponse('expected a connection');
  }
  const nodes = page.nodes.map((node) => read(record(node)));
  return { nodes, complete: nodes.length >= page.totalCount };
}

const ISSUE_STATE_REASON: Record<string, GithubWorkItem['stateReason']> = {
  COMPLETED: 'completed',
  NOT_PLANNED: 'notPlanned',
  REOPENED: 'reopened',
  DUPLICATE: 'duplicate',
};

export function parseWorkItem(kind: GithubWorkItem['kind'], value: unknown): GithubWorkItem {
  const node = record(value);
  const id = text(node.id);
  if (id === '' || typeof node.number !== 'number' || !Number.isInteger(node.number)) {
    throw new MalformedResponse('expected an id and a number');
  }
  const state = text(node.state);
  const allowed = kind === 'issue' ? ['OPEN', 'CLOSED'] : ['OPEN', 'CLOSED', 'MERGED'];
  if (!allowed.includes(state)) throw new MalformedResponse('unknown state');
  const labels = connection(node.labels, (label) => ({
    name: text(label.name),
    color:
      typeof label.color === 'string' && /^[0-9A-Fa-f]{6}$/.test(label.color) ? label.color : '',
  }));
  const assignees = connection(node.assignees, (assignee) => text(assignee.login));
  const milestone = optional(node.milestone, (raw) => {
    const value = record(raw);
    return { title: text(value.title), dueOn: optional(value.dueOn, time) };
  });
  return {
    kind,
    id,
    number: node.number,
    title: text(node.title),
    state: state.toLowerCase() as GithubWorkItem['state'],
    stateReason:
      kind === 'issue' && typeof node.stateReason === 'string'
        ? (ISSUE_STATE_REASON[node.stateReason] ?? null)
        : null,
    draft: kind === 'pullRequest' && node.isDraft === true,
    url: githubUrl(node.url),
    author: optional(node.author, (author) => text(record(author).login)),
    labels: labels.nodes,
    labelsComplete: labels.complete,
    assignees: assignees.nodes,
    assigneesComplete: assignees.complete,
    milestone,
    createdAt: time(node.createdAt),
    updatedAt: time(node.updatedAt),
    closedAt: optional(node.closedAt, time),
    mergedAt: kind === 'pullRequest' ? optional(node.mergedAt, time) : null,
  };
}

export interface WorkItemsPage {
  repository: GithubRepositoryRef;
  items: GithubWorkItem[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/** GraphQL の一ページ。Repository が見つからなければ `null`。 */
export function parseWorkItemsPage(
  kind: GithubWorkItem['kind'],
  data: unknown,
): WorkItemsPage | null {
  const root = record(data);
  if (root.node === null) return null;
  const repository = record(root.node);
  const list = record(repository[kind === 'issue' ? 'issues' : 'pullRequests']);
  const pageInfo = record(list.pageInfo);
  if (!Array.isArray(list.nodes) || typeof pageInfo.hasNextPage !== 'boolean') {
    throw new MalformedResponse('expected a page');
  }
  const endCursor = optional(pageInfo.endCursor, text);
  // 次のページがあるのに cursor がなければ、残りを読めない。全件として公開しない。
  if (pageInfo.hasNextPage && !endCursor) throw new MalformedResponse('missing endCursor');
  return {
    repository: { id: text(repository.id), nameWithOwner: text(repository.nameWithOwner) },
    items: list.nodes.map((node) => parseWorkItem(kind, node)),
    endCursor,
    hasNextPage: pageInfo.hasNextPage,
  };
}
