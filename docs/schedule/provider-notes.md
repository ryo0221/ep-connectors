# スケジュールエディタの外部連携：Provider Notes

**設計案・未実装**。確認日：2026-10-19。名称は提案。公式の事実・提案・未確認事項を区別する。実接続・外部書込試験は未実施。

接続コンポーネント側の調査であり、[接続コンポーネントの設計](README.md)とともに版0.2まではEditorPlatformに仮に置いていた。内容は移したときのまま（確認日2026-10-19）である。Editorへは、ここで確認した能力と制約を[Editor–Host契約の能力宣言](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/editor-host-contract.md#21-能力を宣言する単位)の共通形式で伝える。下記の状態名・手順の提案と契約が食い違う場合は契約を優先する。

## 1. 対象と接続の分離

**提案：** Outlook・Google Calendar、Teams・Google Meet・Zoomの全てを対象とし、カレンダーと会議サービスを別に選ぶ。仮称`CalendarPort`と`ConferencePort`にProvider adapterを接続して責務を分け、統合APIでも予定と会議の成立を区別する。

| 公式に確認した経路    | 事実と制約                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Calendar＋Meet | `conferenceData.createRequest`＋`conferenceDataVersion=1`で非同期生成。`allowedConferenceSolutionTypes`を確認する。[公式](https://developers.google.com/workspace/calendar/api/guides/create-events)                                                                                                                                                          |
| Outlook＋Teams        | `isOnlineMeeting=true`＋`onlineMeetingProvider=teamsForBusiness`。組織設定と`allowedOnlineMeetingProviders`を確認する。[公式](https://learn.microsoft.com/en-us/graph/outlook-calendar-online-meetings)                                                                                                                                                       |
| 独立した会議          | Graphの`onlineMeeting`は予定を作らない。Meetの`spaces.create`は会議空間を作る。Zoomは作成結果の参加URLを利用する。[Graph](https://learn.microsoft.com/en-us/graph/choose-online-meeting-api)・[Meet](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/create)・[Zoom](https://developers.zoom.us/docs/isv/workflows/create-meeting/) |

**提案：** 組合せごとの権限・通知・更新を検証する。[設計のD1–D4](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/README.md#実装段階)に従い、下書き、期間読取と再照合、単発の外部作用、個別の追加能力の深さで進める。継続的な観測・失効への対応は読取段階から必要である。gate未充足の書込や未対応操作の代用は行わない。

## 2. 認可、アカウント、主催者

**事実：** Graph予定作成の`Calendars.ReadWrite`は個人・職場／学校アカウントに対応するが、`getSchedule`は個人非対応。[予定作成](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0)・[getSchedule](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0)

**事実：** Googleは単一の主催者と参加者コピーを持つ。Graphの`cancel`は主催者のみ。ZoomのUser OAuthと自組織向けServer-to-Server OAuthは別用途。[Google](https://developers.google.com/workspace/calendar/api/concepts/events-calendars)・[Graph](https://learn.microsoft.com/en-us/graph/api/event-cancel?view=graph-rest-1.0)・[Zoom](https://developers.zoom.us/docs/integrations/oauth/)

**提案：** 書込・主催・参加応答・会議ホストの権限を区別する。接続ID、account／tenant、対象、主催者、参加者、通知を計画に固定し、commitで権限を再確認する。成果物編集から他人の接続権限を得ない。表示除去・辞退・中止は別操作。

**事実：** Google desktop、Microsoft desktop／SPA、Zoom public clientには認可コード＋PKCEの経路がある。初回同意、公開配布の検証・審査、組織方針は別条件である。[Google](https://developers.google.com/identity/protocols/oauth2/native-app)・[Microsoft](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)・[Zoom](https://developers.zoom.us/docs/integrations/oauth/)

**未確認：G-OAUTH。** 配布方式ごとのredirect、最小scope、refresh・失効・解除、公開要件を確定する。ローカル認可と停止中の同期は別問題である。**提案：** 資格情報・会議ホスト用URLを成果物・共有履歴・エクスポート・エージェント入力に含めない。

## 3. 通知は外部作用として扱う

**事実：** Graphは参加者付きeventの作成時に全員へ招待を送り、この動作は無効化できない。主催者の予定を削除するとキャンセル通知が送られる。[作成](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0)・[削除](https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0)

**事実：** Googleの`sendUpdates=none`には、外部カレンダーとの同期不良や予定消失を招く可能性の警告がある。無通知の安全な下書き保存手段として扱えない。[events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

**提案：** AI提案・ドラッグ中・共同編集途中は内部下書きとする。`preparePlan`は読取・差分・影響提示までとし、会議URL生成を含む外部変更は権限を満たす`commit`だけで行う。確定対象には通知先、参加情報、系列の影響範囲を含める。接続の認可と今回の相手・内容への送信許可を区別する。

## 4. 実行状態と不確定応答

**提案：** 複数の外部操作を一つの成功／失敗へ潰さず、個別に記録する。

| 状態名の提案              | 意味                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `prepared`                | 未送信。内容・版・対象・実行根拠を提示                                   |
| `dispatching`             | 永続化後に送信中。作用した可能性あり                                     |
| `accepted`                | 受理の証拠あり。非同期処理は未完了の場合あり                             |
| `failed-after-acceptance` | 受理後の会議生成等が失敗した確定結果。他stepの成立を取り消す意味ではない |
| `unknown`                 | timeout・切断・再起動等で作用の有無が不明                                |
| `verified`                | 読み戻した予定／会議が確認対象の状態と一致                               |
| `rejected`／`conflict`    | 不受理を確認／状態・権限の競合                                           |
| `partial`                 | 一部成立の全体状態。個別状態も保持                                       |

`accepted`と`verified`を区別し、`unknown`を未実行に戻さない。`verified`はメール到達・参加承諾の保証ではない。送信前にoperation ID、計画ハッシュ、接続・対象、重複抑止キーを保存し、試行履歴を追記する。再起動後の無条件再送は禁止する。

**提案：** 結果不明時は依存書込を止め、元の接続・既知IDで照合する。GETで見つからなくても未実行とは限らず、件名・日時の一致も同一性の証拠には不足する。反映遅延・権限喪失・移動／削除を区別できなければ`unknown`を保持し、別アカウントへ操作を移し替えない。

## 5. 重複抑止と競合保証

| 操作             | 公式に確認した事実                                                                                                                                                            | 提案・未確認事項                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Google event作成 | 独自event IDを指定可能。一方、分散システムのため作成時のID衝突検出は常に保証されない。[公式](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) | 高エントロピーIDを計画時に固定し、同じIDで照合する。exactly-onceとは表現しない                                 |
| Google Meet生成  | `requestId`で生成要求を識別し、非同期statusを取得できる。[公式](https://developers.google.com/workspace/calendar/api/guides/create-events)                                    | eventの成立と会議生成のpending／success／failureを別に記録する                                                 |
| Graph event作成  | `transactionId`は作成POSTの再試行による重複抑止用。[公式](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0)                                    | 同じ操作・同じ内容に固定。保持期間等を推定せず、更新の競合制御にも流用しない                                   |
| Zoom meeting作成 | 今回の確認では汎用的な作成冪等性保証を確認できていない。[確認対象](https://developers.zoom.us/docs/api/meetings/)                                                             | **G-ZOOM-RECOVERY：** 結果不明のcreateを自動再送しない。自前operation IDやrequest IDをprovider保証と混同しない |

**事実：** Googleは更新・削除の`If-Match`とetag不一致時の412を明記する。insertへの条件付き変更とは別の仕組みである。[version-resources](https://developers.google.com/workspace/calendar/api/guides/version-resources)

**未確認：G-CAS。** Graph event更新・削除のIf-Match保証は公開仕様から確認できていない。`changeKey`・`@odata.etag`や他resourceの仕様から推定しない。[更新](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0)・[削除](https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0)

**提案：** GET比較後のPATCHやアプリ内ロックでは、外部からの同時変更を防げない。条件付き変更と最善努力の検知を区別し、412等では再取得・再計画する。retryはendpoint・操作別に定義し、SDKの自動再送にも適用する。空き時間照会を予約ロックや非重複の原子的保証と扱わない。

## 6. 会議と予定の部分失敗、cleanup、Undo

**提案：** Zoom作成後にcalendar登録が拒否されたら、既存会議IDでcalendar側だけを復旧する。calendarが`unknown`なら照合し、会議を削除しない。Zoomが`unknown`ならcalendar登録を止める。全体を最初から再実行しない。

cleanupは別操作とする。既存・貼付・共有／再利用・作成元不明の会議は失敗補償で削除しない。`createdByThisOperation`も現在の未使用を証明しない。孤立候補と既知IDを提示し、現在の状態・権限で別計画を作る。期限切れ・参照削除・接続解除から自動削除しない。

**事実：** Zoom削除で`occurrence_id`を省くと系列全体が対象。Graphはオンライン化後のprovider切替・オフライン化が制限され、本文の会議案内も保持する必要がある。[Zoom](https://developers.zoom.us/docs/api/meetings/)・[Graph](https://learn.microsoft.com/en-us/graph/choose-online-meeting-api)・[本文](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0)

**提案：** Undo／Redo・履歴復元・成果物／埋め込み削除は内部状態に作用し、外部POSTや取消を発火しない。送信済み操作の取消は現在の資源を読む新しい計画とする。参照削除を外部取消済みと表示しない。

## 7. 同期は観測であり外部変更の命令ではない

**事実：** Googleのwatch通知には変更内容がなく、差分取得が必要。channelは自動更新されず、更新時の重複期間や通知欠落もある。`syncToken`失効等の410では全件同期し直す。[通知](https://developers.google.com/workspace/calendar/api/guides/push)・[差分同期](https://developers.google.com/workspace/calendar/api/guides/sync)

**事実：** Graphの安定版`calendarView/delta`はカレンダーと固定期間に対応する。`nextLink`をたどり、`deltaLink`で一巡を確定する。**`@removed(reason=deleted)`には期間外の追加・更新・削除も含まれるため、予定の実削除の証拠にはならない。**[同期ガイド](https://learn.microsoft.com/en-us/graph/delta-query-events)・[event-delta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0)

**提案：** cursorを接続・account・calendar・query・固定期間・同期世代に結び、期間変更時に流用しない。全ページ適用と次cursor確定を途中停止に耐える方式にする。再同期は該当外部キャッシュだけを再構築し、下書き・操作台帳・`unknown`を残す。自分の変更通知から再送せず、view除去・tombstone・権限喪失を他資源の削除命令にしない。

## 8. コピー、繰り返し、DST

**提案：** 表示を集約しても書込先の`provider + connection + calendar + event`は維持する。両カレンダーへの主催者コピー作成で招待を二重送信しない。

**事実：** Googleは`recurringEventId + originalStartTime`で移動後の発生回を識別し、取消例外を親系列の存続中保持する。iCalUIDはGoogleでは系列内共通、Graphでは各回で異なる。Graphの例外移動には隣接発生日の制約がある。[Google繰返し](https://developers.google.com/workspace/calendar/api/guides/recurringevents)・[Google events](https://developers.google.com/workspace/calendar/api/v3/reference/events)・[Graph event](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0)・[Graph更新](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0)

**提案：** 「この回／系列全体／この回以降」を計画に固定し、大量の個別更新で代用しない。開始時刻やiCalUIDだけで発生回を同定しない。系列変更の部分失敗・例外維持は対応前に確定する。

**事実：** Googleの終日は`date`、endは排他的で、繰り返しにはtimezoneが必要。Graphはmailboxの対応timezoneを確認する。[Google時刻](https://developers.google.com/workspace/calendar/api/concepts/events-calendars)・[end](https://developers.google.com/workspace/calendar/api/v3/reference/events)・[Graph](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0)

**提案：** 日時・地域の時刻による繰り返し・終日の日付を区別する。UTC固定間隔で繰り返さず元のtimezoneとローカル時刻を保持する。DSTの存在しない／二重になる時刻や未対応timezoneを黙って補正しない。

## 9. 実装前のgateと確認証跡

| Gate ID             | 有効化前に確定する事項                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- |
| **G-OAUTH**         | 配布・組織条件、認可と操作権限、資格情報境界、失効・解除を確定                           |
| **G-CAS**           | endpoint別保証を確認するか、保証できない競合と提供範囲を明示決定。GET比較をCASと呼ばない |
| **G-ZOOM-RECOVERY** | create不明時の照合、再送禁止、既知IDでの部分復旧、cleanupと解決不能時の表示を確定        |

証跡にAPI版・endpoint・アカウント・日付を残す。シミュレーションでprovider保証を立証せず、実試験は別途認可した資源で行う。応答喪失・再起動・二重確定・競合・部分失敗・cursor失効・removed・繰り返し・DSTを受入確認する。
