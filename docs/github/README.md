# GitHub接続の設計（草案）

**Proposed、版0.2、2026-10-23。Issue / Pull Requestの一覧の読取を`@ep-connectors/github`に実装し、偽のGitHubで試験した（R1、3.1）。実接続は未試験。** GitHubのリポジトリ、Issue、Pull Request、Projectsを、EditorPlatformのEditorから読み、後の段階で書くための`@ep-connectors/github`の設計を置く。共通の差し口は[全体設計](../architecture.md)、段階は[段階と分野](../roadmap.md)に従う。下記の「事実」は2026-10-23時点の公開文書に基づく前提であり、実装の前に公式文書で確かめ直す。実接続の試験はまだ行っていない。

## 1. 何をつなぐか

GitHubの対象は、Data・Filesのどちらか一方に収まらない。IssueやPull Requestは表として見ることも、本文をDocumentとして読むことも、レビューのコメントとして扱うこともできる。そのため、Providerごとのsubpathではなく独立した分野のパッケージにする。どの対象も、認証（GitHub App）、Webhook、rate limitを共有する。

| 対象                             | 読取（R段階）                                                                    | 書込み（W段階以降、候補）                                                | つなぐ先のEditor（Host portは未定義）              |
| -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| Issue / Pull Request             | 一覧、状態、label、assignee、milestone、日付。表・Kanban・Timelineの行として読む | Issueの作成、label・状態の変更、コメントの追加                           | Structured Data（読取中心のview）                  |
| Projects（v2）                   | itemとfield（状態、反復、日付）                                                  | itemのfieldの変更                                                        | Structured Data、Schedule（日付を持つitem）        |
| リポジトリのファイル             | 指定したbranch / commitのMarkdown・画像・CSVなど                                 | 変更をbranchへcommitし、Pull Requestを作る。既定のbranchへ直接pushしない | Document・Data・Slideの取り込み                    |
| Pull Requestのレビューとコメント | 差分の行に付いたコメント、レビューの状態                                         | コメントの追加                                                           | Reviewの表示（EditorPlatformの提案レビューとは別） |

### 1.1 版と出典

対象によって、版を固定できるかどうかが違う。出典の記録を二種類に分ける。

| 対象                                                            | 版の固定                                                                   | 出典として残すもの                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| リポジトリのファイル                                            | Commit SHAで固定できる。Branch名だけで取り込んだ内容を「同じ版」と扱わない | リポジトリID、path、commit SHA、blob SHA、取得日時                                                                                  |
| Issue / Pull Requestの状態、Projectsのfield、レビュー・コメント | 固定できない。GitHub上で変わり続け、過去の時点の状態を取り直す保証はない   | 資源のID（node ID）、取得日時、ETagまたは`updated_at`、取得した内容のhash、取得の完全性（全ページを取れたか、rate limitで欠けたか） |

後者の取り込み結果は「その時点に取得した写し」であり、GitHub上の過去の版ではない。同じIDを後で取り直して一致しなくても、写しを書き換えない。Pull Requestの差分やレビューのコメントのように、commit SHAに結び付く部分があっても、状態や本文は可変として扱う。

## 2. 認証

| 方式                               | 使いどころ                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| GitHub App（installation）         | Hostが組織・リポジトリ単位で導入する既定の方式。権限とリポジトリの範囲を導入時に絞れる             |
| GitHub App（利用者の代理）         | 書込みを利用者本人の操作として残す必要がある場合。本人の権限と導入範囲の両方を満たす操作だけを許す |
| Fine-grained personal access token | Trusted local Hostでの個人利用に限る候補。共有のHostでは使わない                                   |

