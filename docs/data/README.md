# Data接続の設計（草案）

**Proposed、版0.1、2026-10-23。R1の読取を`@ep-connectors/data/google-sheets`に実装した（偽のProviderでの試験だけ。実接続は未実施）。** 表計算とDBの外部の表を、EditorPlatformのStructured Dataから読むための`@ep-connectors/data`の設計を置く。共通の差し口は[全体設計](../architecture.md)、段階は[段階と分野](../roadmap.md)に従う。下記の「事実」は2026-10-23時点の公開文書に基づく前提であり、R2の前に公式文書と実接続で確かめ直す。

## 1. 何をつなぐか

R1の最初の接続先は表計算とし、Google Sheetsを選んだ（2026-10-23の決定）。Scheduleの最初の候補（Google Calendar）と同じGoogleのOAuthと`TokenStore`の扱いを共有でき、二つ目の分野が同じProviderを使うことで、`@ep-connectors/provider-google`へ切り出す時点を見極められるためである。Excel オンライン（Microsoft Graph）とDBは後に足す。

| 対象                      | 読取（R1）                     | 書込み（W段階以降、候補） | つなぐ先のEditor（Host portは未定義） |
| ------------------------- | ------------------------------ | ------------------------- | ------------------------------------- |
| Google Sheetsの値の範囲   | A1表記で指定した一つの範囲の値 | 範囲の値の更新            | Structured Data（読取中心のview）     |
| Google Sheetsの書式・数式 | 読まない                       | —                         | —                                     |
| Excel オンライン、DB      | 未着手                         | —                         | Structured Data                       |

## 2. Google Sheetsの読取

- **事実（要確認）:** `GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values:batchGet`は、`ranges`で指定した範囲の値を`valueRanges[].values`（行優先の二次元配列）で返す。末尾の空のセル・空の行は省かれ、範囲が空なら`values`自体がない。
- 範囲はsheet名を含み、sheet名には`/`や空白も書ける。目録の検査はpathの変数に`/`を許さないため、範囲をpathに置く`values/{range}`ではなく、queryで渡す`values:batchGet`を使う。一回の要求で読む範囲は一つに限る。
- 値の取り出し方は二つから選ぶ。既定の`unformatted`は`valueRenderOption=UNFORMATTED_VALUE`と`dateTimeRenderOption=SERIAL_NUMBER`で、数値・真偽値を型のまま、日付をserial numberで受ける。`formatted`は`FORMATTED_VALUE`で、表示どおりの文字列を受ける（localeに依存する）。数式（`FORMULA`）は読まない。
- 必要なscopeは`https://www.googleapis.com/auth/spreadsheets.readonly`とし、目録に載せる。より広いscope（`drive.readonly`など）だけを持つconnectionでは送らない。
- 範囲の指定（spreadsheet IDの形、範囲の長さと制御文字）は送る前に検査し、不正なら`TypeError`で拒否する。

### 2.1 Spreadsheetと範囲の閲覧の認可

