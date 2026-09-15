# main.jsファイル

## 背景・目的
<!-- なぜ必要か、何をするのか -->

サイドパネル UI の制御を受け持つ（[基本設計 §2.2](../design.md)）。本拡張で**唯一、他のすべてを繋ぐモジュール**である。

| 相手 | 関わり方 |
| ---- | ---- |
| `editor.js` | CodeMirror のインスタンスを生成させ、文書の取り出し・復元・診断の表示を依頼する |
| `pyodide-worker.js` | Worker として生成し、`postMessage` で実行・検査を依頼し、結果を受け取る |
| `protocol.js` | メッセージ種別の定数を参照する |
| `chrome.storage.local` | 編集中のコードを保存・復元する（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)） |
| DOM | ツールバー（ステータス・実行/停止ボタン）と出力領域を直接操作する |

**Python コードをこのスレッドで実行することはない。** 実行は Web Worker 上の Pyodide が担う（[ADR 0005](../ADR/0005-run-pyodide-in-web-worker.md)）。本モジュールがやるのは依頼と表示だけである。

受け持つ関心は 5 つ。

1. **実行状態の管理** — ステータス表示とボタンの活性を一箇所で切り替える（[ADR 0010](../ADR/0010-show-run-state-in-toolbar-status.md)）
2. **出力領域** — `stdout` / `stderr` / エラーを届いた順に追記する（[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md)）
3. **入力待ち** — 出力領域を入力面として使い、確定した行を Worker へ返す（[ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md) / [ADR 0016](../ADR/0016-replace-builtins-input-instead-of-setstdin.md)）
4. **永続化** — 入力停止から 500ms で保存し、実行時とパネルを閉じる直前にフラッシュする（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)）
5. **構文チェック** — 保存と同じ契機で検査を依頼し、結果をエディタへ渡す（[ADR 0015](../ADR/0015-check-syntax-before-run-in-worker.md)）

このうち 4 と 5 は**同じ契機を共有する**（[基本設計 §3.4](../design.md)）。契機をまとめる責務が本モジュールに置かれるため、デバウンスもここに置く。

## 関数一覧
<!-- どのような関数があるのか -->

| 関数名 | 引数 | 返り値 | 内容 |
| ------ | ---- | ------ | ---- |
| `main` | なし | `Promise<void>` | 起動処理。エディタと Worker を用意し、リスナを登録する |
| `restoreState` | なし | `Promise<void>` | `chrome.storage.local` から編集中のコードを復元する |
| `createWorker` | なし | `Worker` | Worker を生成し、受信リスナを登録する |
| `replaceWorker` | なし | `void` | 実行中の Worker を破棄し、新しい Worker を用意する |
| `handleWorkerMessage` | `event` | `void` | Worker からのメッセージを種別ごとに振り分ける |
| `handleRunClick` | なし | `void` | 実行ボタンの押下。`run` を送る |
| `handleStopClick` | なし | `void` | 停止ボタンの押下。Worker を破棄する |
| `setState` | `next` | `void` | 実行状態を切り替え、ステータスとボタンの活性を更新する |
| `appendOutput` | `kind`, `text` | `void` | 出力領域へ 1 件追記する |
| `clearOutput` | なし | `void` | 出力領域を空にする |
| `beginStdin` | `prompt` | `void` | 入力待ちに入る。プロンプトを出し、キャレットを立てる |
| `commitStdin` | `text` | `void` | 入力を確定し、`stdinResult` を送る |
| `handleDocChanged` | なし | `void` | 文書の変化を受け、500ms のデバウンスを張り直す |
| `onIdle` | なし | `void` | 入力停止から 500ms 後の処理。保存と構文チェックを行う |
| `saveState` | なし | `Promise<void>` | 現在の状態を `chrome.storage.local` へ書く |
| `requestCheck` | なし | `void` | `check` を送る。検査できない状態なら何もしない |
| `applyCheckResult` | `payload` | `void` | 検査結果をエディタへ渡す |
| `nextId` | `prefix` | `string` | `runId` / `checkId` を採番する |

モジュールが持つ状態は次の通り。

