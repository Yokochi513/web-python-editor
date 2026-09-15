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

このほか、Python の構文ハイライトに用いる `HighlightStyle` を定数 `pythonHighlightStyle` として公開する。色は Figma の `syntax/*` トークンと 1 対 1 で対応させる（[ADR 0009](../ADR/0009-use-light-theme-as-base.md)）。

`ViewState` は次の形とする。

```js
{ code: string, caret: number, scrollTop: number }
```

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
| `keymap.of([indentWithTab])` + `indentUnit.of("    ")` | Tab インデント（スペース 4） |
| `closeBrackets()` / `bracketMatching()` | 括弧の補完と対応表示 |
| `autocompletion()` | 補完。ソースは `python()` が登録する `localCompletionSource` と `globalCompletion` に任せ、`override` は使わない（[ADR 0018](../ADR/0018-delegate-completion-sources-to-python-support.md)） |
| `drawSelection()` / `dropCursor()` / `highlightSpecialChars()` | 選択とカーソルの描画 |
| `lint` の状態フィールド（`lintGutter` は伴わない） | 構文チェックの表示（[§3.4](../design.md)。`showDiagnostics` から差し込む） |
| `EditorView.updateListener.of(...)` | `onDocChanged` の呼び出し |

含めないもの。折りたたみ（ガターをもう 1 列使う）、検索（狭い幅にパネルを重ねる）、現在行の強調と一致強調（配色トークンが未定義）、矩形選択。

**行の折り返しは行わない。** `EditorView.lineWrapping` を含めない。折り返すと行番号と表示行がずれるため、長い行は横スクロールで扱う。

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

1. 文書全体を `state.code` で置き換える変更を `view.dispatch` する
2. `state.caret` を `0` 以上 `doc.length` 以下に丸め、同じトランザクションで `selection` を設定する
3. `state.scrollTop` を `view.scrollDOM.scrollTop` へ代入する
4. **復元による変更で `onDocChanged` を発火させない。** 発火させると起動直後に保存と構文チェックが走り、何も編集していないのに検査結果が出る

- 例外処理

`state.caret` が文書長を超える場合は例外とせず、文書末尾へ丸める。保存時と復元時でコードが一致しない状況——複数ウィンドウで同時に開いた場合の**後勝ち**（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)）——が正常な経路として存在するため、位置の食い違いは異常ではない。

### showDiagnostics関数

- シグネチャ
```js
function showDiagnostics(view: EditorView, diagnostics: Diagnostic[]): void
```

- 概要

Worker から届いた `checkResult` の内容をエディタ内に下線とツールチップで表示する（[基本設計 §3.4](../design.md) / [ADR 0015](../ADR/0015-check-syntax-before-run-in-worker.md)）。

CodeMirror の `linter()` による周期的な呼び出しは使わず、`@codemirror/lint` の `setDiagnostics()` で**外から差し込む**。検査の実体は Worker 側の `compile()` にあり、結果は非同期に遅れて届くため、押し込む形が実態に合う。

CPython は最初の構文エラーで解析を止めるため、**`diagnostics` は最大 1 件**である。

空配列を渡すと表示中の下線が消える。`main.js` は、検査が通った場合にのみ空配列を渡す。**検査を行わない間（Pyodide の初期化完了前、実行中、入力待ちの間）は本関数を呼ばない。** 呼んで消すと、直ったと読めてしまうため（[基本設計 §3.4](../design.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `view` | `EditorView` | ○ | 対象のインスタンス |
| `diagnostics` | `Diagnostic[]` | ○ | 表示する診断。`{ from, to, severity, message }` の配列。空配列は「表示を消す」を意味する |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `setDiagnostics(view.state, diagnostics)` でトランザクションを組み立てる
2. `view.dispatch` する

診断の位置は、以降の文書変更に合わせて CodeMirror 側が自動で追従させる。検査結果が届くまでの間に編集が進んでいても、下線が無関係な場所へずれることはない。

- 例外処理

`from` / `to` が文書の範囲外を指す場合、`setDiagnostics` は例外を投げる。検査要求を送ってから結果が届くまでの間に**コードが短くなっている**と起こり得る。

`main.js` が `checkId` の照合によって古い結果を捨てることでこの経路はほぼ塞がれるが、本関数でも範囲を文書長へ丸めてから渡し、例外にしない。構文エラーの表示位置がずれることは、下線がまったく出ないことよりは軽い。

## 未決事項

- **`caret` を位置 1 点で持つか、選択範囲で持つか。** [基本設計 §2.2](../design.md) は「キャレット位置」としか書いていない。選択範囲まで復元する方が編集の再開としては自然だが、保存レコードの形が変わる。本書では 1 点（`head`）を仮に置いている。
- **`syntax/*` の配色トークンの実値。** [ADR 0009](../ADR/0009-use-light-theme-as-base.md) と [ADR 0008](../ADR/0008-manage-screen-design-in-figma.md) により Figma で管理するが、トークンの定義がまだない。`pythonHighlightStyle` がどのタグにどの色を割り当てるかは Figma の確定待ち。
- **500ms のデバウンスをどちらに置くか。** 本書では `main.js` に置く前提で `onDocChanged` を素通しにしている。保存（[基本設計 §2.2](../design.md)）と構文チェック（[§3.4](../design.md)）が同じ契機を共有するため 1 箇所にまとめられるが、その 1 箇所が `main.js` であるべきか本モジュールであるべきかは決めていない。
- **`applyViewState` で `onDocChanged` を抑止する手段。** 「復元による変更では発火させない」とだけ決めており、実現方法（トランザクションに注釈を付けて `updateListener` 側で無視するか、リスナ登録前に復元を済ませるか）を決めていない。
- **実行中にエディタを読み取り専用にするか。** [基本設計 §3.2](../design.md) はボタンの活性しか定めていない。実行中に編集できると、表示されているコードと実行中のコードが食い違う。一方で、長い実行の間に次のコードを書けないのは不便である。扱いを決めていない。
- **入力待ちからエディタへフォーカスを戻す経路。** [基本設計 §3.2](../design.md) では `stdin` を受け取ると出力領域へフォーカスが移る。入力の確定後にエディタへ戻すのか、出力領域に留めるのかを決めていない。本モジュールにフォーカス操作の関数が要るかどうかがこれに依存する。
