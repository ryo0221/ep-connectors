# ep-connectors 全体設計

**Proposed、版0.1、2026-10-23。未実装。** パッケージの構成、共通の差し口（port）、Hostとの責務の分け方を定める。決定の経緯は[ADR 001](decisions/001-library-first-monorepo.md)、試験の方針は[試験の設計](testing.md)、進める順番は[段階と分野](roadmap.md)を参照する。型名・関数名はすべて提案であり、まだexportされているAPIではない。

## 1. 責務の配置

| 置き場所                      | 持つもの                                                                                                               | 持たないもの                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| EditorPlatform                | Editor（model・command・Surface）、Host portの型、Editor–Host契約、決定的なmock Host                                   | 外部への通信、資格情報、操作台帳。本リポジトリへの依存             |
| ep-connectors（本リポジトリ） | Provider adapter、外部作用の計画と実行の手順、台帳の記録形式、retry・照合、同期の基点の扱い、能力宣言の組み立て        | 資格情報・台帳・キューの保管の実体、OAuthの同意画面、認証済session |
| 各Host                        | 認証済session、OAuthの同意画面とredirect、portの実装（token store、台帳、キュー、Webhook受信）、tenant分離、membership | Provider APIの組み立て、Provider固有の重複抑止・競合の規則         |
| 実行基盤（未選定）            | 台帳の永続化、atomicな実行権の確保、再起動後の再開                                                                     | —                                                                  |

本リポジトリは「どう送り、どう記録し、どう照合するか」を持ち、「どこに保管し、誰が実行してよいか」はHostが持つ。HostがPaoBubのような単一サービスでも、利用者が包んだ別サービスでも、同じパッケージを使えるようにする。

## 2. パッケージ

npm workspacesのmonorepoとし、scopeは`@ep-connectors`とする。公開方法（npm / GitHub Packages）は最初の公開の前に決める。

