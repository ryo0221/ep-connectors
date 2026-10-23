# 段階と分野

**Proposed、版0.1、2026-10-23。** 進める順番と、各段階の前に決めることを並べる。Scheduleの段階名（D1–D4）とgate IDはEditorPlatformの[Schedule設計](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/README.md#実装段階)に合わせる。

## 1. 順番

| 段階 | 内容                                                                                                   | 前に決めること・満たすこと                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| C0   | Monorepoの骨組み、`core`の差し口の型、`testing`のメモリ実装と契約試験                                  | 本PRの設計の合意                                                                                              |
| S-D2 | Scheduleの外部読取（Google Calendar / Outlook）。`TokenStore`・`SyncStateStore`・`WebhookIntake`を使う | G-OAUTH、G-PRIVACY。外部writeは無効のまま                                                                     |
| S-D3 | Scheduleの外部作用（単発作成、Meet / Teams / Zoom）。`OperationLedger`・`JobQueue`を使う               | G-CONNECTORの残り（実行基盤、運用主体）、G-HOST、G-CAS、G-ZOOM-RECOVERY。Provider・操作ごとに実接続で確かめる |
| 分野 | `data`、`files`、`map`を一つずつ                                                                       | 分野ごとの設計文書を本リポジトリで先に合意する                                                                |

S-D2で`core`の差し口を実際に使い、読取に要る部分を固める。台帳とキューはS-D3まで型だけにとどめる。

## 2. 分野の候補

設計前の候補である。各分野は、EditorPlatform側でHost portと契約が決まってから実装する。

| 分野    | 想定する接続先                       | EditorPlatform側の現状                                                                                          |
| ------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `data`  | DB、Google Sheets / Excel オンライン | Structured Dataは手元のデータだけを扱う。外部の参照元のportは未定義                                             |
| `files` | Google Drive / OneDrive / SharePoint | Document・Slide・Officeの取り込みと書き出しは手元のファイルだけ                                                 |
| `map`   | 背景タイル、住所検索                 | Geoの背景は同梱データだけで、外部APIとタイルを使わない契約（`docs/geo-background-contract.md`）。変更が先に要る |

共同編集のサーバーはHostが持つものであり、本リポジトリの対象にしない。

## 3. 決めていないこと

- 公開方法（npm / GitHub Packages）とversionの付け方。
- 本リポジトリへEditorPlatform・paobub-mvpと同じ工程の定義（`docs/workflow`、`workflow.json`）を入れるか。
- 実行基盤（Common Runtimeへの適合を含む）と運用主体。S-D3の前に決める。
