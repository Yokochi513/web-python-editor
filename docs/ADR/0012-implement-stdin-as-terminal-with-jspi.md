# 0012. `input()` はターミナル形式で扱い、同期化に JSPI を用いる

## ステータス

採用（2026-09-15）

## コンテキスト

[ADR 0005](0005-run-pyodide-in-web-worker.md) で Pyodide を Web Worker に分離した結果、`input()` の扱いが未決定のまま残っていた（[基本設計 §9](../design.md)）。

求める体験は**ターミナル形式**である。出力領域にプロンプトがそのまま出て、その場で入力を打ち、Enter で確定すると続きの出力が同じ流れに追記される。print と入力の前後関係が 1 本の履歴として残る点で、出力領域の設計（[ADR 0011](0011-show-errors-inline-in-output-pane.md)）とも一貫する。

難所は表示ではなく、**Python 側を同期的に待たせる方法**にある。`input()` は同期的に値を返さなければならないが、Worker から UI へ問い合わせて応答を待つ処理は本来非同期である。さらに `Atomics.wait` で Worker を止めている間、**その Worker は `postMessage` を受け取れない**（メッセージキューが処理されない）。「止めて待ち、`postMessage` で答えを受け取る」という素朴な形は原理的に成立しない。

候補は次の 3 つ。

- **A. `SharedArrayBuffer` + `Atomics.wait`**: 実績のある経路。Worker が要求を送ってから自分を止め、UI が共有メモリへ書き込んで `Atomics.notify` で起こす。前提として cross-origin isolation が要るが、manifest の `cross_origin_embedder_policy` / `cross_origin_opener_policy` で有効化できることは Chrome のドキュメントに記載がある。代償は、**拡張の全ページに COEP `require-corp` を課すこと**と、状態フラグ・バイト列の詰め替え・長さの扱いを自前で持つ実装量の大きさ。
- **B. JSPI（WebAssembly のスタックスイッチング）**: Pyodide が公式に `input()` の実現手段として挙げている方式。同期的な Python 呼び出しを非同期の JS 実装へ接続できる。`SharedArrayBuffer` も cross-origin isolation も不要で、Worker はブロックせずに待つため、応答は通常の `postMessage` で受け取れる。実装量は 3 案で最も小さい。代償は **Chrome 137 以降**（JSPI のサポート開始）を要求すること。
- **C. 実行前に stdin をまとめて与える**: 入力欄にあらかじめ書いておき、`input()` はそこから 1 行ずつ読む。特別な仕組みは要らないが、**プロンプトを見てから答えるという体験にならない**。ターミナル形式ではない。

本プロジェクトは常用の Chrome にインストールして使う拡張であり、Chrome 137 は 2025 年 5 月のリリースで既に十分に行き渡っている。サイドパネル API（Chrome 114）からの下限の引き上げは、実質的な制約にならない。

## 決定

`input()` はターミナル形式で扱う。**出力領域をそのまま入力面とし**、専用の入力欄を別に設けない。

同期化の手段は **JSPI（案 B）を採る**。案 A は採らない。

JSPI が実機で成立しなかった場合は、**案 C へ退避する**。A へは退避しない。A は B と同じ体験にしか到達しないにもかかわらず、cross-origin isolation という拡張全体にかかる前提と最大の実装量を要求する。一方 C が払う代償は `input()` を書いたコードの体験だけに閉じ、`input()` を使わないコードには何の影響も及ぼさない。不成立時に払うコストが小さい方を退避先とする。

退避する場合、ターミナル形式という決定自体が覆るため、本 ADR を置き換える ADR を起こす。

## 影響

- **`minimum_chrome_version` を 114 から 137 へ引き上げる。** サイドパネル API ではなく JSPI が下限を決めることになる。案 C へ退避した場合は 114 に戻せる。
- 同梱する Pyodide は **JSPI に対応したバージョン（0.27.7 以降）**とする。
- ユーザコードの実行は `pyodide.runPythonAsync` 経由で行う。スタックスイッチングはこの入口を通った実行でのみ有効になるため、実行経路の選択がそのまま `input()` の可否を決める。
- 標準入力の読み取りは `pyodide.setStdin()` で差し替える。
- メッセージ仕様に往復を 1 組追加する（[基本設計 §4](../design.md)）。Worker は JSPI ではブロックしないため、**応答は `postMessage` で受け取れる**。案 A のような共有メモリ経由の仕掛けは不要になる。
- 実行状態に**入力待ち**が加わる（[ADR 0010](0010-show-run-state-in-toolbar-status.md)）。停止ボタンは入力待ち中も**有効のまま**とする。`terminate()` は UI スレッド側の操作であり、待機中の Worker にも効く。
- **出力領域が追記専用でなくなる**（[ADR 0011](0011-show-errors-inline-in-output-pane.md)）。入力待ちの間だけ末尾にキャレットが立ち、フォーカスを受け取る。確定した入力は静的な行として同じ流れに残す。
- cross-origin isolation は不要になる。[ADR 0005](0005-run-pyodide-in-web-worker.md) で挙げた COEP / COOP の検証は不要となり、代わりに JSPI の実機確認が前提の検証項目になる。
- Figma にアートボード「08 入力待ち」を追加する（[ADR 0008](0008-manage-screen-design-in-figma.md)）。

### 実装時に決めること

- 確定した入力行の見せ方（標準出力と同じ色にするか、区別するか）
- `Ctrl+D` による EOF（`EOFError`）を送れるようにするか
- 入力履歴（上下キーでの呼び出し）を持つか
- `input(prompt)` のプロンプト文字列がどの経路で出力領域へ届くか（`setStdin` の `isatty` 設定で変わる）
