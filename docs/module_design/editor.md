# editor.jsファイル

## 背景・目的
<!-- なぜ必要か、何をするのか -->

サイドパネル UI のうち、**CodeMirror 6 の構成に関する部分だけ**を受け持つ（[基本設計 §2.2](../design.md)）。エディタの生成、文書の取り出しと復元、構文チェック結果の表示を提供し、それ以外——Worker とのやり取り、ボタンの活性、出力領域、`chrome.storage.local` への保存——はすべて `main.js` の担当とする。

分離する理由は [ADR 0014](../ADR/0014-compose-codemirror-extensions-explicitly.md) にある。`basicSetup` を使わず拡張をひとつずつ明示的に並べる方針を採ったため、**どの拡張を含めどれを含めないかという一覧そのものが設計判断の集積**になる。これが UI 制御のコードに混ざると、判断の跡が読み取れなくなる。

`main.js` から見た本モジュールは、CodeMirror 6 の API を直接触らずに済ませるための境界でもある。`EditorView` / `EditorState` / `Transaction` といった CodeMirror の語彙が漏れる範囲を本モジュールに閉じる。

## 関数一覧
<!-- どのような関数があるのか -->

| 関数名 | 引数 | 返り値 | 内容 |
| ------ | ---- | ------ | ---- |
| `createEditor` | `options` | `EditorView` | CodeMirror 6 のインスタンスを生成し、指定要素へ取り付ける |
| `buildExtensions` | `options` | `Extension[]` | 有効にする拡張を明示的に並べた配列を組み立てる |
| `getCode` | `view` | `string` | 現在の文書全体を文字列で取り出す |
| `getViewState` | `view` | `ViewState` | 永続化の対象（コード・キャレット位置・スクロール位置）をまとめて取り出す |
| `applyViewState` | `view`, `state` | `void` | 保存しておいた状態をエディタへ復元する |
| `showDiagnostics` | `view`, `diagnostics` | `void` | 構文チェックの結果を下線とツールチップで表示する |
| `focusEditor` | `view` | `void` | エディタへフォーカスを戻す |

このほか、Python の構文ハイライトに用いる `HighlightStyle` を定数 `pythonHighlightStyle` として公開する。色は Figma の `syntax/*` トークンと 1 対 1 で対応させる（[ADR 0009](../ADR/0009-use-light-theme-as-base.md)）。割り当ては次の通り。

| トークン | 値 | 当てる `tags` |
| --- | --- | --- |
| `syntax/plain` | `#383a42` | 既定。`variableName` / `propertyName` / `operator` / `punctuation` |
| `syntax/keyword` | `#a626a4` | `keyword` / `controlKeyword` / `moduleKeyword` / `operatorKeyword` |
| `syntax/string` | `#50a14f` | `string` / `special(string)`（f-string） |
| `syntax/number` | `#986801` | `number` / `bool` / `null` |
| `syntax/function` | `#4078f2` | `function(variableName)` / `function(definition(variableName))` |
| `syntax/comment` | `#a0a1a7` | `comment` / `lineComment` |

`bool` と `null` を `syntax/number` に寄せるのは、`True` / `False` / `None` が構文上の要素ではなく**リテラル**だからである。`keyword` に寄せると、値であることが色から読めなくなる。

`ViewState` は次の形とする。

```js
{ code: string, caret: number, scrollTop: number }
```

`caret` は**位置 1 点**（`head`）で持ち、選択範囲は保存しない。保存するのは編集の再開位置であって、選択そのものではない。範囲を復元すると、**再開直後の打鍵が選択を置換する**事故になる。複数ウィンドウから同時に開かれた場合は後勝ちで別の内容が復元され得るため（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)）、範囲の意味はそもそも保てない。

## 関数詳細
<!-- 各関数の説明 -->

### createEditor関数

- シグネチャ
```js
function createEditor(options: {
  parent: HTMLElement,
  doc?: string,
  onDocChanged?: () => void,
}): EditorView
```

- 概要

`buildExtensions` が返す拡張一覧で `EditorState` を作り、`parent` に取り付けた `EditorView` を返す。

