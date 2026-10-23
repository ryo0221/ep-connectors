# 試験の設計

**Proposed、版0.1、2026-10-23。未実装。** 何をCIで証明し、何を実接続で確かめるかを定める。シミュレーションでProviderの保証を立証しない。

## 1. 差し口の契約試験

`@ep-connectors/testing`は、[全体設計の3](architecture.md#3-共通の差し口)の差し口ごとに契約試験を持つ。試験は実装を受け取る関数としてexportし、メモリ実装もHostの本番実装も同じ試験を通す。

| 差し口            | 契約試験で確かめること                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TokenStore`      | 目録にない操作名・method・origin・pathを送らない。Adapterが`Authorization`・`Cookie`などを指定した要求を拒否する。認証付き要求が別originへredirectされても辿らず、redirect先へtokenを送らない（偽のProviderで送信先の受信を数えて確かめる）。cursor・nextLinkのURLも目録で検査する。応答・error・logにtoken、送信header、`Set-Cookie`が含まれない。同時refreshが一つにまとまる。`revoke`後は`send`が失敗し、同期の基点も無効になる      |
| `OperationLedger` | 同じslotへの同時`claim`で`claimed`は一つだけ。同じoperationで違うdigestは`conflict`。別々のworkerへ同じstepを同時に配送すると、`acquireStep`で送信権を得るのは一つだけで、外部への送信は一回になる。古いfencing tokenでの`appendAttempt` / `recordResult`を拒否する。`dispatching`のまま再起動すると`listUnresolved`に残り、`acquireReconcile`の後は元のworkerの記録が拒否され、証拠なしの`release`も拒否され、未送信として再送されない |
| `JobQueue`        | 同じjobの二重実行で外部への送信が一回になる（台帳と組み合わせて確かめる）。実行の直前に毎回`authorizeDispatch`が呼ばれる                                                                                                                                                                                                                                                                                                                |
| `WebhookIntake`   | 署名・tokenの不一致を拒否する。通知の本文を変更内容として返さない                                                                                                                                                                                                                                                                                                                                                                       |
| `SyncStateStore`  | 条件の違う基点を返さない。Baselineを失うと基点も無効になる。ページの適用中、commitの直前、commitの直後のそれぞれで再起動しても、読む側はcacheと基点が同じ世代のものだけを見る。再起動後は公開済みの世代から再開し、取りこぼし（偽のProviderに置いた変更が最終的にcacheへ現れること）がない。期待した世代と違う`commit`を拒否する                                                                                                        |

「同一プロセス・メモリ上の状態を前提にしない」ことは、契約試験の中で呼出しごとに新しいinstanceを作り、保管だけを共有して確かめる。

## 2. 偽のProviderを使うadapterの試験

`TokenStore.send`と`HttpTransport`の送信先を偽のProviderに差し替え、`Clock`と`IdSource`を固定して、決定的に試験する。偽のProviderは公式の仕様と[Provider Notes](schedule/provider-notes.md)で確認した事実だけを再現し、確認できていない保証（Graphの条件付き更新、Zoom createの重複抑止など）は「保証しない」側で振る舞わせる。

試験の対象は手順である。例として、Scheduleでは次を試験する。

- 送信後のtimeoutで`unknown`になり、照合の前に新しいPOSTを出さない。
- Zoomが`unknown`の間はCalendarへの送信を止める。Zoomだけ成功した場合は既存のZoom IDでCalendarを再計画する。
- Googleの410で外部cacheだけを作り直し、台帳と未解決のoperationを残す。
- Microsoftの`@removed`を元の予定の削除として扱わない。
- 各stepと各retryの直前に権限を再確認し、失効していたら未送信のstepを止める。

シナリオIDはEditorPlatformの[検証計画](https://github.com/ryo0221/editor-platform/blob/main/docs/schedule/verification-plan.md#観測層の割当)と共通にし、「接続」列の観測をここで証明する。本リポジトリで新しいIDを作らない。

## 3. 実接続の試験

次はCIの偽物では証明できない。別途許可した試験用のアカウントと宛先で、通常のCIとは分けて手動か許可制で実行する。

- Providerの重複抑止の保持期間と範囲（Googleのevent ID、Graphの`transactionId`）。
- 条件付き更新の保証（G-CAS）、deltaと変更通知の実際の挙動。
- OAuthの同意・refresh・失効・解除（G-OAUTH）。
- 公開HTTPSでのWebhook受信と購読の更新。
- Zoom createの結果が不明なときの照合（G-ZOOM-RECOVERY）。

結果には、API版・endpoint・アカウントの種類・日付を残す。結果が出るまで、その保証に依存する操作は能力宣言で`unverified`のままにし、有効にしない。資格情報と実在の個人情報は試験の記録へ残さない。

## 4. EditorPlatformとの適合

分野のパッケージがEditorPlatformのHost portを満たすことを、型と振る舞いの両方で確かめる。

EditorPlatformはprivateであり、本リポジトリの公開CIや外部のcontributorはcheckoutできない。そこで検証を二段に分け、公開PRでsecretを扱わない。

| 段             | 実行する場所                                                              | 確かめること                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公開のport契約 | 本リポジトリの通常のCI（secretなし、forkのPRでも動く）                    | 本リポジトリに固定した最小のport契約（型定義とfixture、写した元のEditorPlatformのcommitを記録する）に、adapterの戻り値が代入できる。Fixtureで観測を再現する                       |
| 実装の適合     | EditorPlatformを読める権限を持つprivateなCI（またはEditorPlatform側のCI） | 実際のEditorPlatformのHost portに型が適合する。EditorPlatformのmock Hostで通している観測を、偽のProviderを差し込んだadapterでも通す。固定したport契約が元とずれていないかも比べる |

- 公開のport契約は、Host portのうち公開してよい型だけを写す。EditorPlatformの実装・内部の型は含めない。
- 実装の適合はsecretを使うため、`pull_request_target`などforkのコードにsecretを渡す経路では実行しない。Mainへのpushと、権限のある人が手動で起こした実行に限る。
- EditorPlatformのport契約が変わったら、固定したport契約を更新するPRを出し、二段とも通す。

EditorPlatformは本リポジトリへ依存しないため、この試験は本リポジトリの側だけに置く。
