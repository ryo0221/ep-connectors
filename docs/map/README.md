# Geo接続の設計：vector featureの読取（草案）

**Proposed、版0.2、2026-10-24。R1の範囲を`@ep-connectors/map/ogc-features`に実装した。R2の実接続の試験（9）は手順と試験を用意したが、実配備での結果はまだ記録していない。** 地理データのvector featureを、OGC API Featuresの配備から領域（bbox）で検索し、ページを辿って読むための設計を置く。共通の差し口は[全体設計](../architecture.md)、段階は[段階と分野](../roadmap.md)に従う。下記の「事実」は公開の標準文書に基づく前提であり、R2で実際の配備に当てて確かめ直す。

## 1. 範囲

| 含める（R1）                                                                                | 含めない                                                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Collectionの説明（題名、範囲、CRSの宣言、出典、利用条件のlink）                             | 背景タイル、住所検索（EditorPlatformの背景の契約の変更が先に要る）        |
| 領域での検索と、`next` linkによるページング                                                 | 書込み（Part 4）、属性での絞り込み（Part 3のCQL2）、時刻での絞り込み      |
| 取得した地物の写しを`SyncStateStore`へ一つの世代として公開すること、`read`のjobでの取り直し | CRSの変換。CRS84以外は理由付きで拒否する                                  |
| 認証の要らない配備（`HttpTransport`）と、要る配備（`TokenStore.send`）の両方                | 配備の発見（landing pageやconformanceを読んで目録を作ること）。目録は静的 |