| 変数名 | 型 | 内容 |
| ------ | --- | ---- |
| `view` | `EditorView` | `editor.js` が生成したインスタンス |
| `worker` | `Worker` | 現在の Pyodide Worker。停止のたびに差し替わる |
| `state` | `RunState` | 実行状態（下表） |
| `currentRunId` | `string \| null` | 実行中の `runId`。遅延して届いた出力の判別に使う |
| `latestCheckId` | `string \| null` | 最後に送った `checkId`。古い検査結果を捨てるために使う |
| `idleTimer` | `number \| null` | 500ms デバウンスのタイマ |

### 実行状態

[ADR 0010](../ADR/0010-show-run-state-in-toolbar-status.md) に基づき、状態はステータス表示が説明し、ボタンの活性がその時点で可能な操作を示す。Figma のアートボード（[基本設計 §5.3](../design.md)）と 1 対 1 で対応する。

| `state` | アートボード | 実行ボタン | 停止ボタン | 遷移の契機 |
| ------- | ---- | ---- | ---- | ---- |
| `initializing` | 01 初期化中 | 無効 | 無効 | 起動直後、および `replaceWorker` の直後 |
| `ready` | 02 実行可能 | 有効 | 無効 | `ready` を受信 |
| `running` | 03 実行中 | 無効 | 有効 | `run` を送信 |
| `waitingInput` | 08 入力待ち | 無効 | 有効 | `stdin` を受信 |
| `done` | 04 正常終了 | 有効 | 無効 | `done` を受信 |
| `error` | 05 実行時エラー | 有効 | 無効 | `error` を受信 |
| `initError` | 06 初期化失敗 | 無効 | 無効 | `initError` を受信 |
| `restarting` | 07 停止直後 | 無効 | 無効 | 停止ボタンの押下 |

アートボード「09 構文エラー」は本表に含めない。**構文エラーがあっても実行ボタンは無効にしない**（[ADR 0010](../ADR/0010-show-run-state-in-toolbar-status.md)）。検査結果は遅れて届くため、連動させるとボタンの活性が入力の合間に揺れる。09 はエディタ内の下線の有無を示すものであり、ツールバーの状態ではない。

## 関数詳細
<!-- 各関数の説明 -->

### main関数

- シグネチャ
```js
async function main(): Promise<void>
```

- 概要

起動処理。モジュールのトップレベルから呼ぶ。

**エディタの表示と Pyodide の初期化を分離する**のがこの関数の要点である（[基本設計 §3.1](../design.md)）。初期化には数秒かかるため、その完了を待たずにエディタを編集可能な状態で見せ、実行ボタンだけを無効にしておく（[ADR 0004](../ADR/0004-use-pyodide-as-python-runtime.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `Promise<void>` | |

- フロー

1. `setState("initializing")` でツールバーを初期化中にする
2. `createEditor({ parent, onDocChanged: handleDocChanged })` でエディタを生成する（`editor.js`）
3. `createWorker()` で Worker を生成する。Worker は生成された時点で自分から初期化を始める
4. `restoreState()` を呼ぶ。**Pyodide の初期化は待たない**
5. 実行ボタンへ `handleRunClick`、停止ボタンへ `handleStopClick`、クリアボタンへ `clearOutput` を登録する
6. `visibilitychange` に、`document.visibilityState === "hidden"` のとき `saveState` を呼ぶリスナを登録する（[ADR 0019](../ADR/0019-flush-on-visibilitychange-hidden.md)）。**`pagehide` は登録しない**

手順 3 と 4 の順序に意味はない。復元は `chrome.storage.local` の読み取りで、Worker の初期化とは独立に進む。

- 例外処理

`createEditor` が投げた場合は握り潰さない。エディタが生成できていない状態でリスナだけ登録しても、操作の受け皿がない。

`restoreState` の失敗は `main` を止めない（当該関数の項を参照）。

### restoreState関数

- シグネチャ
```js
async function restoreState(): Promise<void>
```

- 概要

`chrome.storage.local` から編集中のコード・キャレット位置・スクロール位置を読み、エディタへ復元する（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)）。

**Pyodide の初期化を待たずに行う**（[基本設計 §2.2](../design.md)）。エディタは初期化前から編集可能であり、復元もその一部である。

**出力領域は復元しない。** 開き直した時点で Worker は作り直されており、前回の結果だけが残ると現在の出力と誤読される。復元直後の出力領域は常に空になる。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `Promise<void>` | |