- **事実（要確認）:** installation access tokenは短時間で失効する。`TokenStore`はHostの中でinstallation tokenを取り直し、App の秘密鍵をadapterへ渡さない。
- 接続の識別（`ConnectionKey`）には、installation ID、account、リポジトリの範囲を含める。導入範囲が変わったら接続の世代を進める。
- 操作の目録（[全体設計の3.2.1](../architecture.md#321-認証付き送信の境界)）は、REST / GraphQLの操作ごとに、必要なApp権限（`issues: read`など）を書く。
- GraphQLは一つのendpointに集まり、同じ`operationName`のままでも選択するfield、alias、fragment、対象のリポジトリを変えられる。そこで、目録にはadapterが持つ固定のGraphQL documentを、正規化したdocumentのhashとして登録する。目録はHostの信頼できる側に置き、adapterの実行時の申告では増やせない。Hostは送信の前に次を検査する。
  - 要求のdocumentを同じ規則で正規化したhashが、目録の項目と一致すること。`operationName`は識別の補助に留め、名前が同じでdocumentが違う要求は拒否する。
  - 変数が目録の型に合うこと。owner / repository IDは2.1で認可した範囲に限り、件数の上限、cursorの形、変更（mutation）か読取かを検査する。
  - 任意のdocumentを組み立てる経路（文字列の連結、利用者やAIが与えたquery）を持たない。
- **事実（要確認）:** ファイルのdownload URLは別originへredirectすることがある。認証付きredirectを辿らない規則に従い、目録で扱いを決める。

### 2.1 installationの権限と利用者の閲覧権限

Installation access tokenは、Appを導入したリポジトリの権限で動く。Hostの利用者がそのリポジトリを個人として読めることの証明にはならない。一つのinstallationに複数のプロジェクトのリポジトリが含まれる場合、`ConnectionKey`をsessionに結び付けるだけでは、別のプロジェクトの非公開Issueやファイルが共有のUIやAIへの入力に流れうる。

そこで、installationの権限と、利用者ごとの閲覧の認可を分ける。

- Hostは、installationの中で**principal・projectごとに、読めるrepository IDと操作**を認可する。根拠は、Hostのプロジェクトとリポジトリの対応表（Hostの管理者が設定する共有の方針）か、利用者本人の代理tokenで確かめた本人の閲覧権限のどちらかとし、どちらを使ったかを記録する。
- 認可は、要求の時、再取得の時（`read` job）、cacheから表示する時のそれぞれで確かめる。Cacheはinstallation単位で共有してよいが、表示と受け渡しは認可したrepository IDに絞る。
- 対応表の変更、installationの導入範囲の変更、本人の権限の喪失を検知したら、該当するrepositoryの表示を止め、本人向けの写しを無効にする。
- Installation tokenで読めたという理由だけで、共有content、export、AIへの入力へ渡さない。渡すかどうかはEditorとHostが、認可したrepositoryの範囲の中で決める。

## 3. 読取と同期

- **事実（要確認）:** REST APIはETagによる条件付きGETに対応し、変化がなければ304を返す。`SyncStateStore`の基点として、対象ごとのETag・`updated_at`・最後に見たcommit SHAを保管する。Calendarのsync tokenのような完全な差分の基点ではないため、取りこぼしの検出には定期的な全件照合を併用する。
- Webhookは`WebhookIntake`で受ける。**事実（要確認）:** 署名は`X-Hub-Signature-256`（HMAC-SHA256）で、配送ごとに`X-GitHub-Delivery`のIDが付き、再配送がある。署名を検証し、配送IDで重複を除き、合図として扱って再取得する。通知の本文をcacheへ直接適用しない。
- 順序は保証されない前提にする。古い通知で新しい状態を上書きしないよう、取得し直した資源の`updated_at`やcommit SHAで判定する。
- Rate limitは、応答の残量と`Retry-After`に従って`JobQueue`で待つ。上限を越えて取得できなかった範囲は`incomplete`とし、空や削除として扱わない。
- 非公開リポジトリの内容は、2.1で認可したprincipal・projectとrepository IDに束縛する。

### 3.1 R1の実装（Issue / Pull Requestの一覧）

| 部分             | 実装                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目録             | `createGithubCatalog()`。GraphQLの二つの固定document（`RepositoryIssues`、`RepositoryPullRequests`、`documents.ts`）のhashと変数の型、RESTの変化の照会を載せる。HostはこれをHostの側で一度作って`TokenStore`へ渡す                                                                                                                                                        |
| Repositoryの指定 | GraphQLは`node(id: $repositoryId)`でnode IDを使う。Owner / nameはrename・transferで変わるため、認可と同期の基点をnode IDに束縛する                                                                                                                                                                                                                                        |
| 認可             | 目録の`resources`で、GraphQLの`repositoryId`を`github.repository`、RESTのpathの`owner/repo`を`github.repository-name`として取り出し、Hostが`authorizeResources`で判定する。Hostの対応表は一つのrepositoryについて両方の識別を持つ。表示（`readWorkItems`）でも同じ判定を呼ぶ                                                                                              |
| 変化の照会       | **事実（要確認）:** GraphQLは条件付き要求に対応しない。そこでRESTの`GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=desc&per_page=1`を`If-None-Match`付きで送り、304なら何も読まない。Issueの一覧はPull Requestも含み、どちらかが更新されれば先頭が変わる前提である                                                                                     |
| 差分の読取       | 照会が200なら、更新の新しい順にGraphQLで読み、基点（取得したitemの`updatedAt`の最大）より古いitemが現れたページで止める。基点と同じ時刻のitemは取り直す。走査の途中で更新されたitemは読んだページの先頭へ移って読み落とすことがあるため、基点は走査の開始の時刻（GraphQLの応答の`Date`）より先へ進めない。照会は取得の前に行い、取得中の変化は次の照会で拾う              |
| 全件の照合       | 初回、基点を読めないとき、照会がredirect・403・404・名前の認可の不一致（renameの後）を返したとき、前回の全件の照合から`fullReconcileIntervalMs`（既定6時間）を過ぎたときに、baselineから作り直す。差分では見えない削除・transferはここで反映する                                                                                                                          |
| 公開             | 全ページを`SyncStateStore`のstagingへ適用してから、cacheと基点（`WorkItemsCursor`：repository、ETag、基点の時刻、全件の照合の時刻）を世代のCASで一体に公開する。CASに負けた取得は`superseded`として捨てる。先に公開された世代が新しいとは限らないため、`read` jobは`retry`にし、公開された世代を基に照会し直す。                                                          |
| 401              | Installation tokenは短時間で失効するため、401では一度だけ`TokenStore.refresh`して送り直す。Refreshが`revoked`なら接続の失効として止める                                                                                                                                                                                                                                   |
| 不完全な取得     | Rate limit（`Retry-After`、`x-ratelimit-remaining: 0`と`x-ratelimit-reset`、GraphQLの`RATE_LIMITED`、どちらのheaderもないsecondary rate limitは1分）、5xx、通信の失敗では何も公開せず、`incomplete`と待機の時刻を返す。`read` jobの処理（`createGithubReadHandler`）はこれを`retry`にする。部分的なdata、未知の形の応答、次のページがあるのにcursorのない応答も公開しない |
| Webhook          | `GithubWebhookIntake`が`X-Hub-Signature-256`を検証してから配送IDを記録し、本文からはinstallationとrepositoryのnode IDだけを読んで合図にする。`workItemsJob(signal)`で`read` jobにし、内容は必ず読み直す                                                                                                                                                                   |
| DTO              | `GithubWorkItem`。本文は読まない。Titleは制御文字と双方向の書式文字を除き、URLは`https://github.com/`のものだけを残す。Label（20件）とassignee（10件）が上限で欠けたら`labelsComplete` / `assigneesComplete`を`false`にする。出典は`WorkItemsProvenance`                                                                                                                  |

R1で決めずに残したこと:

- Renameの後、Hostの対応表の`owner/name`が古いままだと照会が名前の認可で拒否され、毎回全件の照合になる。対応表の名前をどう更新するか（取得した`nameWithOwner`をHostへ返すか）は、Host portと合わせて決める。
- 一つのinstallationの通知を、複数のprincipalの接続へどう配るか。R1の`GithubWebhookIntake`は、Hostの`resolve`が一つの接続を返す形にとどめた。
- 304の応答がrate limitの残量を消費しないこと、先頭一件の変化でETagが変わることは、実接続で確かめる（R2）。

## 4. 書込み（W段階以降）

Scheduleと同じく、外部に結果が残る操作は`OperationLedger`で計画・送信権・照合を記録する。GitHub固有の点は次のとおりである。

| 操作                     | 競合と重複の扱い                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ファイルの更新           | **事実（要確認）:** Contents APIの更新は置き換えるファイルのblob SHAを要求する。これを条件付き書込み（`serverPrecondition`）として扱い、不一致は再取得・再計画にする |
| Commitとbranch参照の更新 | 参照の更新はfast-forwardだけを許し、強制更新をしない。既定のbranchへ直接書かず、作業用のbranchとPull Requestを作る                                                   |
| Issue・コメントの作成    | 作成の重複抑止keyを持たない前提で扱う（`unverified`）。結果が不明なら再送せず、作成者・本文の識別子・時刻で照合する。照合できなければ`unknown`を保持する             |
| Issueのlabel・状態の変更 | 条件付き更新の保証を確認できるまで`bestEffort`とし、許容する操作をG-CAS相当の判断で決める                                                                            |

- 本文に埋め込む識別子は、照合のためのHost内の参照だけとし、Editorの内部のリンクや他のArtifactのIDを外部へ出さない。
- Undo・履歴の復元は外部の変更を発火しない。送信済みの変更を戻すのは、新しい計画である。

## 5. 決めていないこと

- 最初に読む対象は、R1でIssue / Pull Requestの一覧とした。リポジトリのファイルは未定。
- 2.1の認可の根拠として、Hostの対応表と本人の代理tokenのどちらを既定にするか。
- GitHub.comだけか、GitHub Enterprise Serverも対象にするか。
- EditorPlatform側のHost port（Data・Document・Reviewのどれから定義するか）。
- 書込みを利用者本人の代理にするか、Appとして行うか。