`spreadsheets.readonly`のscopeは、接続した利用者が読めるすべてのspreadsheetに届く。Scopeは接続がその表を読めることの証明であり、Hostのprincipal・projectがその表を読んでよいことの証明ではない。そこで、[GitHubのrepository単位の認可](../github/README.md#21-installationの権限と利用者の閲覧権限)と同じく、資源ごとの認可を分ける。

- 目録は要求から二つの資源を取り出す。`google-sheets.spreadsheet`（pathの`spreadsheetId`）と`google-sheets.range`（ちょうど一つの`ranges`の値）である。Hostの`TokenStore.send`は、この組を`HostPolicy.authorizeResources`でprincipal・projectごとに認可し、拒否されたら送らない。範囲のない要求、範囲を二つ以上含む要求も送らない。
- Hostは、projectに登録した（spreadsheet、範囲）の組と完全一致で比べる。A1表記の包含（`A1:D10`が`A1:Z100`に含まれるか）をHostに推定させない。
- 表示のたびに、`readSheetsRange`が同じ組で`authorizeResources`を呼ぶ。Projectから外された表や、spaceから退室した利用者には、写しが残っていても返さない。
- 送信の時に認可されなかった場合（`not-authorized`）は、その範囲の写しを無効にする。

## 3. 読取のDTO

`@ep-connectors/data`の`TableRangeRead`を、表の範囲の読取の共通のDTOとする。Excel・DBを足しても同じ形で返す。

| field                                                                  | 意味                                                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `source`（`provider`、`container`、`requestedRange`、`resolvedRange`） | 出典。指定した範囲と、Providerが解決して返した範囲                                                          |
| `valueRender`                                                          | `unformatted` / `formatted`                                                                                 |
| `rows`、`columnCount`                                                  | 行優先の値。各行を最も長い行の幅に`null`で揃える。空の文字列は空のセルと区別できないため`null`にする        |
| `generation`、`fetchedAt`、`contentHash`                               | 公開済みの世代、その内容を取得した時刻、内容のhash。内容が変わらない再取得では、世代も`fetchedAt`も進めない |

- セルの値は`string | number | boolean | null`だけとし、書式・数式・型の推定（日付・通貨）は含めない。日付の解釈はEditorが行う。
- 公開する範囲は、全体を取り終えたものだけである。途中まで取れた範囲を公開しないため、DTOに不完全の状態を持たない。表示の認可が通らなければその理由を、まだ公開されていなければ`not-synced`を返す。
- 値は未信頼の入力であり、plain textのまま返す。セルの中のURLを開かない。
- 読んだ内容は「その時点の写し」であり、Sheetsの版ではない。

## 4. 同期

Sheetsの値には、Calendarの`syncToken`のような差分の基点がない。そこで`SyncStateStore`を次のように使う。

- Scopeは、connection、spreadsheet ID、取得条件（範囲と`valueRender`）に束縛する。範囲や値の取り出し方が違う写しを流用しない。
- 取得のたびに範囲の全体をbaselineとして`stage(scope, null)`へ書き、全行を`applyPage`で書き終えてから`commit`で公開する。基点（cursor）には内容のhashを置き、hashが公開済みの世代と同じなら新しい世代を作らない。
- 同じ`read` jobが二重に配送されても、jobの`expectedGeneration`を`commit`の世代のCASに使うため、公開は一つだけになる。遅れた配送は、公開済みの世代が期待と違えば送らずに`superseded`として終える。
- 送信中に`TokenStore.revoke`で写しが無効になっても、取得した値を公開しない。公開済みの世代がなければ送る前にstagingを作り、無効化でstagingごと消えるようにする。公開済みの世代があれば、無効化で`commit`のCASが通らなくなる。
- 書込みの途中で止まっても、読む側は前の世代を見る。再起動の後は公開済みの世代から取り直す。
- 変更の通知は使わない。Hostは定期的な`read` jobで取り直す。間隔はHostが決める。

| 応答・状態                                   | 扱い                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 401                                          | 一度だけ`TokenStore.refresh`して送り直す。Refreshが`revoked`なら止め、写しは`revoke`の規則で無効になる |
| 403、404                                     | 読めなくなった表として、その範囲の写しを無効にして止める                                               |
| 400（範囲を解決できない、sheet名の変更など） | 公開済みの写しを残して止める。範囲の指定を直すのは利用者                                               |
| 429、5xx、通信の失敗                         | `Retry-After`（秒）があれば従い、なければ30秒後に`retry`。公開しない                                   |
| 形の合わない応答、別のspreadsheetの応答      | 公開せずに止める                                                                                       |
| セルの数が上限（既定50,000）を越える         | 公開せずに止める                                                                                       |

## 5. 能力

`data.range.read`はR2の実接続の試験まで`unverified`とする。書込みはR1では持たない。

## 6. 決めていないこと

- 最初の接続先が表計算であることは決まったが、Google SheetsかExcel オンラインかは利用者に確認していない。Google Sheetsと解釈して進めた。
- Driveの`files.watch`などの変更通知で`read` jobを起こすか。R1は定期的な取り直しだけとする。
- 日付・通貨の型をEditorへ渡すために、書式の情報（`spreadsheets.get`の`effectiveFormat`）を読むか。
- 上限を越える範囲を分けて読むか。分けると範囲の間で整合しない時点の写しになりうる。
- Excel オンラインとDBの最初の対象、`provider-google`への切り出しの時点。
