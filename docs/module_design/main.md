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
| `endRun` | なし | `void` | 実行の後始末。入力のキューを捨て、フォーカスをエディタへ戻す |
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
| `stdinQueue` | `string[]` | 貼り付けで確定した行のうち、まだ `input()` へ渡していないもの（[ADR 0022](../ADR/0022-queue-pasted-lines-as-stdin.md)） |

### 実行状態

[ADR 0010](../ADR/0010-show-run-state-in-toolbar-status.md) に基づき、状態はステータス表示が説明し、ボタンの活性がその時点で可能な操作を示す。Figma のアートボード（[基本設計 §5.3](../design.md)）と 1 対 1 で対応する。

| `state` | アートボード | ステータス文言 | 印の色 | 実行ボタン | 停止ボタン | 遷移の契機 |
| ------- | ---- | ---- | ---- | ---- | ---- | ---- |
| `initializing` | 01 初期化中 | Pyodide を初期化中… | `status/running` | 無効 | 無効 | 起動直後、および `replaceWorker` の直後 |
| `ready` | 02 実行可能 | 準備完了 | `status/success` | 有効 | 無効 | `ready` を受信 |
| `running` | 03 実行中 | 実行中… | `status/running` | 無効 | 有効 | `run` を送信 |
| `waitingInput` | 08 入力待ち | 入力待ち | `status/running` | 無効 | 有効 | `stdin` を受信 |
| `done` | 04 正常終了 | 準備完了 | `status/success` | 有効 | 無効 | `done` を受信 |
| `error` | 05 実行時エラー | 準備完了 | `status/success` | 有効 | 無効 | `error` を受信 |
| `initError` | 06 初期化失敗 | 初期化に失敗しました | `status/error` | 無効 | 無効 | `initError` を受信 |
| `restarting` | 07 停止直後 | 停止しました。再初期化中… | `status/running` | 無効 | 無効 | 停止ボタンの押下 |

文言と色は Figma の各アートボードによる（[基本設計 §5.3](../design.md)）。`status/running` は `#b45309`、`status/success` は `#17803d`、`status/error` は `#d22b2b`。

**`ready` / `done` / `error` はツールバーの表示が完全に同一である。** 何が起きた直後かを語るのはツールバーではなく**出力領域の側**で、Figma は 03 に「出力を受信中…」、04 に「実行が完了しました」、07 に「実行を停止しました」を置いている。ツールバーは「いま何ができるか」だけを示し、「何が起きたか」は履歴に残す、という分担になる。

3 つの状態を 1 つにまとめないのは、Figma のアートボードと 1 対 1 に保つためである。表示が同じでも、遷移の契機と直前に追記される行が違う。

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
3. レコードのバージョン欄を確認する。**既知の古い版なら現在の形へ移行する**
4. `applyViewState(view, record)` でエディタへ復元する（`editor.js`）

**保存レコードの移行は本関数が行う。** Service Worker の `onInstalled` には置かない（[service-worker.md](service-worker.md)）。移行が要るかどうかは**読んだ時点**で分かり、本関数は既にバージョン欄を見ている。Service Worker はいつでも停止するため、移行の途中で止まれば中途半端なレコードが残る。

- 例外処理

読み取りに失敗した場合、および**レコードのバージョンが未知（＝現在より新しい）場合**は、復元を諦めて空の文書のまま始める。例外は投げない。新しい版のレコードをこちらの解釈で読むと、内容を取り違えたまま上書きする。

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
| `done` | `appendOutput("notice", "実行が完了しました")`、`stdinQueue` を空にし、`currentRunId` を `null` にして `setState("done")`。`endRun()` でフォーカスを戻す |
| `error` | `appendOutput("error", message + traceback)`、`stdinQueue` を空にし、`currentRunId` を `null` にして `setState("error")`。`endRun()` でフォーカスを戻す |
| `initError` | `appendOutput("error", message)` し、`setState("initError")` |
| `checkResult` | `applyCheckResult(payload)` |

