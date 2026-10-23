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
| `@ep-connectors/github`   | GitHubのリポジトリのファイル、Issue / Pull Request、Projects、レビューのコメント。設計は[docs/github/](github/README.md)       |
| `@ep-connectors/map`      | 地理データの取得（OGC API Featuresなどのvector feature読取）、地図の背景タイル、住所検索。設計前                               |

依存の規則は次のとおりとする。

- 分野のパッケージは`core`にだけ依存する。分野どうしは直接依存しない。
- Providerごとのadapterは分野のパッケージの中にsubpath exportとして置く（例: `@ep-connectors/schedule/google`）。Hostは使うProviderだけをimportする。
- 同じProviderの共通部分（Google / MicrosoftのOAuth endpoint、error応答の解釈など）は、二つ目の分野が必要とした時点で`@ep-connectors/provider-google`のような共通パッケージへ切り出す。先回りして作らない。
- EditorPlatformのpackageは現在privateのため、実行時の依存にしない。分野のパッケージはEditorPlatformのHost portを構造的に満たす型で実装する。適合は、本リポジトリに固定した公開可能なport契約と、権限のあるCIでの実装の適合試験の二段で確かめる（[試験の設計](testing.md#4-editorplatformとの適合)）。

言語はTypeScript、実行環境はEditorPlatformに合わせてNode 22.13以上または24、試験はvitestとする。

## 3. 共通の差し口

どの差し口も次を守る。

- 呼出しはすべて非同期で、引数と戻り値はserializeできる値に限る。関数やclass instanceを記録として渡さない。
- 一回の呼出しで完結させる。ライブラリはprocess内に状態を持ち越さず、二回の呼出しの間に別のprocessやworkerへ移っても正しく動く。
- 実装がHostごとに違っても、意味は[差し口の契約試験](testing.md#1-差し口の契約試験)で揃える。

### 3.1 接続の識別

`ConnectionKey`は、少なくともprincipal、provider、tenant / account、connection、接続の世代を持つ。再認証で別のaccountが選ばれた場合は新しいconnectionとし、旧keyを付け替えない。Handleは権限の証明ではないため、各差し口は渡されたkeyが現在のsessionのものかをHostに確認させる（`HostPolicy`）。

### 3.2 `TokenStore`

| 操作                 | 意味                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send(key, request)` | Adapterが組み立てたserializeできるHTTP要求（操作名、method、URL、header、body）を3.2.1の境界で検査し、通ったものだけにHostが現在有効なaccess tokenを付けて送り、serializeできる応答を返す。Tokenはadapterへ渡らない |
| `refresh(key)`       | Refreshを行い、失効なら`revoked`を返す。同じkeyへの同時refreshはHost側の実装で一つにまとめる                                                                                                                        |
| `revoke(key)`        | 接続を解除し、そのkeyに束縛された同期の基点も無効にする                                                                                                                                                             |

Tokenを使う処理をcallbackとして渡す形にはしない。差し口の引数をserializeできる値に限る規則（3の冒頭）を守り、HostがRPCやworkerの向こうに実装しても同じ意味で動かすためである。Tokenの付与と送信はHostの信頼境界の中で行う。

#### 3.2.1 認証付き送信の境界

Adapterがmethod・URL・header・bodyを組み立てるため、送信先のhost名だけを許可しても、想定外のendpointやredirect先へ接続の権限を使われる余地が残る。Hostの`send`の実装は、次をすべて満たすことを必須の契約とする。Adapterの申告を信じるのではなく、Hostの側で検査する。

- **操作の目録で許可する。** Adapterは、Providerごとに使う操作の目録（操作名、method、許可するorigin、pathの型、必要なscope）を静的に宣言する。GraphQLのように一つのendpointで内容が変わる操作は、固定したdocumentのhashと変数の型を目録に載せる（[GitHub接続の設計の2](github/README.md#2-認証)）。Hostは要求の操作名を目録と照合し、method・origin（scheme・host・portの完全一致）・pathが目録の型に合わない要求を送らない。目録はconnectionのscopeとも照合し、接続の同意にない操作を拒否する。
- **認証付きのredirectを辿らない。** Hostは認証付き要求の3xxを自動で辿らず、tokenを付けずに応答としてadapterへ返す。Adapterが次の要求として送り直す場合も、新しいURLを同じ目録の検査に通す。別originへの付け替えでtokenを送ることはない。Providerが仕様として別originへ誘導する操作（署名付きのダウンロードURLなど）は、目録で「認証なし」として宣言し、`HttpTransport`の側で扱う。
- **認証に関わるheaderをadapterに指定させない。** `Authorization`、`Cookie`、`Proxy-Authorization`、およびProviderが認証に使うheaderを要求に含めた場合は、上書きせずに要求ごと拒否する。Hostが付けるのは認証のheaderだけで、他のheaderは目録で許可したものに限る。
- **応答とerrorに秘密情報を出さない。** 応答から`Set-Cookie`、`WWW-Authenticate`など認証に関わるheaderを除いて返す。Hostのerrorの文言・log・例外には、token、送信したheader、query中の資格情報を含めない。
- **cursor・nextLinkのURLも同じ検査に通す。** Providerが返したURLをそのまま辿らず、目録の操作として検査する。

本リポジトリは、目録の型と、Hostの実装がこの境界を満たすかを確かめる契約試験を提供する（[試験の設計](testing.md#1-差し口の契約試験)）。

Raw token、authorization header、refresh tokenを、Editor向けDTO、操作台帳、log、errorの文言へ出さない。OAuthの同意画面とredirectの受け口はHostが持ち、本リポジトリは認可要求の組み立てと応答の検証（state、PKCE、issuer）だけを提供する。

### 3.3 `OperationLedger`

外部に結果が残る操作（予定の作成、ファイルの書込みなど）の記録。W1（[段階と分野](roadmap.md)）の前提であり、読取だけの段階では使わない。

| 操作                                                    | 意味                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claim(slot, operation, planDigest)`                    | 公開枠とoperationをatomicに確保する。結果は`claimed` / `existing` / `conflict`。耐久保存が失敗したら送信しない。stepの送信権は与えない                                                                                   |
| `acquireStep(operation, step, expectedGeneration)`      | 一つのstepの送信権をatomicに得る。状態が`prepared`で世代が一致するときだけ`dispatching`へ遷移させ、新しい世代とfencing tokenを返す。それ以外は現在の状態（`dispatching` / `unknown` / 確定済み）を返し、送信権を与えない |
| `appendAttempt(operation, attempt, fence)`              | 送信の直前に、試行番号・送信予定のstep・重複抑止keyを追記する。現在のfencing tokenでなければ拒否する                                                                                                                     |
| `recordResult(operation, step, result, fence)`          | 応答・外部IDのHost内参照・Provider request ID・読み戻しの結果を記録する。古いfencing tokenからの記録は拒否する                                                                                                           |
| `acquireReconcile(operation, step, expectedGeneration)` | `dispatching` / `unknown`のstepの照合権をatomicに得る。世代を進めて新しいfencing tokenを返し、それまでのtokenを無効にする。遅れて戻った古いworkerの記録はこれで拒否される                                                |
| `release(operation, step, evidence, fence)`             | 照合権を持つworkerが、未送信を証明できたstepだけを、世代を進めて`prepared`へ戻す。証拠のない解放を拒否する                                                                                                               |
| `listUnresolved()`                                      | `dispatching` / `unknown`のまま残ったoperationを返す。再起動後はここから照合を始め、新しい送信を自動で発行しない                                                                                                         |

`claim`は同じ予定の多重公開を防ぎ、`acquireStep`は同じstepの多重送信を防ぐ。二つは別の保証であり、`claim`の結果が`existing`であることをstepの送信権の証明として扱わない。同じoperationのjobが二つのworkerへ重複して配送された場合も、`acquireStep`で送信権を得たworkerだけが`appendAttempt`と送信へ進む。送信権を得られなかったworkerは何も送らずに終わる。

`dispatching`は「送信したかもしれない」状態である。送信権を持つworkerが応答を記録する前に止まった場合、再起動後も`dispatching`を未送信と決めつけない。`listUnresolved`から、`acquireReconcile`で照合権を得て照合を始め、既知のIDと重複抑止keyで外部の状態を確かめる。照合で未送信を証明できたときだけ、世代を進めて`prepared`へ戻す（`release`）。証明できなければ`unknown`へ遷移させ、新しい送信を発行しない。

メモリ実装は試験専用とし、本番のHostへ「耐久性あり」と宣言させない。Step状態の意味はEditorPlatformの[Editor–Host契約の5](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/editor-host-contract.md#5-外部作用の状態とreceipt)に従う。

### 3.4 `JobQueue`

再試行と非同期の照合を、Hostの実行基盤へ預ける差し口。

- `enqueue(job, notBefore)`で、serializeできるjobの参照を預ける。参照は種類ごとに次のどれかで、payloadの写しを持たない。実行するときに、送る内容や取得の条件を保管から読み直す。
  - `{ kind: 'step', operation, step }`：外部作用のstep。計画は台帳から読む（W1以降）。
  - `{ kind: 'read', scope, expectedGeneration }`（scopeはConnectionKeyと対象を含む）：rate limitや一時障害の後の再取得、Webhookの合図を受けた再取得、定期的な照合。取得の条件と基点は`SyncStateStore`から読む。台帳を使わず、読取の段階から使える。
  - `{ kind: 'subscription', connection, subscription }`：Webhookの購読の作成・更新・停止。
- Jobを実行する直前に、jobの種類ごとの条件を`HostPolicy.authorizeDispatch(job)`で再確認する。キューに入れた時点の判定を使い回さない。失効・tenantの切替・connectionの世代の変化を検知したら、そのjobを実行せずに終える。

  | 種類           | 実行の直前に確かめること                                                                                                                                     |
  | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `step`         | 計画の有効期限と内容のdigest、現在のprincipal・membership・connection、送信先への権限                                                                        |
  | `read`         | scopeのprincipal・connection・対象への閲覧の認可（GitHubでは[repository単位の認可](github/README.md#21-installationの権限と利用者の閲覧権限)）、期待する世代 |
  | `subscription` | 購読の所有者（どのconnectionの購読か）と、connectionが有効であること                                                                                         |

- 同じjobが二度実行されても安全にする。外部作用のstepの重複実行は台帳の`acquireStep`とfencing tokenで抑止し、キューの「一回だけ配送する」保証に頼らない。読取のjobは、`SyncStateStore.commit`の世代のCASで、古い世代や二重の取得が公開されないようにする。
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
- 外部cacheと基点を別々に進めない。取得したページは新しい世代のstagingへ書き、全ページを適用してから、cacheの世代と基点を一つの操作で公開する（`commit(scope, expectedGeneration, stagedGeneration, cursor)`、世代のCAS）。読む側は公開済みの世代だけを見る。cacheの一部が未反映のまま基点だけが進む状態を作らない。
- Hostがcacheと基点を同じ保管でatomicに更新できない場合も、公開の印を一つの記録としてatomicに書く。公開の印は「どの世代のcacheと、どの基点の組が公開済みか」を持つ唯一の記録であり、基点は印の中にだけ保管して、別の場所で先に進めない。手順は、cacheの世代Nを書き終えてから、印を（N、新しい基点）へCASで書き換える、の二段とする。印の書き換えがcommitであり、その前に止まれば印は前の組を指したまま、その後に止まれば新しい組を指す。どちらでも、cacheと基点の世代は一致する。
- 再起動の後は、印（または同じ保管でのcommit）が指す世代と基点からだけ再開する。印が指していない世代のstagingだけを捨てる。印が指している世代は、書き終えたものとして保持する。
- 外部cacheを作り直しても、台帳・未解決のoperation・Hostのbindingは消さない。

### 3.7 `HttpTransport`、`Clock`、`IdSource`

- `HttpTransport`は認証の要らない通信（公開の地図タイルなど）にだけ使い、`TokenStore.send`と同じserializeできる要求・応答の形にする。通信先はadapterごとのallowlistに固定し、redirect先・cursorに含まれるURLもallowlistで検証する。
- `Clock`と`IdSource`は外から渡す。期限、待機、重複抑止keyを試験で決定的にするためである。

## 4. 能力の宣言

Adapterは、操作ごとの能力をEditorPlatformの[Editor–Host契約の能力宣言](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/editor-host-contract.md#21-能力を宣言する単位)の形で返す。条件付き書込は`serverPrecondition` / `bestEffort` / `unsupported` / `unverified`のどれかで示す。Provider名だけで能力を決めない。

Hostの差し口の性質も能力に反映する。たとえば台帳の耐久性がない、Webhookを受けられないHostでは、それに依存する操作を`unsupported`にする。[実接続の試験](testing.md#3-実接続の試験)で確かめるまで、Providerの保証に依存する操作は`unverified`のままにする。

## 5. 未信頼の入力と私有情報

- 外部から読んだ本文・件名・URL・cursorは未信頼の入力として扱い、plain textへ変換してから返す。自動でfetchせず、tokenを付けて開かない。
- 本人が読めるだけの外部データは、本人向けのDTOにだけ入れる。共有content、export、AIへの入力へ渡すかはEditorとHostが決め、本リポジトリは渡し口を作らない。
- Raw responseを一般logへ出さない。台帳へ残すのは、照合に必要なfieldだけである。
