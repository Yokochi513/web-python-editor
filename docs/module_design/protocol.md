# protocol.jsファイル

## 背景・目的
<!-- なぜ必要か、何をするのか -->

サイドパネル UI（`main.js`）と Pyodide Worker（`pyodide-worker.js`）は別々の実行コンテキストに置かれ、両者の接点は `postMessage` で運ばれるオブジェクトの `type` 文字列だけである（[基本設計 §2](../design.md)）。

この文字列を両側にリテラルで直書きすると、綴りの食い違いが**無言の不通**になる。メッセージは正常に届き、`onmessage` も発火し、ただ誰も処理しない。例外も出ないため、実行ボタンが押しても何も起きない、という形でしか表面化しない。

そこで [基本設計 §4](../design.md) のメッセージ仕様を本モジュールに 1 箇所だけ定義し、UI と Worker の両方から import する。ビルドは UI と Worker で別エントリだが（[基本設計 §7](../design.md)）、同じソースが両方のバンドルへ結合されるため定義の実体は 1 つに保たれる。

**本モジュールは型と定数の置き場であり、振る舞いを持たない。** メッセージの送受信そのものは `main.js` と `pyodide-worker.js` が行う。

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
| `STDIN_RESULT` | `"stdinResult"` | `{ runId, text }` | `stdin` への応答（確定した 1 行） |
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
| `CHECK_RESULT` | `"checkResult"` | `{ checkId, diagnostics }` | 構文チェックの結果。`diagnostics` は最大 1 件 |

停止要求のメッセージは存在しない。停止は `worker.terminate()` で行うため（[基本設計 §3.3](../design.md)）。

## 関数詳細
<!-- 各関数の説明 -->

公開する関数がないため記載しない。本モジュールに振る舞いを持たせるかどうかは「未決事項」を参照。

## 未決事項

- **メッセージの生成関数（ファクトリ）を持たせるか。** `type` の綴りは定数で守られるが、ペイロードの欄名（`runId` / `text` / `prompt` 等）は依然として両側の直書きになる。`makeRun(runId, code)` のような生成関数を置けばそこも 1 箇所になるが、本モジュールの責務が「定義」から「組み立て」へ広がる。どちらを採るか決めていない。
- **受信時の検証関数を持たせるか。** UI と Worker は同じ拡張パッケージ内の相手としか通信しないため、素性の分からないメッセージは届かない前提に立てる。一方で、`terminate()` と Worker の作り直し（[基本設計 §3.3](../design.md)）を挟むと、破棄済み Worker からの遅延メッセージという想定外の受信はあり得る。検証をここに置くか、受け手側の責務にするか決めていない。
- **`runId` / `checkId` の採番をどこで行い、どのような値にするか。** [基本設計 §4](../design.md) は用途（遅延して届いた出力を破棄済みの実行のものと判別する）のみを定めており、採番の主体と形式を定めていない。発行するのは UI 側だけなので `main.js` に置くのが自然だが、識別子の定義という意味では本モジュールの担当ともいえる。
- **`WORKER_TO_UI.READY` にペイロードを持たせるか。** [基本設計 §4](../design.md) では「なし」だが、Pyodide のバージョンや初期化所要時間を載せると初期化コストの実測（[基本設計 §9](../design.md) の検証項目）に使える。載せるかどうかは決めていない。
