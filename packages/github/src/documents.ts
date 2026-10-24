/**
 * Adapter が持つ固定の GraphQL document（GitHub 接続の設計 2）。目録にはこの document の hash を
 * 載せ、Host は送信の前に同じ規則で照合する。文字列の連結や利用者の与えた query で document を
 * 組み立てない。文字列リテラルを含めない（`graphqlDocumentHash` の前提）。
 *
 * Repository は node ID で指す。Owner / name は rename・transfer で変わるため、認可と同期の基点を
 * node ID に束縛する。
 */

const LABELS_AND_PEOPLE = `
  author { login }
  labels(first: 20) { totalCount nodes { name color } }
  assignees(first: 10) { totalCount nodes { login } }
  milestone { title dueOn }
`;

/** Issue の一覧。更新の新しい順に読み、差分の読取では基点より古い item で止める。 */
export const REPOSITORY_ISSUES = `
  query RepositoryIssues($repositoryId: ID!, $first: Int!, $after: String) {
    node(id: $repositoryId) {
      ... on Repository {
        id
        nameWithOwner
        issues(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id number title state stateReason url createdAt updatedAt closedAt
            ${LABELS_AND_PEOPLE}
          }
        }
      }
    }
  }
`;

/** Pull Request の一覧。並びと止め方は Issue と同じ。 */
export const REPOSITORY_PULL_REQUESTS = `
  query RepositoryPullRequests($repositoryId: ID!, $first: Int!, $after: String) {
    node(id: $repositoryId) {
      ... on Repository {
        id
        nameWithOwner
        pullRequests(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id number title state isDraft url createdAt updatedAt closedAt mergedAt
            ${LABELS_AND_PEOPLE}
          }
        }
      }
    }
  }
`;
