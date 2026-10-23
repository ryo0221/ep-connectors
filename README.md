# ep-connectors

EditorPlatform を使う Host（PaoBub 製品版、EditorPlatform を組み込む利用者のアプリ）が外部サービスへ接続するためのライブラリ群。カレンダー・会議、DB・表計算、地図、GitHub、ファイルの保存先を扱う。

**状態：C0 の実装中、R1 の GitHub 読取を実装。** `@ep-connectors/core`（差し口の型と目録の検査）と `@ep-connectors/testing`（メモリ実装、偽の Provider、契約試験）、`@ep-connectors/editor-ports`（EditorPlatform の Host port から写して固定した型と fixture）、`@ep-connectors/github`（Issue / Pull Request の一覧の読取。偽の GitHub でだけ試験済み）がある。

## 開発

Node 22.13 以上または 24 を使う。

```sh
npm ci
npm run check   # prettier、eslint、tsc、vitest
```

| パッケージ                                             | 中身                                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@ep-connectors/core`](packages/core/src)             | `ConnectionKey`、`HostPolicy`、`TokenStore` / `HttpTransport`、`OperationLedger`、`JobQueue`、`WebhookIntake`、`SyncStateStore`、能力の宣言の型と、操作の目録の検査 |
| [`@ep-connectors/editor-ports`](packages/editor-ports) | EditorPlatform の Host port（今は `ScheduleReadPort` / `ScheduleEffectPort`）から写した公開の型、写した元の commit の記録、契約の観測の検査、架空の fixture         |
| [`@ep-connectors/testing`](packages/testing/src)       | 各差し口のメモリ実装（試験専用）、偽の Provider、Host の実装にも流せる契約試験（`@ep-connectors/testing/contracts`）                                                |
| [`@ep-connectors/github`](packages/github/src)         | GitHub の Issue / Pull Request の一覧の読取（固定の GraphQL document、repository 単位の認可、ETag による変化の照会）、webhook の検証                                |

Host が自分の差し口の実装を確かめるときは、`@ep-connectors/testing/contracts` の `tokenStoreContract` などに実装を渡して vitest で流す。例は [memory.contract.test.ts](packages/testing/src/memory.contract.test.ts)。

## 設計

- [ADR 001: 接続は一つのリポジトリにまとめたライブラリとして作る](docs/decisions/001-library-first-monorepo.md)
- [全体設計](docs/architecture.md)：パッケージ、共通の差し口（token store、操作台帳、再試行キュー、Webhook の受け口、同期の基点）、Host との責務の分け方
- [試験の設計](docs/testing.md)：差し口の契約試験、偽の Provider を使う試験、実接続の試験
- [段階と分野](docs/roadmap.md)
- [Schedule 接続コンポーネントの設計](docs/schedule/README.md)と[Provider Notes](docs/schedule/provider-notes.md)
- [GitHub 接続の設計](docs/github/README.md)

## EditorPlatform との関係

EditorPlatform は本リポジトリへ依存しない。EditorPlatform が Host port の型と [Editor–Host 契約](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/editor-host-contract.md)を公開し、本リポジトリはその port を満たす実装を Host へ提供する。契約と本リポジトリの文書が食い違う場合は契約を優先する。
