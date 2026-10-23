# ADR 001: 接続は一つのリポジトリにまとめたライブラリとして作る

- 状態: **Proposed / 設計レビュー用**。実装・接続の受け入れを意味しない。
- 日付: 2026-10-23。
- 対象: EditorPlatformを使うHost（PaoBub製品版、EditorPlatformを組み込む利用者のアプリ）が外部サービスへ接続する部分。
- 関連: EditorPlatformの[ADR 013](https://github.com/ryo0221/editor-platform/blob/main/docs/decisions/013-schedule-external-effects.md)、[G-CONNECTOR](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/README.md#実装前gate)。

## 背景

EditorPlatformのADR 013は、Google Calendar / Outlook、Google Meet / Teams / Zoomへの接続をEditorの外に置き、「library / service / その両方のどれにするか、永続的な実行基盤、運用主体」をD3の前にG-CONNECTORで決めるとした。設計の草案はEditorPlatformの`docs/schedule/connector/`に仮に置いていた。

接続が必要になるのはScheduleだけではない。DB・表計算、地図（地理データの取得、背景タイル、住所検索）、GitHub（リポジトリ、Issue、Pull Request）、ファイルの保存先にも外部サービスとの接続が要る。どの接続にも、資格情報の保管、外部作用の記録、再試行、Webhookの受け口、同期の基点という共通の部分がある。

## 決定

### 1. 初めはライブラリとして作る（G-CONNECTORの一部を決める）

2026-10-21の合意に基づき、接続コンポーネントはまずHostへ組み込むライブラリとして作る。PaoBubはシングルサービスのまま、このライブラリを依存として取り込む。

サービスとして稼働させるかは各Hostが選ぶ。そのため次を守る。

- 資格情報の保管、操作台帳、再試行キュー、Webhookの受け口、同期の基点の保管は差し口（port）とし、Hostが実装を差し込む。
- ライブラリは同一プロセス・メモリ上の状態を前提にしない。portの呼出しはすべて非同期とし、portへ渡す記録はserializeできる値に限る。process内のlock、timer、callbackに保証を持たせない。
- 複数のHostが接続・同期の状態を共有する必要が出たら、そのときにサービスとしてまとめる。それまではサービスを作らない。

G-CONNECTORのうち、永続的な実行基盤（[Common Runtime](https://github.com/ryo0221/common-runtime)への適合を含む）と運用主体は決めない。どちらもD3の前に決める。決まるまでは外部writeを有効にしない。

### 2. 全分野を一つのリポジトリ`ep-connectors`にまとめる

分野ごとにリポジトリを分けず、共通の差し口を持つ一つのmonorepoにする。分野・パッケージの構成は[全体設計](../architecture.md)に定める。

- `core`は差し口の型と共通の記録形式だけを持ち、外部への通信や保管の実装を持たない。
- 分野ごとのパッケージは別々に公開し、Hostは使う分野だけを取り込む。分野間の依存は`core`経由に限る。
- EditorPlatformの設計（`docs/schedule/connector/`）は本リポジトリの[docs/schedule/](../schedule/README.md)へ移す。

### 3. EditorPlatformとの依存の向き

EditorPlatformは本リポジトリへ依存しない。EditorPlatformはHost portの型と契約を公開し、本リポジトリの分野別パッケージはそのportを満たす実装をHostへ提供する。Editor–Host契約は引き続きEditorPlatformが正本であり、本リポジトリの文書と食い違う場合は契約を優先する。

## 検討した案

| 案                                                 | 採らない理由                                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| paobub-mvpの中に置く                               | EditorPlatformを組み込む他のHostがpaobubごと取り込むことになる。paobub-mvpは単一利用者向けで、本番の外部接続を担うHostの代わりにしないとADR 013で決めている |
| 分野ごとに別リポジトリ（`schedule-connector`など） | 資格情報・台帳・再試行・Webhookの差し口を分野ごとに作り直すことになり、Hostの差し込み方も揃わない                                                           |
| 初めからサービスとして作る                         | 運用主体と実行基盤が未定のまま、Hostに稼働するサービスへの依存を強いる。シングルサービスのPaoBubと合わない                                                  |

## 影響

- EditorPlatformの`docs/schedule/connector/`は、本リポジトリへの案内に置き換える（EditorPlatform側の別の変更）。ADR 013の「配置先未決定」の記述も同じ変更で改める。
- 新しい分野の接続は、本リポジトリで分野の設計文書を作ってから実装する。