`done` で `notice` を 1 行出すのは、**`ready` / `done` / `error` のツールバー表示が同一**であり、実行が終わったことを語れるのが出力領域しかないためである（Figma のアートボード 04）。

`endRun()` は実行の後始末をまとめたもので、`stdinQueue` の破棄と、**フォーカスが出力領域の中にある場合に限った** `focusEditor(view)` の呼び出しを行う（`editor.js`）。実行中にユーザが自分でエディタを触っていた場合は、そのフォーカスを奪い返さない。

**`ready` を受けたときの初回検査は、復元したコードがある場合に限る。** 空の文書では検査に意味がない。復元したコードに構文エラーがあれば、開いた直後から下線が出る。検査を見送ると、**ユーザが 1 文字打った 500ms 後に、打った場所とは無関係なところへ唐突に下線が出る**ことになり、そちらの方が因果を読み違えやすい。

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
4. `appendOutput("notice", ...)` で実行の区切りを 1 行出す（[ADR 0024](../ADR/0024-mark-run-boundary-in-output.md)）
5. `getCode(view)` でコードを取り出す
6. `worker.postMessage({ type: RUN, runId, code })` を送る
7. `setState("running")`

**出力領域は消さない。** 消すと、前回の traceback を見ながら直して実行する流れで直す根拠が失われ、`input()` で対話した履歴も実行のたびに消える。繰り返し実行したときの境目は手順 4 の区切りが示す。出力領域が空になるのはクリアボタンを押したときだけである。

区切りの文言は `──────── 実行 ────────` の 1 行とする（Figma 各アートボードの出力領域）。罫線は引かず、出力と同じ 1 行として `notice` の色で置く。実行を開始したすべての状態のアートボード（03 / 04 / 05 / 07 / 08 / 10）がこの行を先頭に持つ。

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

1. `appendOutput("notice", "実行を停止しました")` で停止した旨を 1 行出す（Figma アートボード「07 停止直後」）
2. `endRun()` を呼ぶ
3. `replaceWorker()` を呼ぶ

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
4. `initError` の場合は**出力領域の末尾**へ再試行のブロックを追記する

手順 4 の置き場所は**ツールバーではなく出力領域の中**とする（Figma アートボード「06 初期化失敗」）。エラー本体の直下に再試行ボタンと「Python の実行はできませんが、コードの編集と保存は続けられます。」を置く。押下で `replaceWorker()` を呼ぶ。

ツールバーに置かない理由は 2 つある。初期化に成功した後もボタンの居場所が残ること、そして**状態ごとにツールバーの構造そのものが変わる**ことである。出力領域に置けば、エラーをインラインで出すという原則（[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md)）の一部として収まり、再試行が「どの失敗に対するものか」も履歴の位置で分かる。

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
| `notice` | 実行の区切り、実行が完了した旨、停止した旨、復元できなかった旨など UI 側の説明 |

`prompt` は `stdout` と**同じ色**、`input` は `accent/default`（`#2563eb`）とする。プロンプトはプログラムが書いたもので `stdout` と同列であり、入力はユーザが書いたものだからである。1 本の履歴を後から読むとき、**どれを自分が打った行か**が色で分かる。確定した後の見え方は Figma のアートボード 10 による。

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `text` が 10,000 文字を超える場合は切り詰め、末尾に省略の印を付ける
2. `kind` に対応するクラスを付けた要素を作る
3. `text` を**テキストとして**入れる。HTML として解釈させない
4. 出力領域の末尾へ追加する
5. 行数が 2,000 を超えていれば、古い方から取り除く。取り除いた場合、先頭に「古い出力を省略しました」を 1 行残す
6. 末尾までスクロールする

手順 3 は必須である。`text` にはユーザコードの出力と Python の traceback が入る。文字列として扱わないと、`print("<b>")` のような出力が表示を壊す。

手順 1 と 5 は出力の上限である（[ADR 0023](../ADR/0023-cap-output-pane-size.md)）。行数で数えられるのは本関数の 1 回の呼び出しが 1 行に対応するためで、判定は子要素の数で済む。文字数の方は、`batched` が行単位で呼ばれる以上**改行を含まない巨大な出力が 1 行として届く**ことへの備えである。

