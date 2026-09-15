# pyodide-worker.jsファイル

## 背景・目的
<!-- なぜ必要か、何をするのか -->

Web Worker として動き、**Pyodide の初期化とユーザコードの実行だけ**を受け持つ（[基本設計 §2.3](../design.md) / [ADR 0005](../ADR/0005-run-pyodide-in-web-worker.md)）。

UI スレッドから分離するのは、ユーザコードが無限ループに入っても**サイドパネルの操作が生き続ける**ようにするためである。停止はこの Worker を `terminate()` で破棄することで実現する（[基本設計 §3.3](../design.md)）ため、破棄されて困るものをここに置いてはならない。編集中のコードは UI 側が `chrome.storage.local` に持つ（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)）。

**DOM には触れない。** 標準出力・標準エラー・標準入力を含め、UI との接点はすべて `postMessage` に限る（[基本設計 §4](../design.md)）。

本モジュールが引き受ける仕事は 3 つ。

1. Pyodide の初期化（`ready` / `initError`）
2. ユーザコードの実行と、その出力・入力・終了の通知（`run` → `stdout` / `stderr` / `stdin` / `done` / `error`）
3. 実行を伴わない構文チェック（`check` → `checkResult`。[ADR 0015](../ADR/0015-check-syntax-before-run-in-worker.md)）

Pyodide の実体は拡張パッケージ内に同梱したものをローカルパスから読み込む。CDN からの取得と `micropip` による PyPI からの取得は Manifest V3 が禁止するため行わない（[ADR 0004](../ADR/0004-use-pyodide-as-python-runtime.md)）。

## 関数一覧
<!-- どのような関数があるのか -->

| 関数名 | 引数 | 返り値 | 内容 |
| ------ | ---- | ------ | ---- |
| `init` | なし | `Promise<void>` | Pyodide を初期化し、`ready` または `initError` を送る |
| `installInput` | `pyodide` | `void` | `builtins.input` を UI へ問い合わせる実装へ差し替える |
| `handleMessage` | `event` | `void` | UI からのメッセージを種別ごとに振り分ける |
| `handleRun` | `payload` | `Promise<void>` | ユーザコードを実行し、`done` または `error` を送る |
| `handleCheck` | `payload` | `void` | `compile()` で構文を検査し、`checkResult` を送る |
| `handleStdinResult` | `payload` | `void` | 待機中の `askLine` の Promise を解決する |
| `askLine` | `prompt` | `Promise<string>` | UI へ `stdin` を送り、応答を待つ |
| `toErrorPayload` | `err` | `{ message, traceback }` | 例外を `error` メッセージのペイロードへ変換する |
| `toDiagnostics` | `err`, `code` | `Diagnostic[]` | `SyntaxError` をエディタ用の診断へ変換する |

モジュールのトップレベルでは `self.onmessage` に `handleMessage` を登録し、続けて `init()` を呼ぶ。**初期化は UI からの指示を待たずに自動で始める**（[基本設計 §3.1](../design.md) の手順 3）。

モジュールが持つ状態は次の 3 つ。いずれも `terminate()` とともに失われる。

| 変数名 | 型 | 内容 |
| ------ | --- | ---- |
| `pyodide` | `PyodideInterface \| null` | 初期化済みのインスタンス。初期化前と初期化失敗時は `null` |
| `currentRunId` | `string \| null` | 実行中の `runId`。`stdout` / `stderr` / `stdin` に載せる |
| `pendingStdin` | `((text: string) => void) \| null` | 入力待ちの `askLine` が持つ resolve |

`pendingStdin` を Map ではなく単一の値で持つのは、**1 つの実行の中で `input()` が並行することはない**ためである。Python 側は `run_sync` で 1 件ずつ直列に待つ。

## 関数詳細
<!-- 各関数の説明 -->

### init関数

- シグネチャ
```js
async function init(): Promise<void>
```

- 概要

同梱した Pyodide を読み込んで初期化し、標準出力・標準エラー・標準入力の差し替えまで済ませてから `ready` を送る。UI はこれを受け取って実行ボタンを有効化する（[基本設計 §3.1](../design.md)）。

初期化には数秒かかる。その間 UI はエディタを編集可能なまま表示しており、待たされるのは実行ボタンの活性だけである。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `Promise<void>` | 結果は `ready` / `initError` として `postMessage` で伝える |

- フロー