- フロー

1. `chrome.storage.local.get` でレコードを 1 件読む
2. レコードがなければ何もせず戻る（初回起動）
3. レコードのバージョン欄を確認する
4. `applyViewState(view, record)` でエディタへ復元する（`editor.js`）

- 例外処理

読み取りに失敗した場合、および**レコードのバージョンが未知の場合**は、復元を諦めて空の文書のまま始める。例外は投げない。

復元できないことを理由に起動を止めない。エディタが開いて書き始められることの方が、前回の続きから始められることより優先される。

ただし**復元できなかった事実は握り潰さない。** 出力領域へその旨を 1 行出す（[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md) の「エラーはインラインで出す」に準ずる）。黙って空の文書を出すと、ユーザは前回の編集が消えたと受け取る。

### createWorker関数

- シグネチャ
```js
function createWorker(): Worker
```

- 概要

`pyodide-worker.js` を Worker として生成し、受信リスナを登録する。Worker は生成された時点で自分から Pyodide の初期化を始めるため、本関数から指示は送らない（[基本設計 §3.1](../design.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| `worker` | `Worker` | 生成したインスタンス。モジュール変数 `worker` へ入れる |

- フロー

1. `new Worker(url, { type: "module" })` で生成する
2. `onmessage` に `handleWorkerMessage` を登録する
3. `onerror` を登録する
4. 返す

- 例外処理

`onerror`（Worker のスクリプト自体が読み込めない、トップレベルで例外が出た）は `initError` と同じ扱いにする。`setState("initError")` とし、出力領域へインラインで表示する（[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md)）。

Worker が起動できない場合、Worker 側の `initError` は**送られてこない**。送り手がいないためである。UI 側でこの経路を塞いでおかないと、初期化中のまま永久に止まる。

### replaceWorker関数

- シグネチャ
```js
function replaceWorker(): void
```

- 概要

現在の Worker を破棄し、新しい Worker を用意する。停止処理の実体である（[基本設計 §3.3](../design.md)）。

Pyodide はシングルスレッドで動作するため、実行中のユーザコードへ「中断」を伝える手段がない。**停止は Worker の破棄でしか実現できない。** その代償として Pyodide の状態（import 済みのモジュール、定義済みの変数）はすべて失われる。

作り直しを停止処理の一部として同期的に行うのは、**停止直後に次の実行を待たせない**ためである。ユーザが停止を押した後で初めて初期化を始めると、次の実行までさらに数秒待つことになる。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `worker.terminate()` を呼ぶ
2. `currentRunId` を `null` にする
3. 入力待ちだった場合はキャレットとフォーカスを解除する
4. `createWorker()` で新しい Worker を生成し、`worker` へ入れる
5. `setState("restarting")` とする。以降は新しい Worker の `ready` を待つ

手順 2 が要点である。破棄した Worker から遅れて届くメッセージは、`runId` が `currentRunId` と一致しないため `handleWorkerMessage` が捨てる。

- 例外処理

`terminate()` は失敗しない。破棄された Worker からは `done` も `error` も届かないため、実行の終了通知を待たずに状態を進める。

**入力待ちの最中でも `terminate()` は効く。** JSPI ではスレッドが止まっているわけではなく、そもそも `terminate()` は UI スレッド側の操作である（[ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md)。実機で確認済み）。

### handleWorkerMessage関数

- シグネチャ
```js
function handleWorkerMessage(event: MessageEvent): void
```

- 概要

Worker からのメッセージを `type` で振り分ける。種別の文字列は `protocol.js` の `WORKER_TO_UI` を参照する。

**受信のたびに `runId` を照合する。** 停止（`replaceWorker`）を挟むと破棄済み Worker からの遅延メッセージがあり得るため、`runId` を持つメッセージは `currentRunId` と一致しない限り捨てる（[基本設計 §4](../design.md)）。これが `runId` を設けた目的そのものである。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `event.data.type` | `string` | ○ | `WORKER_TO_UI` のいずれか |
| `event.data` | `object` | ○ | 種別ごとのペイロード |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

種別ごとの処理は次の通り。

| type | 処理 |
| ---- | ---- |
| `ready` | `setState("ready")`。復元済みのコードに対する初回の検査をここで一度行う |
| `stdout` | `appendOutput("stdout", text)` |
| `stderr` | `appendOutput("stderr", text)` |
| `stdin` | `beginStdin(prompt)` し、`setState("waitingInput")` |
| `done` | `currentRunId` を `null` にし、`setState("done")` |
| `error` | `appendOutput("error", message + traceback)` し、`currentRunId` を `null` にして `setState("error")` |
| `initError` | `appendOutput("error", message)` し、`setState("initError")` |
| `checkResult` | `applyCheckResult(payload)` |

`ready` と `initError` は `runId` を持たないため照合しない。`checkResult` は `checkId` で照合する（`applyCheckResult` の項）。

- 例外処理

未知の `type` は何もせず捨てる。

`stdout` / `stderr` が `currentRunId` と一致しない場合も捨てる。**これは異常ではなく、停止の正常な帰結である。** 破棄された実行の出力が新しい実行の出力に混ざる方が問題になる。

### handleRunClick関数

- シグネチャ
```js
function handleRunClick(): void
```

- 概要

実行ボタンの押下を受け、`run` を Worker へ送る（[基本設計 §3.2](../design.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `nextId("run")` で `runId` を採番し、`currentRunId` へ入れる
2. `saveState()` を呼ぶ（実行時のフラッシュ。[基本設計 §2.2](../design.md)）
3. `idleTimer` を解除する。実行中は検査を行わないため、保留中の契機を残さない
4. `getCode(view)` でコードを取り出す
5. `worker.postMessage({ type: RUN, runId, code })` を送る
6. `setState("running")`

出力領域は**自動で消さない。** 消すかどうかは「未決事項」を参照。

- 例外処理

行わない。本関数は `state` が `ready` / `done` / `error` のときにしか呼ばれない（他の状態では実行ボタンが無効）。

ただし**その保証はボタンの活性という表示上のものに過ぎない**ため、`state` が想定外なら何もせず戻る防御を置く。

### handleStopClick関数

- シグネチャ
```js
function handleStopClick(): void
```

- 概要

停止ボタンの押下を受け、`replaceWorker()` を呼ぶ。停止要求のメッセージは送らない。Worker を破棄する以外に実行を止める手段がないため（[基本設計 §3.3](../design.md)）。

**入力待ちの間も停止ボタンは有効である**（[ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md)）。入力待ちは実行の途中であり、そこから抜ける手段が必要になる。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `appendOutput` で停止した旨を 1 行出す
2. `replaceWorker()` を呼ぶ

手順 1 を置くのは、停止すると `done` も `error` も届かず、**出力が途中で途切れたまま何の説明もなく終わる**ためである。途切れた理由が履歴に残らないと、実行が終わったのか止めたのか後から読めない。

- 例外処理

行わない。

### setState関数

- シグネチャ
```js
function setState(next: RunState): void
```

- 概要

実行状態を切り替え、ステータス表示とボタンの活性をまとめて更新する（[ADR 0010](../ADR/0010-show-run-state-in-toolbar-status.md)）。

**状態と表示の対応を本関数 1 箇所に閉じる。** ボタンの `disabled` を各所で直接触ると、状態の数だけ組み合わせが散って整合しなくなる。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `next` | `RunState` | ○ | 「実行状態」の表のいずれか |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `state` へ `next` を代入する
2. 表に従いステータスのインジケータとラベルを更新する
3. 表に従い実行ボタンと停止ボタンの `disabled` を設定する
4. `initError` の場合は再試行の導線を出す（Figma アートボード「06 初期化失敗」）

- 例外処理

行わない。表にない値が渡された場合は何もせず戻る。

### appendOutput関数

- シグネチャ
```js
function appendOutput(kind: "stdout" | "stderr" | "error" | "prompt" | "input" | "notice", text: string): void
```

- 概要

出力領域へ 1 件追記する（[基本設計 §5.2](../design.md)）。**種別ごとのタブや領域は設けない。届いた順に 1 本の流れとして積む。**

実行時例外（`error`）と初期化失敗（`initError`）もダイアログやトーストを使わず、この領域へインラインで出す（[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md)）。

ここに出るのは**実行して得られた結果**に限る。実行前に分かる構文エラーはエディタ内に表示し、この領域には出さない（[基本設計 §5.2](../design.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `kind` | `string` | ○ | 下表のいずれか。表示の見分けに使う |
| `text` | `string` | ○ | 追記する内容 |

| `kind` | 由来 |
| ---- | ---- |
| `stdout` | Worker の `stdout` |
| `stderr` | Worker の `stderr` |
| `error` | Worker の `error` / `initError`、および Worker の起動失敗 |
| `prompt` | `input(prompt)` のプロンプト（`beginStdin` から） |
| `input` | ユーザが確定した入力行（`commitStdin` から） |
| `notice` | 停止した旨、復元できなかった旨など UI 側の説明 |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `kind` に対応するクラスを付けた要素を作る
2. `text` を**テキストとして**入れる。HTML として解釈させない
3. 出力領域の末尾へ追加する
4. 末尾までスクロールする

手順 2 は必須である。`text` にはユーザコードの出力と Python の traceback が入る。文字列として扱わないと、`print("<b>")` のような出力が表示を壊す。

- 例外処理

行わない。

### clearOutput関数

- シグネチャ
```js
function clearOutput(): void
```

- 概要

出力領域を空にする。ツールバーではなく出力領域の見出し右のクリアボタンから呼ばれる（[基本設計 §5](../design.md) のレイアウト図）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. 出力領域の子要素をすべて取り除く

- 例外処理

行わない。入力待ちの最中に呼ばれた場合の扱いは「未決事項」を参照。

### beginStdin関数

- シグネチャ
```js
function beginStdin(prompt: string): void
```

- 概要

入力待ちに入る。プロンプトを出力領域へ書き出し、その末尾にキャレットを立ててフォーカスを移す（[基本設計 §3.2](../design.md)）。

**専用の入力欄は設けない。** 出力領域をそのまま入力面として使う（[ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md)）。プロンプト・入力・その結果の前後関係が 1 本の履歴として読めることを優先する。

プロンプトは `stdin` メッセージのペイロードで届く。Worker は `print` でプロンプトを流さない（[ADR 0016](../ADR/0016-replace-builtins-input-instead-of-setstdin.md)）ため、**プロンプトの表示は本関数の責任である。** ここで出さないと、ユーザは何を聞かれているか分からないままキャレットだけを見ることになる。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `prompt` | `string` | ○ | `input(prompt)` に渡された文字列。引数なしの `input()` では空文字 |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `appendOutput("prompt", prompt)` でプロンプトを出す。空文字でも行は立てる
2. その行の末尾を入力可能にし、キャレットを置く
3. フォーカスを出力領域へ移す
4. 確定のキー操作を待つ

- 例外処理

行わない。

**出力領域が追記専用でなくなるのはこの瞬間だけ**である（[ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md)）。確定すれば静的な行に戻る。

### commitStdin関数

- シグネチャ
```js
function commitStdin(text: string): void
```

- 概要

入力を確定し、`stdinResult` を Worker へ返す。Worker 側では `run_sync` が値を受け取り、`input()` から実行が再開する（[基本設計 §3.2](../design.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `text` | `string` | ○ | 確定した 1 行。末尾の改行は含まない |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. 入力中の行を編集不可にし、キャレットを外す
2. `appendOutput("input", text)` 相当の形で、確定した入力を静的な行として履歴に残す
3. `worker.postMessage({ type: STDIN_RESULT, runId: currentRunId, text })` を送る
4. `setState("running")` で実行中へ戻す

- 例外処理

`state` が `waitingInput` でないときに呼ばれた場合は何もせず戻る。確定の直前に停止ボタンが押された経路があり得る。その場合 `currentRunId` は既に `null` であり、送り先の Worker も破棄されている。

### handleDocChanged関数

- シグネチャ
```js
function handleDocChanged(): void
```

- 概要

エディタの文書が変化したときに `editor.js` の `updateListener` から呼ばれる。**500ms のデバウンスを張り直すだけ**で、保存も検査もここでは行わない。

デバウンスを本モジュールに置くのは、保存（[基本設計 §2.2](../design.md)）と構文チェック（[§3.4](../design.md)）が同じ契機を共有し、その調停が本モジュールの責務だからである。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `idleTimer` が立っていれば解除する
2. 500ms 後に `onIdle` を呼ぶタイマを張る

- 例外処理

行わない。

### onIdle関数

- シグネチャ
```js
function onIdle(): void
```

- 概要

入力が止まってから 500ms 後に一度だけ走る。保存と構文チェックをこの順で行う。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `idleTimer` を `null` に戻す
2. `saveState()` を呼ぶ
3. `requestCheck()` を呼ぶ

保存を先に置くのは、検査が状態によっては見送られる（`requestCheck` の項）のに対し、**保存はどの状態でも行うべき**だからである。

- 例外処理

行わない。個々の失敗は各関数が受ける。

### saveState関数

- シグネチャ
```js
async function saveState(): Promise<void>
```

- 概要

現在のコード・キャレット位置・スクロール位置を `chrome.storage.local` へ単一のレコードとして書く（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)）。

呼ばれる契機は 3 つ。入力停止から 500ms（`onIdle`、主）、実行時（`handleRunClick`）、`visibilitychange` で hidden になったとき。後ろ 2 つはフラッシュであり、デバウンスの待ちを飛ばして即座に書く（[基本設計 §2.2](../design.md)）。

**`pagehide` は使わない。** サイドパネルの文書では発火しないことを実機で確認した（[ADR 0019](../ADR/0019-flush-on-visibilitychange-hidden.md)）。

hidden は**タブを切り替えただけでも発火する。** サイドパネルを閉じた場合と区別がつかないため、区別せず毎回書く。タブの切り替えでは文書が破棄されないので書く必要はないが、書かない条件を設けるとパネルを閉じた際の編集内容を取りこぼす。

**出力領域の内容は保存しない。**

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `Promise<void>` | |

- フロー

1. `getViewState(view)` で保存対象を取り出す（`editor.js`）
2. バージョン欄を付けたレコードを組み立てる
3. `chrome.storage.local.set` で 1 件として書く

レコードは 1 件で、複数ウィンドウから同時に書かれた場合は**後勝ち**とする。`storage.onChanged` による追従は行わない（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)）。

- 例外処理

書き込みに失敗した場合——容量超過が主な原因になる——は、出力領域へ `notice` として 1 行出す。**保存できていないことを黙っていると、パネルを閉じた時点で編集が失われる。**

hidden からの呼び出しでパネルがそのまま閉じる場合、この通知が表示される前に文書が破棄される。その経路では通知が届かないことを許容する。

なお **hidden のハンドラ内で非同期の `storage.set` が完了することは実機で確認済み**である（[ADR 0019](../ADR/0019-flush-on-visibilitychange-hidden.md)）。パネルを閉じた瞬間の記録が残っている。

### requestCheck関数

- シグネチャ
```js
function requestCheck(): void
```

- 概要

`check` を Worker へ送り、構文エラーの検出を依頼する（[ADR 0015](../ADR/0015-check-syntax-before-run-in-worker.md)）。実行は伴わない。

**検査を行わない状態がある**（[基本設計 §3.4](../design.md)）。Pyodide の初期化完了前（`initializing` / `initError`）、および実行中・入力待ちの間（`running` / `waitingInput`）。

その間、**既に表示されている下線は消さずに残す。** 消すと直ったと読めてしまうため、`showDiagnostics` を呼ばずに何もしない。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `state` が `ready` / `done` / `error` のいずれでもなければ何もせず戻る
2. `nextId("check")` で `checkId` を採番し、`latestCheckId` へ入れる
3. `getCode(view)` でコードを取り出す
4. `worker.postMessage({ type: CHECK, checkId, code })` を送る

- 例外処理

行わない。

### applyCheckResult関数

- シグネチャ
```js
function applyCheckResult(payload: { checkId: string, diagnostics: Diagnostic[] }): void
```

- 概要

Worker から届いた検査結果をエディタへ渡す。表示は `editor.js` の `showDiagnostics` が行う。

**`checkId` が最新でない結果は捨てる。** 検査は非同期であり、結果が届くまでに次の入力が進んでいることがある。古い結果を当てると、既に直したエラーの下線が復活する。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `payload.checkId` | `string` | ○ | 検査の識別子 |
| `payload.diagnostics` | `Diagnostic[]` | ○ | 診断。最大 1 件。空配列は「構文エラーなし」 |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `payload.checkId` が `latestCheckId` と一致しなければ何もせず戻る
2. `showDiagnostics(view, payload.diagnostics)` を呼ぶ

空配列を渡すのはここだけである。**検査が通ったときにのみ下線が消える**という関係を保つ。

- 例外処理

行わない。範囲が文書外を指す場合の丸めは `showDiagnostics` の側で行う。

### nextId関数

- シグネチャ
```js
function nextId(prefix: string): string
```

- 概要

`runId` / `checkId` を採番する。発行するのは UI 側だけである。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `prefix` | `string` | ○ | `"run"` または `"check"` |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| `id` | `string` | 同一セッション内で一意な識別子 |

- フロー

1. モジュール内の連番を 1 進める
2. `prefix` と連番を繋いだ文字列を返す

一意性はサイドパネルの文書が生きている間だけ保てればよい。パネルを開き直せば Worker も作り直され、古い識別子を持つ相手は存在しない。

- 例外処理

行わない。

## 未決事項

- **出力領域の入力面をどう実装するか。** [ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md) は「専用の入力欄を設けず出力領域を入力面とする」と決めているが、実現手段を決めていない。出力領域全体を `contenteditable` にする案、入力待ちの間だけ末尾行を `contenteditable` にする案、末尾に透明な `input` 要素を重ねる案がある。**確定済みの行を編集できてしまわないこと**と、**IME が正しく動くこと**の両立が条件になる。
- **入力の確定キーと IME の扱い。** Enter で確定するが、日本語入力では Enter が変換の確定にも使われる。`compositionstart` / `compositionend` を見て変換中の Enter を確定と区別する必要がある。**この区別を誤ると、変換を確定しただけで入力が送信される。** 具体的な判定方法を決めていない。
- **`input()` に対する EOF（`Ctrl+D`）を送れるようにするか。** [ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md) が実装時の課題として残したもの。UI 側のキー操作と、`stdinResult` での表し方の両方を決める必要がある（`pyodide-worker.md` の未決事項と対）。
- **入力履歴（上下キーでの呼び出し）を持つか。** 同じく [ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md) の課題。持つ場合、履歴の寿命（1 回の実行の間か、パネルを開いている間か）も決める必要がある。
- **確定した入力行の見せ方。** 標準出力と同じ色にするか区別するか（[ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md) の課題）。`appendOutput` の `kind` は `input` と `prompt` を分けてあるが、実際に色を分けるかは Figma のアートボード「08 入力待ち」の確定待ち。
- **実行開始時に出力領域を消すか。** 本書では消さない前提を置いた。[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md) の追記の原則には沿うが、実行を繰り返すと前回の結果と混ざって境目が読めなくなる。消す、区切り線を入れる、何もしないの 3 案がある。決めていない。
- **出力領域の上限。** 無限ループで `print` し続けるコードは容易に書ける。行数や文字数の上限を設けるか、設ける場合に古い方から捨てるかを決めていない。**上限がないとパネルが操作不能になる**が、これは Worker の分離（[ADR 0005](../ADR/0005-run-pyodide-in-web-worker.md)）では防げない。出力は UI スレッドの DOM に積まれるためである。
- **入力待ちの最中にクリアボタンを押せるか。** 押せる場合、入力中の行ごと消えることになる。押せなくする、入力行だけ残す、押させて入力も捨てる（実行は入力待ちのまま）の案がある。決めていない。
- **ステータスのラベル文言。** [ADR 0010](../ADR/0010-show-run-state-in-toolbar-status.md) は「状態を表示する」ことを決めたが、8 つの状態それぞれの文言は Figma の確定待ち。`done` と `ready` はボタンの活性が同じであり、**文言だけが両者を区別する**ため、ここの詰めが効く。
- **`initError` からの再試行の導線。** Figma アートボード「06 初期化失敗」は「再試行を提示」としているが、ボタンの置き場所（ツールバーか出力領域の中か）が決まっていない。再試行の実体は `replaceWorker()` になる。
- **`ready` を受けたときの初回検査。** 復元したコードに構文エラーがあった場合、ユーザが何も打たないと `handleDocChanged` が走らず検査の契機が来ない。本書では `ready` の受信時に一度検査する前提を置いたが、**開いた直後にいきなり下線が出る**ことの是非を決めていない。