EditorPlatformの側にGeoの外部の参照元のHost portはまだない（[段階と分野の2](../roadmap.md#2-分野の候補)）。R1では本リポジトリの中で読取のDTOを決め、偽の配備で縦断試験をする。

## 2. 前提とする事実（要確認）

- **事実（Part 1）:** 地物は`/collections/{collectionId}/items`で読む。`bbox`（4個または6個の数、既定はCRS84）と`limit`で絞る。最小経度が最大経度より大きい`bbox`は日付変更線をまたぐ。
- **事実（Part 1）:** 応答はGeoJSONの`FeatureCollection`で、`links`の`rel: next`が次のページを指す。Pagingの方式（offset、`startIndex`、不透明なcursor）は配備が決め、clientは`next`を辿る。`numberMatched`・`numberReturned`・`timeStamp`は任意である。
- **事実（Part 1）:** 未知のquery parameterを送ると400を返してよい。そのため、adapterは必要なparameter（`bbox`、`limit`）だけを送る。
- **事実（Part 2）:** CRS84以外で返す配備は`Content-Crs` headerでCRSを示す。Headerがなければ既定のCRS84である。EPSG:4326は軸の順が緯度・経度であり、CRS84と同じものとして扱えない。
- **事実:** Part 1には差分の基点も変更通知もない。写しを新しくするには取り直す。
- **事実:** Offsetによるpagingは、取得の途中で配備のデータが変わると重複や欠落が起き得る。

## 3. 設定と目録

Hostは配備ごとに`OgcFeaturesSource`（Provider名、origin、landing pageのpath、`auth`、scope、pagingのparameter、配備が要る固定のquery）を信頼できる設定として持つ。`ogcFeaturesCatalog(source)`が目録（[全体設計の3.2.1](../architecture.md#321-認証付き送信の境界)）を静的に作る。

| 操作名                | path                                          | query                                                                                                       |
| --------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `features.collection` | `{basePath}/collections/{collectionId}`       | 固定のquery                                                                                                 |
| `features.items`      | `{basePath}/collections/{collectionId}/items` | `bbox`、`limit`、配備が宣言したpagingのparameter（既定は`offset`、`startIndex`、`startindex`）、固定のquery |

固定のquery（`fixedQuery`）は、応答の形式をqueryで決める配備のためにある。pygeoapiは`Accept`から決めた形式を`f=json`として`next` linkに残すため、宣言しないと2ページ目以降を辿れない（9.2）。全ての要求に付け、`next` linkに現れたときは宣言と同じ値に限って辿る（`f=html`などの別の形式へは移らない）。

公開データは`auth: 'none'`とし、`HttpTransport`で送る。認証の要る配備は`auth: 'token'`とし、`TokenStore.send`で送る。どちらもHostの側で目録の検査を通す。

## 4. 読取の手順

`readFeaturesPage(reader, query, cursor)`は一ページを読む。

1. 条件を検査する。`bbox`は経度-180〜180、緯度-90〜90、最小緯度が最大緯度以下。`limit`は1〜10000。通らなければ送らない。
2. 最初のページは`bbox`と`limit`（と配備の固定のquery）だけを付けて送る。`cursor`があれば、それを7と同じ検査に通してから送る。基点は呼出しの外（Editor、キュー）から戻ってくる未信頼の値だからである。
3. 429は`rate-limited`、5xxは`unavailable`とし、`Retry-After`を時刻にして返す。3xxは辿らない（配備の移転は設定の変更として扱う）。
4. `Content-Crs`がCRS84でなければ`unsupported-crs`として拒否する。変換も軸の入れ替えもしない。
5. 地物を一つずつ検査する。Geometryの形（環が閉じている、座標が二つか三つの有限の数）とCRS84の範囲を確かめ、合わないものは捨てずに`rejected`へ位置と理由を入れる。範囲の検査は、緯度・経度を入れ替えた座標の一部も見つける。
6. `properties`の文字列の値は未信頼のplain textとして、制御文字と表示の向きを変える文字を除く。地物のIDと属性の名前は書き換えない。書き換えると別のものと同じ名前になり得るため、そうした文字を含む地物は`invalid-feature`として拒否する。HTMLとして解釈せず、中のURLを自動でfetchしない（[全体設計の5](../architecture.md#5-未信頼の入力と私有情報)）。
7. `next` linkはGeoJSONのもの（HTMLの`next`は選ばない）を選び、次をすべて満たすときだけ`next`として返す：同じorigin、同じcollectionのitemsのpath、`bbox`が数として同じ、宣言したparameterだけを持つ、固定のqueryは宣言と同じ値、`limit`が範囲内。領域を外した全件の取得や、別のcollectionへの付け替えを止めるためである。
8. 出典として、Provider名、origin、collection、取得時刻（`Clock`）、配備の`timeStamp`、応答の`license`・`describedby`のlinkを返す。

`describeCollection`は題名、宣言された範囲、返せるCRS（Part 2の宣言がなければCRS84だけ）、`attribution`、`license`のlinkを返す。利用条件をどう表示し、どこまで使ってよいかの判断は、R2の前に分野ごとに決める（[段階と分野の1](../roadmap.md#1-順番)）。

## 5. 写しと再取得

`syncFeatures`は領域の地物を全ページ読み、`SyncStateStore`へ一つの世代として公開する。

- Scopeは、接続、collection、`bbox`、`limit`、CRSに束縛する（`featuresScope`）。条件の違う写しを流用しない。
- 差分の基点がないため、毎回`stage(scope, null)`でbaselineから作り直し、基点は`null`でcommitする。取り直した写しに現れない地物は消える。
- 全ページを取り終えるまでcommitしない。途中で失敗したら公開せず、公開済みの世代をそのまま残す。次の取得は最初のページからやり直す。
- `expectedGeneration`と公開済みの世代が違えば公開しない（`superseded`）。同じ`read`のjobが二重に配送されても、公開される世代は一つで、古い取得が新しい世代を上書きしない。
- ページ数の上限（既定100）を超える写しと、同じ`next`が繰り返される場合は公開しない。途中までの写しを全体として見せないためである。
- IDのない地物は写しに入れず、`missing-id`としてページと位置を返す。

`createFeaturesReadHandler`はHostのキューの`read`のjobを処理する。Hostは呼ぶ直前に`authorizeDispatch`で再確認する。Rate limitと一時障害（送信後の通信の失敗を含む。読取は外部に作用を残さない）は`retry`、CRS・目録・権限・応答の形の失敗は理由付きで`abandoned`とする。変更通知がないため、写しを新しく保つにはHostが定期的に`read`のjobを預ける。

## 6. 能力

`ogcFeaturesCapabilities(traits)`は、`features.describeCollection`・`features.readPage`・`features.sync`を有効、`features.scheduledRefresh`をHostがキューを持つときだけ有効、`features.changeNotification`を`unsupported-by-provider`とする。書込みは宣言しない。

## 7. 試験

偽の配備（`fake-ogc-server.ts`）は2の事実だけを再現し、offsetのpaging、`Content-Crs`、未知のparameterへの400、`next`の書換え、rate limit・障害の注入を持つ。`MemoryHttpTransport`・`MemoryTokenStore`を通して、Hostの目録の検査も一緒に確かめる。

- 領域の検索、全ページの辿り、日付変更線をまたぐ領域、条件の検査（送らないこと）。
- CRS84以外の拒否。別origin・別collection・領域の変わった・未宣言のparameterを持つ`next`を辿らないこと。外から戻った基点の再検査。
- 形の合わない地物の位置と理由、文字列の無害化、rate limitの待機時刻、redirectを辿らないこと、scopeのない接続で送らないこと。
- 写し：全ページの一つの世代での公開、途中の失敗で公開しないこと、消えた地物の反映、古い取得の`superseded`、接続の解除での破棄。
- Job：二重配送で一つの世代、rate limitの後の`retry`と待機、`authorizeDispatch`の拒否で送らないこと。

## 8. 決めていないこと

- R2の実接続の結果（9.4）と、それを受けた配備の確定。
- EditorPlatformのGeoへつなぐHost portと、写しの大きさの上限。
- 6個の数の`bbox`（高さ）、CRS84h、Part 2の`bbox-crs`を受けるか。
- Offsetのpagingで取得中にデータが変わる場合に、`numberMatched`との食い違いを利用者へどう示すか。

## 9. R2：公開の配備への実接続（issue #11）

R1の偽の配備での成功を実配備の保証とみなさず、認証のない公開の配備へ読取だけの小さな要求を送り、`HttpTransport` → 目録 → `describeCollection` / `readFeaturesPage` / `syncFeatures` → `SyncStateStore` → 出典付きのDTOまでを通す。

### 9.1 候補の配備と利用条件

| 項目           | 内容                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 配備           | OGC CITE向けのpygeoapiのデモ `https://demo.pygeoapi.io/cite`                                                                                                |
| collection     | `lakes`（Large Lakes）                                                                                                                                      |
| 配備の利用条件 | デモのトップにCC-BY 4.0の掲示がある（issue #11の記載。実行時にlanding pageで確かめ直す）。安定性・rate limitの保証はない                                    |
| データの出典   | collectionの説明に世界の湖のpublic domainのデータと記載（同上）。`describeCollection`の`attribution`・`license`のlinkを結果に残す                           |
| 要求の大きさ   | 五大湖の周辺 `bbox=-93,41,-76,49.5`、`limit=2`、最大10ページ。collectionの説明が1回、最初のページが1回、写しの全ページで、合わせて十数回以下の`GET`に収める |

配備の利用条件（API）とデータの出典は分けて記録し、表示には両方の帰属を付ける。デモが使えないときは、別の公的なデモか、明示的に許可したローカルの配備を選び、理由をここに残す。

### 9.2 実配備に合わせた変更

pygeoapi 0.24の`api/itemtypes.py`を読み、R1の仮定と違う点を直した。

- **`next` linkの`f=json`:** pygeoapiは`f`がなければ`Accept`から形式を決め、`next`の`href`を`items?f=json&offset=N&bbox=…&limit=…`として返す。R1の`checkNextLink`は未宣言の`f`を`query`として拒否するため、2ページ目で止まっていた。`OgcFeaturesSource.fixedQuery`を足し、`{ f: 'json' }`を宣言した配備では最初から`f=json`を送り、`next`の`f`は同じ値のときだけ辿る。偽の配備にも同じ挙動（`fixedQuery`）を足して回帰試験にした。
- **Paging:** `offset`方式。`next`は`numberMatched > limit + offset`か、返した件数が`limit`と同じときに付く。後者のため、件数がちょうど割り切れると空の最後のページを一回読む。
- **CRS:** CRS84の配備は`Content-Crs: <http://www.opengis.net/def/crs/OGC/1.3/CRS84>`を返す。R1の扱いで通る。

### 9.3 手動の実行

```sh
npm ci
npm run test:live   # vitest.live.config.ts。*.live.test.ts だけを一つずつ動かす
```

- 試験は[`pygeoapi-cite.live.test.ts`](../../packages/map/src/ogc-features/pygeoapi-cite.live.test.ts)。`npm run check`と通常のCIは`*.live.test.ts`を含めず、networkもsecretも要らない。Actionsの予算にも依存しない。
- 送信は`@ep-connectors/live`の`FetchHttpTransport`が行う。目録の検査を通った要求だけを送り、redirectを辿らず（`redirect: 'manual'`）、cookieを送らず、30秒と5 MiBの上限を置く。`user-agent`に本issueのURLを入れる。
- 確かめること：CRS84の宣言、最初のページの形（Polygon / MultiPolygon、`limit`以下）と出典、外から戻った基点（領域を外したもの）を送る前に拒否すること、全ページを一つの世代として公開し、`stored + rejected = numberMatched`であること。
- 出力は日時、endpoint、collection、出典とlicense、件数、ページ数、拒否の位置と理由、送った要求のpathとqueryだけのJSON。実応答の本体は残さない。
- 不正なCRS、別origin・別collection・未宣言のquery・別形式の`next`、redirect、ページ数の上限は、実配備へ壊れた要求を送らず、偽の配備の試験（`read.test.ts`・`sync.test.ts`）で確かめる。

### 9.4 結果

| 日時   | 環境 | 結果                                                                                                                                                                         |
| ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未実行 | —    | 2026-10-24の開発環境は送信先の許可がなく`demo.pygeoapi.io`へ接続できなかった（`transport`の失敗で止まることは確認した）。許可された環境で9.3を実行し、出力のJSONをここへ写す |

残る`unverified`：配備の実際のcollectionの説明・出典の文言、pagingが複数ページで起きるか、応答の`Content-Type`、rate limit。結果が出るまで、R2のGeoは合格としない。
