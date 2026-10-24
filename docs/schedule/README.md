# Schedule接続コンポーネントの設計（草案）

**Proposed、版0.3、2026-10-23。Google Calendarの読取だけをR1で実装した（9）。** Google Calendar / Outlook、Google Meet / Teams / Zoomへの接続を実行する側の内部設計を置く。複数のHost（PaoBub製品版、EditorPlatformを組み込む利用者のアプリ）から使う`@ep-connectors/schedule`の設計である。版0.2まではEditorPlatformの`docs/schedule/connector/`に仮に置いていた。ライブラリとして作ることと置き場所は[ADR 001](../decisions/001-library-first-monorepo.md)で決める。永続的な実行部分を担う基盤（[Common Runtime](https://github.com/ryo0221/common-runtime)への適合を含む）と運用主体は、引き続きD3の前に[G-CONNECTOR](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/README.md#実装前gate)で決める。

EditorとHostの間の約束（状態の意味、保存・Undoと送信の分離、私有情報の分離、保証する範囲）の正本は[Editor–Host契約](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/editor-host-contract.md)である。本書はその約束を満たす手順を定め、食い違う場合は契約を優先する。Providerの事実と未確認事項は[Provider Notes](provider-notes.md)にまとめる。

## 1. 範囲

[Editor–Host契約の4.1](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/editor-host-contract.md#41-公開枠と保証する範囲)のとおり、初期版は一つの論理的なHost配備が公開枠と操作台帳を所有する。本書の手順は、その配備の中で複数worker、複数tab、再起動、別plan、別connection handleを通じても公開枠を迂回できないことを目的とする。独立した別Host配備との横断調停は提供しない。将来その能力を加える場合は、共通のtrusted coordinatorへ公開枠を集約する方式・運用主体・移行を別途設計し、受け入れる。

## 2. 実行の手順

最終実行では次を順に行う。

1. Hostの認証済session、現在membership、source権限、共有先、接続同一性、plan期限とdigestを再検証する。
2. Native / private draftのbasisを確認する。実行確定前に変更されていたら古いplanを拒否する。外部basisの条件はProvider固有の保証で検査する。
3. Hostの台帳でoperationと予定の作成枠をatomicにclaimし、送信予定stepを耐久保存する。同じIDで違う内容はconflictとする。Claimの耐久保存が失敗したら送信しない。
4. Claimした計画だけを送信する。最終検査後のnative編集は新しい未反映変更として扱い、送信済みplanを後から書き換えない。
5. 応答、外部ID、非同期処理、読み戻しを記録する。UIへ返すのは本人に許可されたreceiptである。

初期版では一つのnative eventにつき主催者側の公開先を一つとする。Hostは作成元Artifact ID / event IDの公開枠を持ち、正規化したProvider上のaccount / calendarをそこへ束縛する。同じ予定を別tab・別planでprepareした場合や、別connection handleが同じ登録先を指す場合でも、この枠をatomicに確保する。既存binding・作成中・unknownの枠があれば既存操作へ案内するか新規createを拒否する。別の外部登録先を選んでも同じ公開枠を迂回できない。

Unknownの作成枠を、planの期限切れやnativeからの削除だけで解放しない。明示的な予定の複製は新しいnative event IDで区別する。公開先移動・取消後の再作成・複数カレンダーへの主催者側の同時公開は初期非対応とし、既存枠を暗黙に上書きしない。複数のHost配備が同じArtifactへwriteを提供する構成は初期非対応であり、その場合の共通coordinatorは将来の能力として別に受け入れる。

現在権限・membership・connection同一性・plan期限の再確認は、各外部stepと各retryの送信直前にも行う。Queueや非同期処理の待機後に古い判定を使わない。Zoom作成待ちの間に失効した場合、完了したZoomの記録を残して未送信Calendar stepを止める。最初の確定後のnative編集は前述の別差分とし、凍結したpayloadを変更しない。

## 3. Receiptと台帳の記録

Step状態の意味は[Editor–Host契約の5](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/editor-host-contract.md#5-外部作用の状態とreceipt)に従う。

Receiptはstep、外部IDのHost内参照、試行番号、取得時点、Provider request ID、検証条件、要対処理由を追跡する。Raw responseは一般logへ出さず、必要な証拠をfield単位で選択する。台帳の最小化・保持期間・運用者アクセスはG-HOST / G-PRIVACYで決める。

## 4. 再試行・競合・複数資源

### 4.1 不確定な送信

送信前の検証失敗と、送信後のtimeoutを区別する。`dispatching`のまま再起動したoperationは照合対象であり、自動的に新しいPOSTを発行しない。SDK、HTTP client、proxyによるPOSTの暗黙retryもadapterの方針へ合わせる。

Googleのclient指定event IDやGraphの`transactionId`は、それぞれの作成の重複抑止として使う。保持期間・全操作への適用・exactly-onceは推定しない。Google Meetの生成request IDもevent IDとは別に保持する。同一要求の照合と、生成失敗が確定した後の新しい要求を区別する。後者は成立済みeventと公開枠を保った新計画であり、新しい会議生成request IDと通知の作用を確認する。Zoom createで結果が不明なら、未確認のretryをせずG-ZOOM-RECOVERYの照合手順へ進む。

GETで対象が見つからないことだけで、直前の作成が起きなかったとは判定しない。反映遅延、権限変更、別calendar、接続identityの相違を調べる。件名・日時の類似一致だけで、自分が作成した会議と確定しない。

Rate limitや一時障害ではProviderの待機指示とHostの制限を守る。Writeのretryには同じplan・同じ内容・同じidentity・現在権限・重複抑止保証が必要である。再試行可能な時間を越えたら、古い許可を無期限に再利用しない。

### 4.2 更新競合

Google Calendarの条件付き更新・削除は対象etagで行い、不一致は再取得・再計画とする。Graph eventの条件付き更新保証はG-CASで未確認として扱い、`changeKey`を見たことだけでCAS対応を宣言しない。確認結果に応じた操作単位の能力にする。

更新は所有するfieldだけを対象とし、未対応のmetadata、会議設定、本文内のProviderが必要とする情報を保持する。Plain text化した表示用DTOから全件置換payloadを生成しない。保持を保証できないfieldの更新は拒否する。外部の変更を勝手に消すlast-write-winsを共通の既定方針にしない。

### 4.3 ZoomとCalendarの部分完了

基本の順序は、同一planの中でZoom会議を作成し、そのIDを台帳へ保存してから、参加URLを含むCalendar予定を作成する。URL生成前に招待を送り、後から無条件に再通知する順序にはしない。既存会議リンクを使う場合は、作成stepを持たない。

| 結果                             | 復旧                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Zoom verified、Calendar rejected | 部分完了として表示。既存Zoom IDを維持し、修正したCalendar stepから再計画する |
| Zoom verified、Calendar unknown  | Calendar側を照合する。Zoomの再作成・削除を行わない                           |
| Zoom unknown                     | Calendarへの新規送信を止め、Zoomの結果を照合する                             |
| 両方verified、native保存失敗     | 外部完了のreceiptを保持する。Native保存の再試行で外部を再送しない            |
| Zoomだけ作成後に利用者が中止     | ローカル中止と外部cleanupを区別し、孤立候補として提示する                    |

Cleanupは別の外部作用である。初期版は自動削除しない。明示的な削除を提供する場合も、今回作成した資源であること、現在の主催者権限、変更・再利用の有無を確認して新計画にする。既存会議、Personal Meeting ID、共有・再利用された会議、作成経緯が不明な会議、Calendar結果不明の会議を失敗の後始末として削除しない。

## 5. 同期cursor

- Googleの`syncToken`、Microsoftの`nextLink` / `deltaLink`はHost内で不透明に保持する。Principal / provider / tenant / connection / calendar / query条件と取得世代へ束縛する。
- Cursorは、対応する完全なbaselineとcache世代が存在するときだけ使用できる。Reload・process再起動・失効等でbaselineを失ったら、残っているcursorも無効化し、初回読取から再構築する。初期の非永続overlayではこの条件が通常のreloadにも適用される。再構築完了まではincompleteであり、空き判定へ使わない。
- 全ページを取り終えるまで新しい同期基点をcommitしない。部分ページの結果はincompleteとして扱い、旧結果の全削除やfreebusyの空き判定へ使わない。
- Microsoftの期間付きdeltaでは固定windowをキーに含める。表示期間変更時に、別windowのcursorを流用しない。
- Googleの410は該当外部cacheの再構築を意味する。Native draft、Host binding、実行台帳、unknown operationを一緒に消さない。
- 変更通知の重複・順序逆転・欠落・更新時の重なりを想定する。通知だけで完了とせず、再取得と定期的な照合をHostの能力に応じて行う。

Microsoftのdeltaで`@removed(reason=deleted)`が返っても、元資源の削除とは限らない。取得windowから外れた状態を含むため、まずviewのcache所属として処理する。これをZoomや別カレンダーへの削除命令に変換しない。外部削除を別途確認した場合も、対応するnative計画や会議を自動削除せず状態と選択肢を示す。

## 6. Host形態とOAuth

| Host                  | 提供する範囲                                                             | 保証を追加する条件                                                                            |
| --------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 独立Editor / mock     | Syntheticな読取・各種失敗・pure編集。外部connectionなし                  | 実Providerが動く証明にはしない                                                                |
| Trusted local Host    | 対応するOAuth、OS等の安全なtoken store、稼働中のpoll / read              | 再起動を越えるwrite復旧には台帳の耐久性が必要。常時webhook受信を仮定しない                    |
| 制限されたplugin Host | 公開されたconnectorの操作・identity・version・照合能力                   | Actor同一性や必要な保証が欠ける場合は該当writeを無効化する。connector名だけで能力を推定しない |
| Trusted backend Host  | Session認証、tenant分離、durable台帳、queue、HTTPS webhook受信・購読更新 | Dispatch時の再認可、callback検証、復旧、保持方針、運用監視を別に検証する                      |

OAuth client typeにより使える方式が異なる。全環境でclient secretを持てるとも、必要時のincremental authorizationが使えるとも仮定しない。System browser、PKCE、redirect / state / issuer検証、scope・同意、失効処理の実装はG-OAUTHで対象Hostに合わせて確認する。

## 7. 共通の差し口との対応

本書の手順は、[全体設計の3](../architecture.md#3-共通の差し口)の差し口の上に組む。

| 本書の手順                                      | 使う差し口                                                                    | 段階  |
| ----------------------------------------------- | ----------------------------------------------------------------------------- | ----- |
| 2の再検証（権限・membership・接続・plan期限）   | `HostPolicy`（各stepと各retryの送信直前）                                     | D2–D3 |
| 2の公開枠とoperationのatomicなclaim             | `OperationLedger.claim`（予定の公開枠）                                       | D3    |
| 2の4（claimした計画だけを送信）、各stepの送信権 | `OperationLedger.acquireStep`とfencing token                                  | D3    |
| 3のreceiptと台帳の記録                          | `OperationLedger.appendAttempt` / `recordResult`                              | D3    |
| 4.1の不確定な送信の照合、再起動後の再開         | `OperationLedger.listUnresolved` / `acquireReconcile` / `release`、`JobQueue` | D3    |
| 5の同期cursor                                   | `SyncStateStore`（cacheと基点の世代を一体で公開）                             | D2    |
| 5の変更通知                                     | `WebhookIntake`                                                               | D2    |
| 6のOAuthと接続                                  | `TokenStore`、`ConnectionKey`                                                 | D2    |

EditorPlatformのHost port（`ScheduleReadPort` / `ScheduleEffectPort`）は、Hostがこれらの差し口の実装を渡して組み立てる。Provider adapterは`@ep-connectors/schedule/google`、`/microsoft`、`/zoom`のsubpathに置く。provider-notesの仮称`CalendarPort` / `ConferencePort`は、このパッケージの内部の境界とする。

## 8. 検証

接続コンポーネントで証明する観測は、[検証計画の観測層の割当](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/verification-plan.md#観測層の割当)の「接続」列に従う。シナリオIDはEditor側と共通とし、本書では新しいIDを作らない。試験の層の分け方は[試験の設計](../testing.md)に従う。シミュレーションでProviderの保証を立証せず、実接続の試験は別途許可した検証用アカウントと宛先で行う。

## 9. R1の読取（Google Calendar）

`@ep-connectors/schedule/google`に、`events.list`と`syncToken`による読取を実装した（[段階と分野](../roadmap.md)のR1）。偽のProviderで`TokenStore`・`SyncStateStore`・`JobQueue`・`WebhookIntake`の上に通す縦断試験は`packages/schedule/test/`にある。

- 目録は`calendar.events.list`（GET）だけで、scopeは`calendar.events.readonly`とする。書込みの操作は載せない。
- 同期の対象はconnection・calendar・取得条件・固定した期間で束縛する（`googleCalendarScope`）。初回は`timeMin` / `timeMax`で期間を指定して全件を取り、以後は`syncToken`だけで差分を取る。`singleEvents`と`maxResults`は初回と同じ値で送る。
- 基点は`syncToken`と取得した時刻を一つの記録にし、`SyncStateStore`には不透明な文字列として保管する。全ページを適用してから`commit`で公開し、途中で止まれば公開済みの世代のまま残る。
- 410は基点の失効として、そのscopeだけを`invalidate`して全件を取り直す。作り直しが終わるまで読取は`complete: false`になる。台帳には触れない。
- 401は一度だけ`refresh`して同じページを送り直す。失効なら止める（`TokenStore`が基点も無効にする）。429、`rateLimitExceeded` / `userRateLimitExceeded`の403、5xx、通信の失敗では自分で送り直さず、`Retry-After`か既定の待機の後の`read` jobを`JobQueue`へ預ける。
- 読取のDTOはEditorPlatformの`OverlayRead` / `OverlayEvent`と同じ形にした。同期の期間の外は`missing`に入れ、空きとして返さない。接続が現在のsessionのものでなければcacheを返さない。

R2の実接続で次を確かめる。確かめるまで、偽のProviderは保証しない側で振る舞い、adapterもそれに耐える作りにしている。

- `timeMin` / `timeMax`を付けた初回の後の`syncToken`の差分が、期間の外の変更を含むか。Adapterは含む前提で、期間の外へ出た予定をcacheから外す。
- `singleEvents=true`と`syncToken`の組合せでの、繰り返しの発生回の差分の返り方。
- `syncToken`の失効（410）が起きる条件と頻度。