1. `loadPyodide({ indexURL })` を呼ぶ。`indexURL` は同梱した `vendor/pyodide/` を `import.meta.url` からの相対で解決する
2. `pyodide.setStdout({ batched: (text) => post(STDOUT, { runId: currentRunId, text }) })` を設定する
3. `pyodide.setStderr({ ... })` を同様に設定する
4. `installInput(pyodide)` を呼ぶ
5. モジュール変数 `pyodide` へ代入する
6. `ready` を送る

`setStdout` の `batched` は行単位で呼ばれる。まとめて送らず逐次送るのは、長時間実行中に画面が無反応に見える状態を避けるためである（[ADR 0005](../ADR/0005-run-pyodide-in-web-worker.md)）。

- 例外処理

いずれかの手順で例外が出た場合、`initError` に `{ message }` を載せて送り、`pyodide` は `null` のままにする。**再試行は本モジュールでは行わない。**

UI 側はこれを出力領域へインラインで表示し、再試行の導線を出す（[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md) / Figma アートボード「06 初期化失敗」）。再試行は Worker の作り直しとして UI が行うため、失敗した Worker がここで粘る必要がない。

初期化に失敗した状態で `run` や `check` が届いた場合の扱いは `handleMessage` を参照。

### installInput関数

- シグネチャ
```js
function installInput(pyodide: PyodideInterface): void
```

- 概要

`builtins.input` を、UI へ問い合わせて応答を同期的に待つ実装へ差し替える（[ADR 0016](../ADR/0016-replace-builtins-input-instead-of-setstdin.md)）。

`pyodide.setStdin()` は使わない。`setStdin` の `stdin` は同期的に文字列を返す C レベルの読み取りフックであり、JSPI のスタックスイッチングの外側にある。Promise を返しても文字列として解釈できず `OSError: [Errno 29] I/O error` になることを実機で確認している。

差し替えは**初期化時に 1 回だけ**行い、実行のたびには行わない。ユーザコードが自分で `builtins.input` を上書きした場合はユーザコードの側が優先され、その状態は Worker が破棄されるまで残る。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `pyodide` | `PyodideInterface` | ○ | 初期化済みのインスタンス |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `askLine` を `globalThis` へ公開し、Python 側から `js` モジュール経由で参照できるようにする
2. 次の内容の Python を `pyodide.runPython` で実行する

```python
import builtins
from pyodide.ffi import run_sync
import js

def _input(prompt=""):
    return run_sync(js.askLine(str(prompt)))

builtins.input = _input
```

**プロンプトを `print` で標準出力へ流さない。** プロンプト文字列は `askLine` に渡され、`stdin` メッセージのペイロードとして UI へ届く（[ADR 0016](../ADR/0016-replace-builtins-input-instead-of-setstdin.md)）。UI 側は 1 回の受信でプロンプトの表示とキャレットの設置をまとめて処理できる。

- 例外処理

行わない。ここでの失敗は初期化の失敗であり、`init` の `try` が受けて `initError` になる。

### handleMessage関数

- シグネチャ
```js
function handleMessage(event: MessageEvent): void
```

- 概要

UI から届いたメッセージを `type` で振り分ける。種別の文字列は `protocol.js` の `UI_TO_WORKER` を参照する。

