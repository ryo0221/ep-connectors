# GitHub接続の設計（草案）

**Proposed、版0.1、2026-10-23。未実装。** GitHubのリポジトリ、Issue、Pull Request、Projectsを、EditorPlatformのEditorから読み、後の段階で書くための`@ep-connectors/github`の設計を置く。共通の差し口は[全体設計](../architecture.md)、段階は[段階と分野](../roadmap.md)に従う。下記の「事実」は2026-10-23時点の公開文書に基づく前提であり、実装の前に公式文書で確かめ直す。実接続の試験はまだ行っていない。

## 1. 何をつなぐか

GitHubの対象は、Data・Filesのどちらか一方に収まらない。IssueやPull Requestは表として見ることも、本文をDocumentとして読むことも、レビューのコメントとして扱うこともできる。そのため、Providerごとのsubpathではなく独立した分野のパッケージにする。どの対象も、認証（GitHub App）、Webhook、rate limitを共有する。

| 対象                             | 読取（R段階）                                                                    | 書込み（W段階以降、候補）                                                | つなぐ先のEditor（Host portは未定義）              |
| -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| Issue / Pull Request             | 一覧、状態、label、assignee、milestone、日付。表・Kanban・Timelineの行として読む | Issueの作成、label・状態の変更、コメントの追加                           | Structured Data（読取中心のview）                  |
| Projects（v2）                   | itemとfield（状態、反復、日付）                                                  | itemのfieldの変更                                                        | Structured Data、Schedule（日付を持つitem）        |
| リポジトリのファイル             | 指定したbranch / commitのMarkdown・画像・CSVなど                                 | 変更をbranchへcommitし、Pull Requestを作る。既定のbranchへ直接pushしない | Document・Data・Slideの取り込み                    |
| Pull Requestのレビューとコメント | 差分の行に付いたコメント、レビューの状態                                         | コメントの追加                                                           | Reviewの表示（EditorPlatformの提案レビューとは別） |

読取はcommit SHAで版を固定する。Branch名だけで取り込んだ内容を「同じ版」と扱わない。取り込んだ内容には、リポジトリ、path、commit SHA、取得日時を出典として残す。

## 2. 認証

| 方式                               | 使いどころ                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| GitHub App（installation）         | Hostが組織・リポジトリ単位で導入する既定の方式。権限とリポジトリの範囲を導入時に絞れる             |
| GitHub App（利用者の代理）         | 書込みを利用者本人の操作として残す必要がある場合。本人の権限と導入範囲の両方を満たす操作だけを許す |
| Fine-grained personal access token | Trusted local Hostでの個人利用に限る候補。共有のHostでは使わない                                   |

- **事実（要確認）:** installation access tokenは短時間で失効する。`TokenStore`はHostの中でinstallation tokenを取り直し、App の秘密鍵をadapterへ渡さない。
- 接続の識別（`ConnectionKey`）には、installation ID、account、リポジトリの範囲を含める。導入範囲が変わったら接続の世代を進める。
- 操作の目録（[全体設計の3.2.1](../architecture.md#321-認証付き送信の境界)）は、REST / GraphQLの操作ごとに、必要なApp権限（`issues: read`など）を書く。GraphQLは一つのendpointに集まるため、目録はendpointではなく、許可したqueryの名前と種類（読取 / 変更）で照合する。任意のqueryを送らせない。
- **事実（要確認）:** ファイルのdownload URLは別originへredirectすることがある。認証付きredirectを辿らない規則に従い、目録で扱いを決める。

## 3. 読取と同期

- **事実（要確認）:** REST APIはETagによる条件付きGETに対応し、変化がなければ304を返す。`SyncStateStore`の基点として、対象ごとのETag・`updated_at`・最後に見たcommit SHAを保管する。Calendarのsync tokenのような完全な差分の基点ではないため、取りこぼしの検出には定期的な全件照合を併用する。
- Webhookは`WebhookIntake`で受ける。**事実（要確認）:** 署名は`X-Hub-Signature-256`（HMAC-SHA256）で、配送ごとに`X-GitHub-Delivery`のIDが付き、再配送がある。署名を検証し、配送IDで重複を除き、合図として扱って再取得する。通知の本文をcacheへ直接適用しない。
- 順序は保証されない前提にする。古い通知で新しい状態を上書きしないよう、取得し直した資源の`updated_at`やcommit SHAで判定する。
- Rate limitは、応答の残量と`Retry-After`に従って`JobQueue`で待つ。上限を越えて取得できなかった範囲は`incomplete`とし、空や削除として扱わない。
- 非公開リポジトリの内容は、読めた本人・導入範囲に束縛する。別の利用者の表示、共有content、export、AIへの入力へ渡すかは、EditorとHostが決める。

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

- 最初に読む対象（Issue / Pull Requestの一覧か、リポジトリのファイルか）。
- GitHub.comだけか、GitHub Enterprise Serverも対象にするか。
- EditorPlatform側のHost port（Data・Document・Reviewのどれから定義するか）。
- 書込みを利用者本人の代理にするか、Appとして行うか。