**Pyodide の初期化を待たずに呼ぶ。** [基本設計 §3.1](../design.md) の通り、エディタは初期化完了前から編集可能な状態で表示し、実行ボタンだけを無効にしておく。初期化には数秒かかるため、その間に編集を始められることを優先する（[ADR 0004](../ADR/0004-use-pyodide-as-python-runtime.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `options.parent` | `HTMLElement` | ○ | エディタを取り付ける要素 |
| `options.doc` | `string` | | 初期文書。省略時は空文字 |
| `options.onDocChanged` | `() => void` | | 文書が変化したときに呼ぶコールバック |

`onDocChanged` は `EditorView.updateListener` から `update.docChanged` が真のときだけ呼ぶ。**デバウンスは行わない。** [基本設計 §2.2](../design.md)（保存）と [§3.4](../design.md)（構文チェック）が求める 500ms の待ちは `main.js` 側の関心事であり、本モジュールは「変わった」という事実だけを伝える。

500ms のデバウンスを `main.js` に置くのは、**保存と構文チェックが同じ契機を共有し、その調停が `main.js` の責務**だからである。本モジュールに置くと、契機の一方（保存）だけを知らないまま待ちを管理することになる。

**復元による変更では `onDocChanged` を呼ばない**（`applyViewState` の項）。

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| `view` | `EditorView` | 生成したインスタンス。以降の関数はすべてこれを第 1 引数に取る |

- フロー

1. `buildExtensions(options)` で拡張の配列を得る
2. `EditorState.create({ doc: options.doc ?? "", extensions })` で状態を作る
3. `new EditorView({ state, parent: options.parent })` で取り付ける
4. `view` を返す

- 例外処理

行わない。ここで失敗するのは拡張の構成そのものが壊れている場合に限られ、実行時の入力に依存しない。**ビルドが通って一度動けば再現しない類の失敗**であり、握り潰すと原因が見えなくなるため、例外はそのまま `main.js` へ伝える。

Pyodide の初期化失敗（`initError`、[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md)）とは別の話である点に注意する。あちらは出力領域へインラインで出すが、エディタが生成できない場合は表示先そのものが存在しない。

### buildExtensions関数

- シグネチャ
```js
function buildExtensions(options: { onDocChanged?: () => void }): Extension[]
```

- 概要

有効にする拡張を明示的に並べた配列を返す（[ADR 0014](../ADR/0014-compose-codemirror-extensions-explicitly.md)）。`basicSetup` は使わない。**この関数の中身が「どの機能を持つエディタか」の定義そのもの**になる。

含めるもの（[基本設計 §2.2](../design.md)）。

| 拡張 | 目的 |
| ---- | ---- |
| `lineNumbers()` | 行番号 |
| `python()` | Python の構文解析 |
| `syntaxHighlighting(pythonHighlightStyle)` | ハイライト。色は Figma の `syntax/*` トークンと対応 |
| `history()` + `historyKeymap` | undo / redo |
| `keymap.of(defaultKeymap)` | 基本キーマップ |
| `indentOnInput()` | 入力時のデデント |
| `keymap.of([{ key: "Tab", run: acceptCompletion }, indentWithTab])` + `indentUnit.of("    ")` | Tab インデント（スペース 4）。**Tab は補完の確定を先に試す。** `completionKeymap` が割り当てているのは Enter だけで Tab は素通しになり、補完を選んでいる最中の Tab が `indentWithTab` に拾われてインデントが入る（実機で判明）。`acceptCompletion` は補完が出ていなければ `false` を返すため、そのまま `indentWithTab` へ落ちる |
| `keymap.of([{ win: "Ctrl-d", linux: "Ctrl-d", run: () => true }])` | **Ctrl+D を握りつぶす。** [ADR 0021](../ADR/0021-represent-eof-as-null-stdin-result.md) がこのキーを入力の打ち切りとして主張している以上、エディタ側で Chrome のブックマークが開くのは不整合になる。エディタには打ち切る入力が無いため何もしないで止める。`win` / `linux` に限るのは、ブックマークに割り当てられているのがその 2 つだからで、mac では `@codemirror/commands` の `deleteCharForward` が生きている |
| `closeBrackets()` + `closeBracketsKeymap` / `bracketMatching()` | 括弧の補完と対応表示。`closeBracketsKeymap` が無いと、自動挿入された括弧対を Backspace で消すときに片方しか消えない。`defaultKeymap` の `deleteCharBackward` より先に置く |
| `autocompletion()` | 補完。ソースは `python()` が登録する `localCompletionSource` と `globalCompletion` に任せ、`override` は使わない（[ADR 0018](../ADR/0018-delegate-completion-sources-to-python-support.md)） |
| `drawSelection()` / `dropCursor()` / `highlightSpecialChars()` | 選択とカーソルの描画 |
| `lint` の状態フィールド（`lintGutter` は伴わない） | 構文チェックの表示（[§3.4](../design.md)。`showDiagnostics` から差し込む） |
| `indentGuides`（自前の `ViewPlugin`） | インデント 1 段ごとに 1px の縦線を引き、段ごとに色を変える（[ADR 0029](../ADR/0029-show-indent-depth-with-colored-guides.md)）。色は Figma の `indent/1`〜`indent/4` を巡回し、値は `var(--indent-1)` として CSS から参照する |
| `EditorView.updateListener.of(...)` | `onDocChanged` の呼び出し |

含めないもの。折りたたみ（ガターをもう 1 列使う）、検索（狭い幅にパネルを重ねる）、現在行の強調と一致強調（配色トークンが未定義）、矩形選択。

**行の折り返しは行わない。** `EditorView.lineWrapping` を含めない。折り返すと行番号と表示行がずれるため、長い行は横スクロールで扱う。

**ブラウザのショートカットと衝突するキーは、パネル全体で意味を揃える。** 現時点で該当するのは `Ctrl+D` のみで、出力領域では EOF（[ADR 0021](../ADR/0021-represent-eof-as-null-stdin-result.md)）、エディタでは何もしない。フォーカスの位置によってブラウザのダイアログが出たり出なかったりする状態を残さない。

**`EditorState.readOnly` / `EditorView.editable` を扱わない。** 実行中・入力待ちの間もエディタは編集可能なままとする（[ADR 0026](../ADR/0026-keep-editor-editable-while-running.md)）。状態によって切り替える経路を作らないため、本モジュールに実行状態が漏れてこない。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `options.onDocChanged` | `() => void` | | `updateListener` から呼ぶコールバック。省略時はリスナを含めない |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| `extensions` | `Extension[]` | `EditorState.create` にそのまま渡せる配列 |

- フロー

1. 上表の拡張を配列リテラルとして並べる
2. `options.onDocChanged` があれば `updateListener` を末尾に加える
3. 配列を返す

- 例外処理

行わない。純粋な組み立てのみで、失敗する経路を持たない。

### getCode関数

- シグネチャ
```js
function getCode(view: EditorView): string
```

- 概要

現在の文書全体を文字列で返す。`run`（実行）と `check`（構文チェック）のペイロードに載せるコードの取得に用いる（[基本設計 §4](../design.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `view` | `EditorView` | ○ | 対象のインスタンス |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| `code` | `string` | 文書全体。改行は LF |

- フロー

1. `view.state.doc.toString()` を返す

- 例外処理

行わない。

### getViewState関数

- シグネチャ
```js
function getViewState(view: EditorView): ViewState
```

- 概要

`chrome.storage.local` へ保存する対象をまとめて取り出す（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)）。保存するのはコード、キャレット位置、スクロール位置の 3 つ（[基本設計 §2.2](../design.md)）。

**出力領域の内容は含めない。** 開き直した時点で Worker は作り直されており、前回の結果だけが残ると現在の出力と誤読されるため、保存対象から外す。本関数が出力領域を一切参照しないことでこれを担保する。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `view` | `EditorView` | ○ | 対象のインスタンス |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| `state.code` | `string` | 文書全体 |
| `state.caret` | `number` | キャレット位置（文書先頭からのオフセット） |
| `state.scrollTop` | `number` | スクロール位置（`view.scrollDOM.scrollTop`） |

- フロー

1. `getCode(view)` でコードを得る
2. `view.state.selection.main.head` でキャレット位置を得る
3. `view.scrollDOM.scrollTop` でスクロール位置を得る
4. 3 つをまとめたオブジェクトを返す

- 例外処理

行わない。

### applyViewState関数

- シグネチャ
```js
function applyViewState(view: EditorView, state: ViewState): void
```

- 概要

保存しておいた状態をエディタへ復元する。パネルを開いた直後、**Pyodide の初期化を待たずに**呼ぶ（[基本設計 §2.2](../design.md)）。

保存レコードが存在しない初回起動時、`main.js` は本関数を呼ばない。空の文書のまま始まる。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `view` | `EditorView` | ○ | 対象のインスタンス |
| `state.code` | `string` | ○ | 復元する文書 |
| `state.caret` | `number` | | キャレット位置。範囲外の場合は文書末尾へ丸める |
| `state.scrollTop` | `number` | | スクロール位置 |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. 文書全体を `state.code` で置き換える変更を、**復元の注釈を付けて** `view.dispatch` する
2. `state.caret` を `0` 以上 `doc.length` 以下に丸め、同じトランザクションで `selection` を設定する
3. `state.scrollTop` を `view.scrollDOM.scrollTop` へ代入する

**復元による変更で `onDocChanged` を発火させない。** 発火させると起動直後に保存と構文チェックが走り、何も編集していないのに検査結果が出る。

抑止は **CodeMirror の `Annotation`** で行う。モジュール内で `Annotation.define()` した印を手順 1 のトランザクションに付け、`buildExtensions` が置く `updateListener` 側で、その印が付いたトランザクションを含む更新では `onDocChanged` を呼ばない。

```js
const restoreAnnotation = Annotation.define();
```

「リスナを登録する前に復元を済ませる」方法も採り得るが、その場合**契約の保証が `main.js` の呼び出し順に依存する。** 注釈なら「復元では発火しない」ことを本関数自身が保証でき、CodeMirror の語彙を本モジュールに閉じるという方針（[ADR 0014](../ADR/0014-compose-codemirror-extensions-explicitly.md)）とも揃う。

- 例外処理

`state.caret` が文書長を超える場合は例外とせず、文書末尾へ丸める。保存時と復元時でコードが一致しない状況——複数ウィンドウで同時に開いた場合の**後勝ち**（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)）——が正常な経路として存在するため、位置の食い違いは異常ではない。

