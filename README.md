# ep-connectors

EditorPlatform を使う Host（PaoBub 製品版、EditorPlatform を組み込む利用者のアプリ）が外部サービスへ接続するためのライブラリ群。カレンダー・会議、DB・表計算、地図、GitHub、ファイルの保存先を扱う。

**状態：設計中。実装はまだない。**

## 設計

- [ADR 001: 接続は一つのリポジトリにまとめたライブラリとして作る](docs/decisions/001-library-first-monorepo.md)
- [全体設計](docs/architecture.md)：パッケージ、共通の差し口（token store、操作台帳、再試行キュー、Webhook の受け口、同期の基点）、Host との責務の分け方
- [試験の設計](docs/testing.md)：差し口の契約試験、偽の Provider を使う試験、実接続の試験
- [段階と分野](docs/roadmap.md)
- [Schedule 接続コンポーネントの設計](docs/schedule/README.md)と[Provider Notes](docs/schedule/provider-notes.md)
- [GitHub 接続の設計](docs/github/README.md)

## EditorPlatform との関係

EditorPlatform は本リポジトリへ依存しない。EditorPlatform が Host port の型と [Editor–Host 契約](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/editor-host-contract.md)を公開し、本リポジトリはその port を満たす実装を Host へ提供する。契約と本リポジトリの文書が食い違う場合は契約を優先する。
