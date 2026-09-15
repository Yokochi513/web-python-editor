# 0016. 標準入力の差し替えは `setStdin()` ではなく `builtins.input` の置き換えで行う

## ステータス

採用（2026-09-15）

## コンテキスト

[ADR 0012](0012-implement-stdin-as-terminal-with-jspi.md) は `input()` の同期化に JSPI を採り、その影響として「標準入力の読み取りは `pyodide.setStdin()` で差し替える」と書いた。同時に、JSPI が実機で成立するかの確認を[基本設計 §9](../design.md) の検証項目として残していた。

使い捨ての拡張（`spike/jspi-check/`）を Chrome に読み込んで確認した。同梱した Pyodide は npm パッケージ 314.0.7 から取り出したもの。結果は次のとおり。

| # | 確かめたこと | 結果 |
| --- | --- | --- |
| 1 | Worker で `WebAssembly.Suspending` / `WebAssembly.promising` が使える | PASS |
| 2 | 同梱した Pyodide をローカルパスから初期化できる | PASS |
| 3 | `setStdout({ batched })` で標準出力が逐次届く | PASS |
| 4 | `runPythonAsync` の中で `pyodide.ffi.run_sync` により `input()` が同期的に待てる | PASS |
| 5 | `callPromising` 経由で `input()` を複数回呼べる | PASS |
| 6 | `setStdin` に Promise を返す関数を渡せる（参考） | **FAIL** |
| 7 | 入力待ちの最中に `terminate()` が効く | PASS |

**ADR 0012 の前提は成立した。**案 C への退避は行わない。4 と 5 が通ったことで、Worker 上の Pyodide でスタックスイッチングが期待どおり働き、待機中も `postMessage` の受信が生きていることが確かめられた。7 により、入力待ち中の停止も設計どおり成り立つ。

一方で 6 は次の例外で落ちた。

```
OSError: [Errno 29] I/O error
```

`setStdin` の `stdin` は**同期的に文字列を返す関数**として定義されており、Pyodide の型定義でも Promise は許されていない。これは C レベルの読み取りフックであって、`run_sync` によるスタックスイッチングの外側にある。Promise を返しても文字列として解釈できず I/O エラーになる。JSPI を使う限り、この経路は取れない。

6 は参考として置いた項目であり、これが落ちても ADR 0012 の決定そのものは揺るがない。ただし ADR 0012 が影響欄に書いた実装手段は成立しないため、代わりの手段を決める必要がある。

## 決定

標準入力の差し替えは `pyodide.setStdin()` では行わない。Worker の初期化時に **`builtins.input` を置き換える**。置き換えた関数は UI へ `stdin` を送り、`pyodide.ffi.run_sync` でその応答を同期的に待つ。

この決定は [ADR 0012](0012-implement-stdin-as-terminal-with-jspi.md) の影響欄にある `setStdin()` の記述を置き換えるものであり、ターミナル形式および JSPI という決定自体は変えない。

## 影響

- `input(prompt)` が受け取ったプロンプト文字列は、**`stdin` メッセージのペイロードに載せて UI へ渡す**。`setStdin` を使わないため `isatty` の設定に依存しなくなり、[ADR 0012](0012-implement-stdin-as-terminal-with-jspi.md) が実装時の課題として挙げていたプロンプトの経路はここで決まる。メッセージ仕様の `stdin` は `{ runId }` から `{ runId, prompt }` になる（[基本設計 §4](../design.md)）。
- プロンプトを `print` で標準出力へ流す形は取らない。`stdout` と `stdin` が別のメッセージとして届いた方が、UI 側は「プロンプトを出してキャレットを立てる」を 1 回の受信で処理できる。
- **`sys.stdin` を直接読むコード（`sys.stdin.readline()` 等）はこの差し替えの対象外**となる。`setStdin()` を使わない以上、そこは Pyodide の既定の挙動のままになる。本プロジェクトが対象とする用途では `input()` が使えれば足りるため、対象外のままとする。
- 差し替えは Pyodide の初期化時に 1 回だけ行い、実行のたびには行わない。ユーザコードが `builtins.input` を自分で上書きした場合はユーザコードの側が優先される。Worker は実行ごとに作り直すわけではないため、その状態は次の実行にも残る。
- 同梱する Pyodide のバージョン下限は、確認に用いた **314.0.7** とする。[ADR 0012](0012-implement-stdin-as-terminal-with-jspi.md) が挙げた 0.27.7 は JSPI 対応の開始時点を指したものであり、実機で確かめたのはこのバージョンである。
- [基本設計 §9](../design.md) の検証項目「JSPI によるスタックスイッチングが期待どおり働くか」は解消する。
- `minimum_chrome_version: 137` は維持する。
- 確認に用いた `spike/jspi-check/` は役目を終える。
