# @ep-connectors/editor-ports

EditorPlatform の Host port のうち、公開してよい型を写して固定した契約。分野のパッケージは、EditorPlatform（private）に依存せず、この型を満たす値を返す。試験の設計の[4. EditorPlatform との適合](../../docs/testing.md#4-editorplatformとの適合)の一段目に当たる。

| subpath                                         | 中身                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@ep-connectors/editor-ports/schedule`          | `ScheduleReadPort` / `ScheduleEffectPort` とその入出力の型（[port.ts](src/schedule/port.ts)、写したもの）。値が契約を守っているかの検査（[observations.ts](src/schedule/observations.ts)） |
| `@ep-connectors/editor-ports/schedule/fixtures` | 架空のデータだけの fixture。検証計画のシナリオ ID ごとに、読取・合図・計画・操作の状態を並べた                                                                                             |
| `@ep-connectors/editor-ports/upstream.json`     | 写した元の repository、commit、日付、file ごとの最後の変更の commit、symbol の一覧                                                                                                         |

## 写すもの・写さないもの

[upstream.json](upstream.json) に挙げた symbol だけを、comment も含めてそのまま写す。手で直さない。

写さないものと理由は次のとおり。

| EditorPlatform の symbol                                                                  | 理由                                                                                                 |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ScheduleLaneHost`、`ScheduleLaneState`、`ScheduleLaneItem`、`laneShown`、`laneItemLimit` | Data の参照（Artifact References）を表示する Host の口で、外部接続ではない。内部の参照の型に依存する |
| `effectIntent`、`planBasis`、`summarizeOperation`、`dispatched`、`plainExternalText`      | Editor の実装。Adapter は意図を受け取り、状態を返すだけで、これらを使わない                          |
| `OperationSummary`、`readOnlyText`                                                        | Editor の表示のための型と文言                                                                        |
| `ScheduleEvent`、`RecordLink` などの model                                                | 共有 content の型。Host へは `EffectIntent` の allowlist の field だけが渡る                         |
| `createMockScheduleHost`                                                                  | 決定的な mock Host の実装。Fixture は写さず、契約から本リポジトリで書いた                            |

`observations.ts` と `fixtures.ts` は写したものではない。Editor–Host 契約（3、5、9）と検証計画の観測層の割当の「接続」列から、本リポジトリで書いた。

## 元と比べる、写し直す

EditorPlatform を読める場所（手元、または権限のある CI）で、EditorPlatform の checkout を渡す。

```sh
npm run editor-ports:compare -- ../editor-platform   # comment を除いた宣言を比べる。ずれたら exit 1
npm run editor-ports:sync -- ../editor-platform      # 写し直し、upstream.json の commit を更新する
```

EditorPlatform の port が変わったら、`sync` の結果を PR にして、二段（本リポジトリの CI と、実装の適合）とも通す。公開の CI では EditorPlatform を checkout しないので、`compare` は動かさない。
