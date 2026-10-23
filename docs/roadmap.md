# 段階と分野

**Proposed、版0.1、2026-10-23。** 進める順番と、各段階の前に決めることを並べる。本リポジトリの段階名（C0・R1・R2・W1）はScheduleの段階（D1–D4）と別に付ける。Scheduleとの対応は1の末尾に示す。gate IDはEditorPlatformの[Schedule設計](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/README.md#実装段階)に合わせる。

## 1. 順番

本リポジトリの目的はData・Schedule・Geo・GitHubの接続を共通にすることである。外部writeへ進む前に、四つの分野の読取を小さく縦に通し、`core`がScheduleだけに合わせた形になっていないかを確かめる。

| 段階 | 内容                                                                                                                                                                                                                                       | 前に決めること・満たすこと                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| C0   | Monorepoの骨組み、`core`の差し口の型、`testing`のメモリ実装と契約試験、公開のport契約の固定                                                                                                                                                | 本PRの設計の合意                                                                                              |
| R1   | 読取の縦断試験。Schedule（Google CalendarかOutlookの一つ）、Data（DBか表計算の一つ）、Geo（OGC API Featuresの一つ）、GitHub（Issue / Pull Requestの一覧）の読取を、偽のProviderで`TokenStore`・`SyncStateStore`・`WebhookIntake`の上に通す | 四分野で共通に使えなかった差し口を直す。分野ごとの読取のDTOを決める。外部writeは無効のまま                    |
| R2   | 読取の実接続。R1の四つを、試験用のアカウントと公開データで実接続して確かめる                                                                                                                                                               | G-OAUTH、G-PRIVACY（Schedule）。分野ごとの権利・出典の扱い（Geo）                                             |
| W1   | 外部作用。Scheduleの単発作成とMeet / Teams / Zoom。`OperationLedger`・`JobQueue`を使う                                                                                                                                                     | G-CONNECTORの残り（実行基盤、運用主体）、G-HOST、G-CAS、G-ZOOM-RECOVERY。Provider・操作ごとに実接続で確かめる |
| 以降 | `files`、各分野の接続先の追加、Data・Geo・GitHubへの書込み                                                                                                                                                                                 | 分野ごとの設計文書を本リポジトリで先に合意する                                                                |

R1で読取に要る差し口を四分野で固める。GitHubは、差分の基点（sync token）がなくETagと定期的な照合で同期する点と、Webhookに署名があり再配送される点が他と違うため、`SyncStateStore`と`WebhookIntake`がScheduleだけに合わせた形になっていないかを確かめるのに役立つ。台帳とキューはW1まで型だけにとどめる。ScheduleのD2はR1とR2に、D3はW1に当たる。

R1では、EditorPlatform側のHost portがまだない分野（Data・Geo・GitHub）について、本リポジトリの中で読取のDTOを決めて縦断試験をする。EditorPlatformのEditorへつなぐのは、そのHost portと契約が決まってからにする。

## 2. 分野の候補

設計前の候補である。

| 分野     | 想定する接続先                                                                                                           | EditorPlatform側の現状                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`   | DB、Google Sheets / Excel オンライン                                                                                     | Structured Dataは手元のデータだけを扱う。外部の参照元のportは未定義                                                                                                                 |
| `map`    | 地理データのvector feature読取（OGC API Featuresなど。領域での検索、ページング、出典、CRS）。背景タイル、住所検索        | Geoは手元のCSV / GeoJSON（CRS84）の取り込みだけ。背景は同梱データだけで外部APIとタイルを使わない契約（`docs/geo-background-contract.md`）。タイルと住所検索には契約の変更が先に要る |
| `files`  | Google Drive / OneDrive / SharePoint                                                                                     | Document・Slide・Officeの取り込みと書き出しは手元のファイルだけ                                                                                                                     |
| `github` | GitHubのIssue / Pull Request、Projects、リポジトリのファイル、レビューのコメント。設計は[docs/github/](github/README.md) | Structured Dataは手元のデータだけ、Documentの取り込みは手元のファイルだけ。GitHubのportは未定義                                                                                     |

Geoのvector feature読取は、領域（bbox）での検索、ページングの基点、出典と利用条件、CRSを読取のDTOに含める。CRSを黙って変換せず、EditorPlatformのGeoが扱えないCRSは理由付きで拒否する。

共同編集のサーバーはHostが持つものであり、本リポジトリの対象にしない。

## 3. 決めていないこと

- 公開方法（npm / GitHub Packages）とversionの付け方。
- 本リポジトリへEditorPlatform・paobub-mvpと同じ工程の定義（`docs/workflow`、`workflow.json`）を入れるか。
- 実行基盤（Common Runtimeへの適合を含む）と運用主体。W1の前に決める。
- R1でData・Geoそれぞれ最初に選ぶ接続先。
- GitHubで最初に読む対象と、GitHub Enterprise Serverを対象にするか（[GitHub接続の設計の5](github/README.md#5-決めていないこと)）。
