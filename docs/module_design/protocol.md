# protocol.jsファイル

## 背景・目的
<!-- なぜ必要か、何をするのか -->

サイドパネル UI（`main.js`）と Pyodide Worker（`pyodide-worker.js`）は別々の実行コンテキストに置かれ、両者の接点は `postMessage` で運ばれるオブジェクトの `type` 文字列だけである（[基本設計 §2](../design.md)）。

この文字列を両側にリテラルで直書きすると、綴りの食い違いが**無言の不通**になる。メッセージは正常に届き、`onmessage` も発火し、ただ誰も処理しない。例外も出ないため、実行ボタンが押しても何も起きない、という形でしか表面化しない。

そこで [基本設計 §4](../design.md) のメッセージ仕様を本モジュールに 1 箇所だけ定義し、UI と Worker の両方から import する。ビルドは UI と Worker で別エントリだが（[基本設計 §7](../design.md)）、同じソースが両方のバンドルへ結合されるため定義の実体は 1 つに保たれる。

**本モジュールは型と定数の置き場であり、振る舞いを持たない。** メッセージの送受信そのものは `main.js` と `pyodide-worker.js` が行う。生成関数も検証関数も識別子の採番も置かない（「関数詳細」を参照）。

## 関数一覧
<!-- どのような関数があるのか -->

**本モジュールは関数を公開しない。** 公開するのは次の定数のみである。

| 定数名 | 型 | 内容 |
| ------ | ---- | ---- |
| `UI_TO_WORKER` | `Readonly<Record<string, string>>` | UI → Worker のメッセージ種別。`RUN` / `STDIN_RESULT` / `CHECK` |
| `WORKER_TO_UI` | `Readonly<Record<string, string>>` | Worker → UI のメッセージ種別。`READY` / `STDOUT` / `STDERR` / `STDIN` / `DONE` / `ERROR` / `INIT_ERROR` / `CHECK_RESULT` |

値は [基本設計 §4](../design.md) の `type` 欄と一致させる。定義は `Object.freeze` で凍結し、import 側からの書き換えを防ぐ。

### UI_TO_WORKER

| キー | 値 | ペイロード | 意味 |
| ---- | --- | ---- | ---- |
| `RUN` | `"run"` | `{ runId, code }` | コードの実行要求 |
| `STDIN_RESULT` | `"stdinResult"` | `{ runId, text }` | `stdin` への応答。確定した 1 行。EOF の場合は `text` が `null`（[ADR 0021](../ADR/0021-represent-eof-as-null-stdin-result.md)） |
| `CHECK` | `"check"` | `{ checkId, code }` | 構文チェックの要求（実行は伴わない） |

### WORKER_TO_UI

| キー | 値 | ペイロード | 意味 |
| ---- | --- | ---- | ---- |
| `READY` | `"ready"` | なし | Pyodide の初期化完了 |
| `STDOUT` | `"stdout"` | `{ runId, text }` | 標準出力（逐次） |
| `STDERR` | `"stderr"` | `{ runId, text }` | 標準エラー（逐次） |
| `STDIN` | `"stdin"` | `{ runId, prompt }` | 標準入力の要求。`stdinResult` が返るまで実行を中断する |
| `DONE` | `"done"` | `{ runId }` | 正常終了 |
| `ERROR` | `"error"` | `{ runId, message, traceback }` | 実行時例外 |
| `INIT_ERROR` | `"initError"` | `{ message }` | Pyodide の初期化失敗 |
| `CHECK_RESULT` | `"checkResult"` | `{ checkId, diagnostics }` | 構文チェックの結果。`diagnostics` は `SyntaxDiagnostic` の配列で最大 1 件 |

停止要求のメッセージは存在しない。停止は `worker.terminate()` で行うため（[基本設計 §3.3](../design.md)）。

**`READY` にペイロードは持たせない。** Pyodide のバージョンや初期化の所要時間を載せれば初期化コストの実測に使えるが、実測は使い捨てのスパイクでやることである（`spike/lifecycle-check/` で `loadPyodide` の 1,423ms を測った例がある）。製品のメッセージに測定用の欄を置くと、**以後ずっと誰も読まない欄が残る。**

### ペイロードの型定義

`type` の綴りは定数で守られるが、ペイロードの欄名（`runId` / `text` / `prompt` 等）は両側の直書きのままである。ここは **JSDoc の `@typedef`** で 1 箇所に集める。

```js
/** @typedef {{ runId: string, code: string }} RunPayload */
/** @typedef {{ runId: string, text: string | null }} StdinResultPayload */
/** @typedef {{ line: number, column: number, endLine: number | null, endColumn: number | null, message: string }} SyntaxDiagnostic */
```

型注釈は素の JavaScript のまま書ける（[ADR 0002](../ADR/0002-use-vanilla-js-html-css.md)）。esbuild はトランスパイルを行わないが（[ADR 0007](../ADR/0007-use-esbuild-as-bundler.md)）、JSDoc はコメントなのでそのまま通り、エディタの補完も効く。**責務は「定義」のままで、欄名の一元化だけを果たす。**

`SyntaxDiagnostic` に CodeMirror の `Diagnostic`（`from` / `to` / `severity`）を持ち込まないのは [ADR 0020](../ADR/0020-send-diagnostics-as-line-column.md) による。オフセットへの変換は `editor.js` が行う。

### 生成関数（ファクトリ）は置かない

`makeRun(runId, code)` のような生成関数は置かない。

欄名を 1 箇所に集める目的なら上の `@typedef` で足り、生成関数は本モジュールの責務を「定義」から「組み立て」へ広げる。得られるものも小さい。**`makeRun(code, runId)` と引数を取り違える誤りは、`{ runId, code }` の綴りを間違えるより気づきにくい。** 綴りの誤りは受け手で `undefined` になって表面化するが、引数順の誤りは型の合う値が入れ替わるだけで、そのまま流れていく。

### 検証関数も置かない

受信したメッセージの検証は**受け手側（`main.js` / `pyodide-worker.js`）の責務**とする。

UI と Worker は同じ拡張パッケージ内の相手としか通信しないため、素性の分からないメッセージは届かない。実際に起こり得る想定外は、`terminate()` と Worker の作り直し（[基本設計 §3.3](../design.md)）を挟んだときの**破棄済み Worker からの遅延メッセージ**である。

これは「素性が正しいか」ではなく「**古いか**」の判定であり、判定に要る `currentRunId` / `latestCheckId` を知っているのは受け手だけである。本モジュールには置けない。

### 識別子を採番しない

`runId` / `checkId` の採番は `main.js` が行う（[main.md](main.md) の `nextId`）。発行するのは UI 側だけであり、形式は `run-1` / `check-1` の連番とする。

識別子の**定義**は本モジュールの担当といえるが、**値の生成**は状態を持つ操作である。連番のカウンタを本モジュールに置けば、振る舞いを持たないという前提が崩れる。