### インデントガイド

`buildExtensions` が組み込む `ViewPlugin`（[ADR 0029](../ADR/0029-show-indent-depth-with-colored-guides.md)）。公開関数ではないため関数一覧には載せない。

行ごとに深さを求め、`Decoration.line` で背景として 1px の縦線を段の数だけ重ねる。位置は `view.defaultCharacterWidth` とインデント幅（スペース 4）から求める。

**色の値を JS に持たない。** `linear-gradient(var(--indent-1), var(--indent-1))` の形で CSS カスタムプロパティを参照し、Figma から写した値の置き場を `style.css` 1 箇所に保つ（[ADR 0008](../ADR/0008-manage-screen-design-in-figma.md)）。

決めた点が 3 つある。

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 空行の深さ | 前後の非空行のうち**浅い方** | 深い方に合わせると、ブロックが終わった後の空行にまで線が伸びる |
| 空行を探す範囲 | 前後 200 行まで | 文書全体を舐めると、空行が続く長い文書で行あたりの計算が効かなくなる |
| 再計算の契機 | `docChanged` / `viewportChanged` / `geometryChanged` | フォントの読み込みで 1 文字の幅が変わると線の位置がずれるため、`geometryChanged` も見る |

**`.cm-line` の左パディングを 0 にする必要がある。** CodeMirror の既定は 6px で、背景の原点と文字の原点がずれていると線が桁に乗らない（`style.css`）。