| パッケージ                | 中身                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@ep-connectors/core`     | 差し口の型、共通の記録形式（connection key、operation record、receipt、能力宣言）、errorの分類。外部通信・保管の実装は持たない |
| `@ep-connectors/testing`  | 各差し口のメモリ実装、差し口の契約試験、偽のProviderを組むためのHTTP層。試験専用で、本番の依存に入れない                       |
| `@ep-connectors/schedule` | Google Calendar / Outlook、Google Meet / Teams / Zoom。設計は[docs/schedule/](schedule/README.md)                              |
| `@ep-connectors/data`     | DB・表計算（Google Sheets / Excel オンライン）。設計前                                                                         |
| `@ep-connectors/files`    | ファイルの保存先（Google Drive / OneDrive / SharePoint）。設計前                                                               |
| `@ep-connectors/map`      | 地図の背景タイル、住所検索。設計前                                                                                             |

依存の規則は次のとおりとする。

- 分野のパッケージは`core`にだけ依存する。分野どうしは直接依存しない。
- Providerごとのadapterは分野のパッケージの中にsubpath exportとして置く（例: `@ep-connectors/schedule/google`）。Hostは使うProviderだけをimportする。
- 同じProviderの共通部分（Google / MicrosoftのOAuth endpoint、error応答の解釈など）は、二つ目の分野が必要とした時点で`@ep-connectors/provider-google`のような共通パッケージへ切り出す。先回りして作らない。
- EditorPlatformのpackageは現在privateのため、実行時の依存にしない。分野のパッケージはEditorPlatformのHost portを構造的に満たす型で実装し、EditorPlatformの特定commitに対する型の適合を試験で確かめる（[試験の設計](testing.md#4-editorplatformとの適合)）。

言語はTypeScript、実行環境はEditorPlatformに合わせてNode 22.13以上または24、試験はvitestとする。

## 3. 共通の差し口

どの差し口も次を守る。

- 呼出しはすべて非同期で、引数と戻り値はserializeできる値に限る。関数やclass instanceを記録として渡さない。
- 一回の呼出しで完結させる。ライブラリはprocess内に状態を持ち越さず、二回の呼出しの間に別のprocessやworkerへ移っても正しく動く。
- 実装がHostごとに違っても、意味は[差し口の契約試験](testing.md#1-差し口の契約試験)で揃える。

### 3.1 接続の識別

`ConnectionKey`は、少なくともprincipal、provider、tenant / account、connection、接続の世代を持つ。再認証で別のaccountが選ばれた場合は新しいconnectionとし、旧keyを付け替えない。Handleは権限の証明ではないため、各差し口は渡されたkeyが現在のsessionのものかをHostに確認させる（`HostPolicy`）。

### 3.2 `TokenStore`

| 操作           | 意味                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `use(key, fn)` | 現在有効なaccess tokenでだけ`fn`を実行する。Tokenを呼出し元へ返さず、`fn`の外へ持ち出せない形で渡す |
| `refresh(key)` | Refreshを行い、失効なら`revoked`を返す。同じkeyへの同時refreshはHost側の実装で一つにまとめる        |
| `revoke(key)`  | 接続を解除し、そのkeyに束縛された同期の基点も無効にする                                             |

Raw token、authorization header、refresh tokenを、Editor向けDTO、操作台帳、log、errorの文言へ出さない。OAuthの同意画面とredirectの受け口はHostが持ち、本リポジトリは認可要求の組み立てと応答の検証（state、PKCE、issuer）だけを提供する。

### 3.3 `OperationLedger`

外部に結果が残る操作（予定の作成、ファイルの書込みなど）の記録。D3の前提であり、読取だけの段階では使わない。

| 操作                                    | 意味                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `claim(slot, operation, planDigest)`    | 公開枠とoperationをatomicに確保する。結果は`claimed` / `existing` / `conflict`。耐久保存が失敗したら送信しない   |
| `appendAttempt(operation, attempt)`     | 送信の直前に、試行番号・送信予定のstep・重複抑止keyを追記する                                                    |
| `recordResult(operation, step, result)` | 応答・外部IDのHost内参照・Provider request ID・読み戻しの結果を記録する                                          |
| `listUnresolved()`                      | `dispatching` / `unknown`のまま残ったoperationを返す。再起動後はここから照合を始め、新しい送信を自動で発行しない |

メモリ実装は試験専用とし、本番のHostへ「耐久性あり」と宣言させない。Step状態の意味はEditorPlatformの[Editor–Host契約の5](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/editor-host-contract.md#5-外部作用の状態とreceipt)に従う。

### 3.4 `JobQueue`

再試行と非同期の照合を、Hostの実行基盤へ預ける差し口。

- `enqueue(job, notBefore)`で、serializeできるjobを預ける。Jobはoperation IDと次のstepだけを持ち、payloadの写しを持たない。送る内容は台帳の計画から読み直す。
- Jobを実行する直前に、現在の権限・membership・connection・計画の期限を再確認する（`HostPolicy.authorizeDispatch`）。キューに入れた時点の判定を使い回さない。
- 同じjobが二度実行されても安全にする。重複実行の抑止は台帳の`claim`で行い、キューの保証に頼らない。
- SDK、HTTP client、proxyによる暗黙のretryは無効にし、retryはこの差し口だけで行う。

### 3.5 `WebhookIntake`

Providerからの変更通知の受け口。HTTPSの受信そのものはHostが持つ。

- `verify(request)`で署名・channel token・購読IDを検証し、合図（どのconnection・どの対象に変化があり得るか）だけを返す。通知の本文を変更内容として扱わない。
- 通知の重複・順序の逆転・欠落を前提とし、通知を受けたら再取得する。通知だけで同期を完了としない。
- 購読の作成・更新・停止の期限は`JobQueue`で管理する。常時Webhookを受けられないHostでは、定期的な読取で代える。

### 3.6 `SyncStateStore`

同期の基点（Googleの`syncToken`、Microsoftの`deltaLink`など）の保管。

- 基点は、ConnectionKey、対象（calendar、sheet、folderなど）、取得条件、固定した期間、baselineの世代に束縛して保管する。条件の違う基点を流用しない。
- 全ページを取り終えるまで新しい基点をcommitしない。Baselineを失ったら残っている基点も無効にする。
- 外部cacheを作り直しても、台帳・未解決のoperation・Hostのbindingは消さない。

### 3.7 `HttpTransport`、`Clock`、`IdSource`

- `HttpTransport`はfetchと同じ形の関数を受け取る。通信先はadapterごとのallowlistに固定し、redirect先・cursorに含まれるURLもallowlistで検証する。
- `Clock`と`IdSource`は外から渡す。期限、待機、重複抑止keyを試験で決定的にするためである。

## 4. 能力の宣言

Adapterは、操作ごとの能力をEditorPlatformの[Editor–Host契約の能力宣言](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/editor-host-contract.md#21-能力を宣言する単位)の形で返す。条件付き書込は`serverPrecondition` / `bestEffort` / `unsupported` / `unverified`のどれかで示す。Provider名だけで能力を決めない。

Hostの差し口の性質も能力に反映する。たとえば台帳の耐久性がない、Webhookを受けられないHostでは、それに依存する操作を`unsupported`にする。[実接続の試験](testing.md#3-実接続の試験)で確かめるまで、Providerの保証に依存する操作は`unverified`のままにする。

## 5. 未信頼の入力と私有情報

- 外部から読んだ本文・件名・URL・cursorは未信頼の入力として扱い、plain textへ変換してから返す。自動でfetchせず、tokenを付けて開かない。
- 本人が読めるだけの外部データは、本人向けのDTOにだけ入れる。共有content、export、AIへの入力へ渡すかはEditorとHostが決め、本リポジトリは渡し口を作らない。
- Raw responseを一般logへ出さない。台帳へ残すのは、照合に必要なfieldだけである。