**入力待ちの行（プロンプトと編集中の入力）は手順 5 の対象から外す。** プロンプトが消えると、何を聞かれているか分からないままキャレットだけが残る。

省略した事実を 1 行残すのは、黙って消すと**出力の先頭が本当の先頭だと読めてしまう**ためである。

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

1. 入力待ちでなければ、出力領域の子要素をすべて取り除く
2. 入力待ちなら、**入力中の行より前だけ**を取り除く

**入力待ちの最中もクリアボタンは押せる。** 無効にすると「出力が溢れて読めないから消したい」という一番ありそうな動機を塞ぐことになる。一方でプロンプトまで消すと、何を聞かれているか分からないままキャレットだけが残るため、入力待ちの行は残す。

- 例外処理

行わない。

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

1. `stdinQueue` が空でなければ、先頭を取り出して `commitStdin` へ渡し、**ここで戻る**（[ADR 0022](../ADR/0022-queue-pasted-lines-as-stdin.md)）。プロンプトは出し、消費した行も `input` として残す
2. `appendOutput("prompt", prompt)` でプロンプトを出す。空文字でも行は立てる
3. その行に編集可能な `span` を足し、キャレットを置く
4. フォーカスをその `span` へ移す
5. 確定のキー操作を待つ

- 例外処理

行わない。

**出力領域が追記専用でなくなるのはこの瞬間だけ**である（[ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md)）。確定すれば静的な行に戻る。

#### 入力面の実装

出力領域そのものは編集不可のままとし、**入力待ちの間だけ、末尾行の中に置いた `span` を `contenteditable="plaintext-only"` にする。**

使い捨ての拡張（`spike/input-surface/`）で 3 案を実機で比べた結果による。

| 案 | 確定済みの行を編集できないことの担保 | 判定 |
| --- | --- | --- |
| 出力領域全体を `contenteditable` にする | `beforeinput` で入力行の外への変更を弾く | **不可** |
| **末尾行の `span` だけを `contenteditable` にする** | 出力領域が編集不可のまま | **採用** |
| 末尾にインラインの `input` 要素を置く | 出力領域が編集不可のまま | 見送り |

1 案目を採らないのは、**門が原理的に閉じきらない**ためである。`beforeinput` は `insertCompositionText` に対しては cancelable ではなく、`preventDefault()` しても IME の変換文字列は入る。実機でも、入力待ちでない出力領域に対して変換が成立し、**確定済みの行に文字が残った。** [ADR 0012](../ADR/0012-implement-stdin-as-terminal-with-jspi.md) が置いた「1 本の履歴として後から読める」という前提が崩れる。

3 案目の `input` 要素は構造では守れるが、単一行に固定されて折り返しが効かず、出力全体をドラッグ選択してコピーしたときに入力欄の中身が落ちる。スパイクで幅を固定せざるを得なかったのがその現れである。

採用案は、出力領域を編集不可に保ったまま入力用の `span` だけを開ける。折り返しも選択コピーも他の出力行と同じに揃う。

#### 確定キーと IME

`keydown` で `key === "Enter"` かつ `isComposing === false` かつ `keyCode !== 229` のときだけ確定する。

実機では、**変換を確定する Enter は `key === "Enter"` の `keydown` として届かなかった**（`compositionend` の後、確定の Enter だけが `keyCode=13 isComposing=false` で届く）。それでも判定は残す。IME の実装差に対する保険であり、costs は 1 行である。誤れば**変換を確定しただけで入力が送信される**ため、保険の側に倒す。

**修飾キーを伴う Enter（Shift / Ctrl / Alt / Meta）は無視する。** 改行も入れない。1 行 = 1 入力という対応を崩さないためである。

#### EOF

**入力行が空のときに限り、`Ctrl+D` を EOF として扱う**（[ADR 0021](../ADR/0021-represent-eof-as-null-stdin-result.md)）。文字が入っているときは無視する。`keydown` で `preventDefault()` すれば Chrome のブックマーク追加には奪われないことを実機で確認している。