停止要求は受け取らない。停止は UI 側の `terminate()` で行うため、対応するメッセージが存在しない（[基本設計 §4](../design.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `event.data.type` | `string` | ○ | `run` / `stdinResult` / `check` のいずれか |
| `event.data` | `object` | ○ | 種別ごとのペイロード |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `event.data.type` を見る
2. `run` なら `handleRun(event.data)` を呼ぶ
3. `stdinResult` なら `handleStdinResult(event.data)` を呼ぶ
4. `check` なら `handleCheck(event.data)` を呼ぶ
5. いずれにも該当しない場合は何もしない

- 例外処理

`run` と `check` は `pyodide` が `null`（初期化前・初期化失敗）の場合に届き得る。UI 側は `ready` を受け取るまで実行ボタンを無効にし、初期化完了前は検査も行わない（[基本設計 §3.4](../design.md)）ため通常は届かないが、**その抑止は UI の内部事情であり、本モジュールが依存してよい前提ではない。**

`pyodide` が `null` のときは、`run` に対しては `error` を、`check` に対しては空の `checkResult` を返す。無視して黙り込むと、UI 側が `done` も `error` も来ないまま停止ボタンだけが有効な状態で固まる。

### handleRun関数

- シグネチャ
```js
async function handleRun(payload: { runId: string, code: string }): Promise<void>
```

- 概要

ユーザコードを実行する。実行中の標準出力・標準エラーは `init` で設定した `batched` 経由で逐次送られ、終了時に `done` または `error` を送る（[基本設計 §3.2](../design.md)）。

**実行は `pyodide.runPythonAsync` を通す。** JSPI のスタックスイッチングはこの入口を通った実行でのみ有効になり、`input()` の同期化がこれに依存する（[ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md)）。`runPython`（同期版）では `input()` が成立しない。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `payload.runId` | `string` | ○ | 実行の識別子。以降の `stdout` / `stderr` / `stdin` / `done` / `error` に載せる |
| `payload.code` | `string` | ○ | エディタの文書全体 |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `Promise<void>` | 結果は `done` / `error` として `postMessage` で伝える |

- フロー

1. `currentRunId` に `payload.runId` を代入する
2. `await pyodide.runPythonAsync(payload.code)` を呼ぶ
3. 正常に戻れば `done` に `{ runId }` を載せて送る
4. 例外が出れば `toErrorPayload(err)` の結果を `error` に載せて送る
5. `currentRunId` を `null` に戻し、`pendingStdin` も `null` に戻す

実行中に `input()` が呼ばれると `askLine` が `stdin` を送り、`run_sync` がそこで待つ。**Worker のスレッドは止まらない**ため、待機中も `handleMessage` は生きており、`stdinResult` を受け取って実行を再開できる（[基本設計 §3.2](../design.md)）。

戻り値（最後の式の値）は使わない。`done` に載せるのは `runId` のみである（[基本設計 §4](../design.md)）。

- 例外処理

`runPythonAsync` が投げるものは 2 種類ある。

| 種別 | 例 | 扱い |
| ---- | ---- | ---- |
| `PythonError` | ユーザコードの実行時例外 | `toErrorPayload` で `message` と `traceback` に分けて `error` で送る |
| それ以外の JS 例外 | Pyodide 内部の異常、メモリ不足 | 同じく `error` で送る。`traceback` は空文字 |

**どちらも UI から見れば「実行が異常終了した」であり、区別して扱う理由がない。** 出力領域にインラインで表示される点も同じ（[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md)）。

ユーザが停止ボタンを押した場合、本関数は例外を受け取らない。Worker ごと破棄されるため、`error` も `done` も送られない（[基本設計 §3.3](../design.md)）。UI 側はこれを「停止」として自分で状態を進める。

### handleCheck関数

- シグネチャ
```js
function handleCheck(payload: { checkId: string, code: string }): void
```

- 概要

`compile(code, "<editor>", "exec")` を呼んで構文エラーの有無を調べ、`checkResult` を返す（[ADR 0015](../ADR/0015-check-syntax-before-run-in-worker.md)）。**ユーザコードは実行しない。**

Worker 側で行うのは、UI スレッドに Python の実行系を持たないためである。CodeMirror の Python パーサはハイライトのためのものであり、CPython と同じ構文判定を行わない。実行時と同じ `compile()` で判定することで、エディタが出す診断と実行結果が食い違わない。

CPython は最初の構文エラーで解析を止めるため、**一度に得られる診断は最大 1 件**である。

**実行中・入力待ちの `check` も拒まない。** JSPI で実行が中断している最中に `compile()` を呼べること、その `compile()` が `SyntaxError` を正しく検出することを実機で確認した（`spike/lifecycle-check/`、2026-09-15）。`currentRunId` を見た門を Worker 側に置く必要はない。

[基本設計 §3.4](../design.md) が実行中・入力待ちの検査を抑止するのは、**下線を消さないための UI 側の都合**であって安全性のためではない。抑止する主体は UI であり、本モジュールはその内部事情に依存しない。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `payload.checkId` | `string` | ○ | 検査の識別子。`checkResult` にそのまま載せ返す |
| `payload.code` | `string` | ○ | 検査するコード |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | 結果は `checkResult` として `postMessage` で伝える |

- フロー

1. Python 側で `compile(code, "<editor>", "exec")` を呼ぶ
2. 例外が出なければ `checkResult` に `{ checkId, diagnostics: [] }` を載せて送る
3. `SyntaxError` が出れば `toDiagnostics(err, code)` で診断へ変換し、`{ checkId, diagnostics }` を送る

同期処理として扱う。`compile()` はユーザコードを実行しないため、待ちが発生しない。

- 例外処理

`SyntaxError` は**正常な結果**であり、例外として扱わない。検出こそが本関数の目的である。

`SyntaxError` 以外の例外（Pyodide 内部の異常など）が出た場合は、空の `diagnostics` を載せた `checkResult` を送る。検査の失敗を実行時エラーとして出力領域に出すことはしない。**出力領域に出るのは実行して得られた結果に限る**（[基本設計 §5.2](../design.md)）ためであり、検査はそこに該当しない。

### handleStdinResult関数

- シグネチャ
```js
function handleStdinResult(payload: { runId: string, text: string }): void
```

- 概要

UI が確定した入力 1 行を受け取り、待機中の `askLine` の Promise を解決する。これにより Python 側の `run_sync` が値を返し、`input()` から実行が再開する（[基本設計 §3.2](../design.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `payload.runId` | `string` | ○ | 応答が属する実行の識別子 |
| `payload.text` | `string` | ○ | 確定した 1 行。末尾の改行は含まない |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `pendingStdin` が `null` なら何もせず戻る
2. `payload.runId` が `currentRunId` と一致しなければ何もせず戻る
3. `pendingStdin` を `null` にしてから、保持していた resolve を `payload.text` で呼ぶ

resolve を呼ぶ前に `pendingStdin` を空にするのは、resolve から同期的に次の `input()` へ進む経路があり得るためである。順序を逆にすると、次の `askLine` が入れた resolve を上書きして消す。

- 例外処理

待機していない状態での `stdinResult`、および `runId` の食い違いは、**例外とせず黙って捨てる。** 入力を確定した直後に停止ボタンが押され、Worker が作り直された、といった経路で正常に起こり得る。

### askLine関数

- シグネチャ
```js
function askLine(prompt: string): Promise<string>
```

- 概要

UI へ `stdin` を送り、応答が返るまで解決しない Promise を返す。Python 側は `run_sync` でこの Promise を待つ（[ADR 0016](../ADR/0016-replace-builtins-input-instead-of-setstdin.md)）。

`globalThis` へ公開し、Python からは `js.askLine` として参照する。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `prompt` | `string` | ○ | `input(prompt)` に渡された文字列。引数なしの `input()` では空文字 |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `Promise<string>` | UI が確定した 1 行。`handleStdinResult` が解決する |

- フロー

1. `stdin` に `{ runId: currentRunId, prompt }` を載せて送る
2. resolve を `pendingStdin` へ保持した Promise を返す

**Promise には reject の経路を持たせない。** 入力待ちの中断は停止ボタンによる Worker の破棄でのみ起こり、その場合この Promise も含めて Worker ごと消える。reject する相手が残らない。

- 例外処理

行わない。上記の通り失敗の経路を持たない。

### toErrorPayload関数

- シグネチャ
```js
function toErrorPayload(err: unknown): { message: string, traceback: string }
```

- 概要

`handleRun` が捕らえた例外を `error` メッセージのペイロードへ変換する（[基本設計 §4](../design.md)）。

UI は `message` と `traceback` を出力領域にインラインで表示する（[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md) / Figma アートボード「05 実行時エラー」）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `err` | `unknown` | ○ | `PythonError` または任意の JS 例外 |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| `message` | `string` | 例外の要約（例: `ZeroDivisionError: division by zero`） |
| `traceback` | `string` | traceback 本体。JS 例外の場合は空文字 |

- フロー

1. `err` が `PythonError` かを判定する
2. `PythonError` なら traceback と要約行を分けて返す
3. そうでなければ `{ message: String(err), traceback: "" }` を返す

- 例外処理

行わない。変換に失敗し得る入力を受けても、`String(err)` に落として必ず値を返す。**エラーの整形でエラーを出すと、元の失敗がユーザに届かなくなる。**

traceback に含まれる Pyodide 内部のフレームの扱いは「未決事項」を参照。

### toDiagnostics関数

- シグネチャ
```js
function toDiagnostics(err: PythonError, code: string): Diagnostic[]
```

- 概要

`compile()` が投げた `SyntaxError` を、エディタが下線とツールチップで表示できる診断へ変換する。

`SyntaxError` は行番号と桁で位置を示すが、CodeMirror の `Diagnostic` は**文書先頭からのオフセット**（`from` / `to`）で位置を表す。両者の橋渡しを本関数が担う。変換に必要な行ごとの長さは `code` から得られるため、**この変換は Worker 側で完結する。**

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `err` | `PythonError` | ○ | `compile()` が投げた `SyntaxError` |
| `code` | `string` | ○ | 検査対象のコード。行頭オフセットの算出に使う |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| `diagnostics` | `Diagnostic[]` | `{ from, to, severity: "error", message }` の配列。要素は最大 1 件 |

- フロー

1. `SyntaxError` から `lineno` / `offset` / `msg` を取り出す
2. `code` を改行で分け、`lineno` 行目の行頭オフセットを求める
3. 行頭オフセットに `offset` を足して `from` を得る
4. `to` を求める（範囲の決め方は「未決事項」）
5. `from` / `to` を `0` 以上 `code.length` 以下に丸める
6. 1 件の配列にして返す

- 例外処理

`lineno` や `offset` が欠けている `SyntaxError` があり得る。その場合は例外とせず、位置を文書先頭（`from = 0`, `to = 0`）に丸めて `message` だけを届ける。**位置が分からないことは、エラーを伝えないことの理由にならない。**

## 未決事項

- **`checkResult` の `diagnostics` の要素の形。** [基本設計 §4](../design.md) は「最大 1 件」としか定めていない。本書では CodeMirror の `Diagnostic`（`{ from, to, severity, message }`）をそのまま Worker から送る前提を置いているが、**Worker が UI 側の描画ライブラリの型に合わせる**という依存の向きになる。行・桁のまま送って UI 側で変換する案もある。決めていない。
- **`toDiagnostics` の `to` の決め方。** `SyntaxError` は範囲ではなく 1 点を示す。行末までを範囲にするか、該当トークンの末尾までにするか、`from + 1` にするかで下線の見え方が変わる。`SyntaxError` の `end_lineno` / `end_offset` が使える場合もあるが、常に入っているとは限らない。決めていない。
- **実行中に次の `run` が届いた場合の扱い。** UI 側は実行中は実行ボタンを無効にするため通常は届かない。届いた場合に拒むか、並行して走らせるか（Pyodide はシングルスレッドのため実質的に不可）、キューに積むかを決めていない。
- **`traceback` に含まれる Pyodide 内部のフレームを削るか。** ユーザコードは `runPythonAsync` 経由で実行されるため、traceback には `/lib/python*.zip/_pyodide/_base.py` などユーザに関係のないフレームが混ざる。加えて、`builtins.input` の差し替え（[ADR 0016](../ADR/0016-replace-builtins-input-instead-of-setstdin.md)）により `input()` 由来の例外には `_input` と `run_sync` のフレームが入る。**そのまま見せると、ユーザは自分の書いていないファイルの行を読むことになる。** 削るかどうか、削る場合の基準を決めていない。
- **`input()` に対する EOF（`Ctrl+D`）を送れるようにするか。** [ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md) が実装時の課題として残したもの。送れるようにする場合、`stdinResult` に EOF を表す値をどう載せるか（`text` を `null` にするか、別の欄を足すか）と、`askLine` の側で `EOFError` をどう起こすかを決める必要がある。
- **`stdout` / `stderr` の `batched` の粒度。** `batched` は行単位で呼ばれるため、`print(..., end="")` を繰り返すコードや、改行を含まない長い出力では通知が遅れる。`raw` に切り替えて文字単位にするとメッセージ数が跳ね上がる。現行の `batched` のままでよいかを決めていない。
- **`indexURL` が指すパス。** [基本設計 §7](../design.md) は「コピー先のパスを Worker の読み込みパスと一致させる」とのみ定めており、`dist/` 内の配置が確定していない。本書では `import.meta.url` からの相対で解決する前提を置いているが、実際の相対段数はビルド定義（`build.js`）の確定待ち。
- **`READY` の前に Python の暖機を行うか。** `loadPyodide` 自体の所要は実機で **1,423ms**（version 314.0.7、`spike/lifecycle-check/`、2026-09-15）。その完了直後は最初の `runPythonAsync` に追加のコストがかかる可能性がある。`ready` を送る前に空のコードを一度実行して均すかどうかを決めていない。[基本設計 §9](../design.md) の検証項目（初期化コスト）と併せて実測が要る。