### showDiagnostics関数

- シグネチャ
```js
function showDiagnostics(view: EditorView, diagnostics: SyntaxDiagnostic[]): void
```

- 概要

Worker から届いた `checkResult` の内容をエディタ内に下線とツールチップで表示する（[基本設計 §3.4](../design.md) / [ADR 0015](../ADR/0015-check-syntax-before-run-in-worker.md)）。

**受け取るのは行・桁で表された診断**であり、CodeMirror の `Diagnostic` への変換は本関数が行う（[ADR 0020](../ADR/0020-send-diagnostics-as-line-column.md)）。Worker 側に CodeMirror の型を組み立てさせると依存の向きが逆になり、`EditorView` などの語彙を本モジュールに閉じるという前提が崩れる。

CodeMirror の `linter()` による周期的な呼び出しは使わず、`@codemirror/lint` の `setDiagnostics()` で**外から差し込む**。検査の実体は Worker 側の `compile()` にあり、結果は非同期に遅れて届くため、押し込む形が実態に合う。

CPython は最初の構文エラーで解析を止めるため、**`diagnostics` は最大 1 件**である。

空配列を渡すと表示中の下線が消える。`main.js` は、検査が通った場合にのみ空配列を渡す。**検査を行わない間（Pyodide の初期化完了前、実行中、入力待ちの間）は本関数を呼ばない。** 呼んで消すと、直ったと読めてしまうため（[基本設計 §3.4](../design.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `view` | `EditorView` | ○ | 対象のインスタンス |
| `diagnostics` | `SyntaxDiagnostic[]` | ○ | 表示する診断。`{ line, column, endLine, endColumn, message }` の配列（[基本設計 §4](../design.md)）。空配列は「表示を消す」を意味する |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. 各要素の `line` / `column` を、現在の文書の行頭オフセットから `from` へ変換する
2. `to` を決める（下記）
3. `from` / `to` を `0` 以上 `doc.length` 以下に丸め、`severity: "error"` を付けて `Diagnostic` にする
4. `setDiagnostics(view.state, ...)` でトランザクションを組み立てる
5. `view.dispatch` する

手順 2 の `to` は次の順で決める。

1. `endLine` / `endColumn` が揃っていればそれを使う
2. 無い場合、および `to <= from` になる場合は**その行の行末**までとする
3. それでもなお `to <= from` の場合に限り、`from` を 1 文字戻す

行末までを引くのは、CPython の `^` が指す位置以降が疑わしいという実態に合うためである。該当トークンの末尾までに絞るには字句解析が要り、**`compile()` だけで済ませるという方針**（[ADR 0015](../ADR/0015-check-syntax-before-run-in-worker.md)）に反する。

**`endColumn` が `from` より手前を指すことは実際にある。** CPython は `'(' was never closed` に対して `end_offset` に `0` を返す（実装時の実機テストで確認）。手順 2 がこれを行末で受けるため、手順 3 まで落ちるのは行末にエラー位置が来る「予期しない EOF」系に限られる。手順 3 は幅 0 の下線が見えないことへの対処であり、`from` を動かすのはその場合だけとする。

診断の位置は、以降の文書変更に合わせて CodeMirror 側が自動で追従させる。検査結果が届くまでの間に編集が進んでいても、下線が無関係な場所へずれることはない。

- 例外処理

`from` / `to` が文書の範囲外を指す場合、`setDiagnostics` は例外を投げる。検査要求を送ってから結果が届くまでの間に**コードが短くなっている**と起こり得る。

`main.js` が `checkId` の照合によって古い結果を捨てることでこの経路はほぼ塞がれるが、本関数でも範囲を文書長へ丸めてから渡し、例外にしない。構文エラーの表示位置がずれることは、下線がまったく出ないことよりは軽い。

### focusEditor関数

- シグネチャ
```js
function focusEditor(view: EditorView): void
```

- 概要

エディタへフォーカスを戻す。**入力待ちから戻る経路のためにある。**

[基本設計 §3.2](../design.md) では `stdin` を受け取ると出力領域へフォーカスが移る。戻す契機を入力の確定時に置かないのは、`input()` がループで繰り返される場合に**フォーカスが出力領域とエディタの間を往復する**ためである。確定のたびに戻しても、次のプロンプトでまた出力領域へ移ることになる。

戻す区切りは実行の終了（`done` / `error`）と停止に置く。`main.js` がそこで本関数を呼ぶ。

**フォーカスが出力領域の中にある場合に限って呼ぶ**（判断は `main.js` 側）。実行中にユーザが自分でエディタを触っていた場合、そのフォーカスを奪い返す理由はない。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `view` | `EditorView` | ○ | 対象のインスタンス |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `view.focus()` を呼ぶ

キャレット位置は動かさない。実行の前に編集していた位置がそのまま残る。

- 例外処理

行わない。