#### 貼り付け

`beforeinput` の `insertFromPaste` を横取りし、**素のままでは入れさせない**（[ADR 0022](../ADR/0022-queue-pasted-lines-as-stdin.md)）。CRLF を LF に正規化して分割し、改行で終わっている行はすべて確定、終わっていない最後の行だけを入力行に残す。余った行は `stdinQueue` へ積む。

実機では、横取りしないと `"こんにちは\nこんにちは\nこんにちは\nこんにちは\n\n"` が改行を含んだ 1 つの値として確定した。**`input()` の返り値に改行が含まれないことは Python の約束**であり、破ると後続の `int()` などが意図しない形で壊れる。

#### 入力履歴

**持たない。** 上下キーは拾わない。

REPL ではなくプログラムへの入力であり、同じ値を再入力する場面は REPL ほど多くない。持てば履歴の寿命（1 回の実行の間か、パネルを開いている間か）という判断が増え、上下キーを奪えば入力行でのキャレット移動とも衝突する。**足す方が剥がすより容易**なので、必要と分かった時点で足す。

### commitStdin関数

- シグネチャ
```js
function commitStdin(text: string | null): void
```

- 概要

入力を確定し、`stdinResult` を Worker へ返す。Worker 側では `run_sync` が値を受け取り、`input()` から実行が再開する（[基本設計 §3.2](../design.md)）。

`text` が `null` のときは EOF を表し、Worker 側の `input()` は `EOFError` を送出する（[ADR 0021](../ADR/0021-represent-eof-as-null-stdin-result.md)）。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| `text` | `string \| null` | ○ | 確定した 1 行。末尾の改行は含まない。**EOF の場合は `null`** |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. 入力中の行を編集不可にし、キャレットを外す
2. `text` が文字列なら `appendOutput("input", text)` 相当の形で、確定した入力を静的な行として履歴に残す。`null`（EOF）なら `appendOutput("notice", "EOF を送信しました")` を出す
3. `worker.postMessage({ type: STDIN_RESULT, runId: currentRunId, text })` を送る
4. `setState("running")` で実行中へ戻す

手順 2 で EOF の行を残すのは、**何も残さないと履歴を読み返したときに実行が中断した理由が消える**ためである。`EOFError` の traceback だけが唐突に現れることになる。

- 例外処理

`state` が `waitingInput` でないときに呼ばれた場合は何もせず戻る。確定の直前に停止ボタンが押された経路があり得る。その場合 `currentRunId` は既に `null` であり、送り先の Worker も破棄されている。

### endRun関数

- シグネチャ
```js
function endRun(): void
```

- 概要

実行の後始末をまとめる。`done` と `error` の受信時、および停止時に呼ぶ。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `void` | |

- フロー

1. `stdinQueue` を空にする
2. フォーカスが出力領域の中にあれば `focusEditor(view)` を呼ぶ（`editor.js`）

手順 1 は必須である。**キューが実行をまたいで残ると、次の実行が身に覚えのない値で進む**（[ADR 0022](../ADR/0022-queue-pasted-lines-as-stdin.md)）。

手順 2 の条件が要るのは、実行中にユーザが自分でエディタを触っている場合があるためである。そのフォーカスを奪い返す理由はない。入力の確定時ではなく実行の終了時に戻すのは、`input()` がループで繰り返される場合に**フォーカスが往復する**のを避けるためである。

- 例外処理

行わない。

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
2. `prefix` と連番を `-` で繋いだ文字列を返す（`run-1` / `check-1` の形）

採番を本モジュールに置くのは、**発行するのが UI 側だけ**だからである。`protocol.js` は種別と欄名の定義に留め、値の生成を持たない（[protocol.md](protocol.md)）。UUID のような衝突しない形式は要らない。一意性はサイドパネルの文書が生きている間だけ保てればよく、パネルを開き直せば Worker も作り直される。

一意性はサイドパネルの文書が生きている間だけ保てればよい。パネルを開き直せば Worker も作り直され、古い識別子を持つ相手は存在しない。

- 例外処理

行わない。

