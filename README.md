# web-python-editor

ブラウザ上で Python の編集から実行までを完結させる Chrome 拡張機能。

## 概要

Chrome 拡張としてインストールし、ブラウザ内で Python コードを書いて、そのまま実行して結果を確認できるエディタ。イメージとしては「ミニ VSCode」で、本格的な IDE の置き換えではなく、思いついたコードをすぐ書いて試せる軽量な実行環境を目指す。

## 目的

- ローカルに Python 環境を用意せずに、コードの編集と実行ができる状態をブラウザだけで作る
- エディタを開くまでの手間を最小にする（拡張機能として常に手元にある）
- 単なるコード入力欄ではなく、シンタックスハイライトや補完などエディタとして使える最低限の体験を提供する

### 対象外（現時点）

- 大規模プロジェクトの開発（ファイルツリー全体を扱うような用途）
- 既存 IDE の完全な置き換え

## 技術スタック

選定理由はすべて ADR に記録する。

| 領域 | 選定 | ADR |
| --- | --- | --- |
| 実行形態 | Chrome 拡張機能 | [0001](docs/ADR/0001-implement-as-chrome-extension.md) |
| Manifest | Manifest V3 | [0001](docs/ADR/0001-implement-as-chrome-extension.md) |
| 実装言語 | JavaScript（ES Modules）/ HTML / CSS | [0002](docs/ADR/0002-use-vanilla-js-html-css.md) |
| UI フレームワーク | 採用しない | [0002](docs/ADR/0002-use-vanilla-js-html-css.md) |
| エディタ基盤 | CodeMirror 6（`@codemirror/lang-python`） | [0003](docs/ADR/0003-use-codemirror6-as-editor.md) |
| エディタの構成範囲 | `basicSetup` は使わず拡張を明示的に構成 | [0014](docs/ADR/0014-compose-codemirror-extensions-explicitly.md) |
| 構文チェック | 実行前に Worker の `compile()` で検出 | [0015](docs/ADR/0015-check-syntax-before-run-in-worker.md) |
| ビルドツール | esbuild（依存の結合とアセットコピーのみ） | [0007](docs/ADR/0007-use-esbuild-as-bundler.md) |
| 画面設計 | Figma（状態ごとに 1 アートボード） | [0008](docs/ADR/0008-manage-screen-design-in-figma.md) |
| 配色 | ライトテーマのみ | [0009](docs/ADR/0009-use-light-theme-as-base.md) |
| Python 実行基盤 | Pyodide（コア + Python 標準ライブラリを同梱） | [0004](docs/ADR/0004-use-pyodide-as-python-runtime.md) |
| Python の実行コンテキスト | Web Worker（UI スレッドから分離） | [0005](docs/ADR/0005-run-pyodide-in-web-worker.md) |
| 標準入力（`input()`） | ターミナル形式。同期化は JSPI。差し替えは `builtins.input` の置き換え | [0012](docs/ADR/0012-implement-stdin-as-terminal-with-jspi.md), [0016](docs/ADR/0016-replace-builtins-input-instead-of-setstdin.md) |
| コードの永続化 | `chrome.storage.local` に単一バッファで自動保存 | [0013](docs/ADR/0013-persist-code-in-storage-local.md) |
| エディタの表示面 | サイドパネル（`chrome.sidePanel`） | [0006](docs/ADR/0006-use-side-panel-as-editor-surface.md) |

### 制約

- Manifest V3 は**リモートコードの読み込み・実行を禁止**する。依存ライブラリは CDN から読まず、すべてバンドルして拡張パッケージに同梱する。
- 実装そのものは素の JS / HTML / CSS だが、CodeMirror 6 が複数の ES Modules パッケージに分割されているため、**依存の結合を目的としたビルド工程は必要**になる。
- WebAssembly（Pyodide）の実行には manifest での `'wasm-unsafe-eval'` 宣言が必要。
- サードパーティの Python パッケージ（numpy 等）は同梱せず、標準ライブラリのみを対象とする。
- 対応ブラウザは **Chrome 137 以降**。サイドパネル API の要件は 114 だが、`input()` の同期化に用いる JSPI が 137 を要求する。
- サイドパネルは表示幅が狭いため、エディタと出力は縦積みのレイアウトを前提とする。

## ドキュメント構成

| パス | 内容 |
| --- | --- |
| `docs/design.md` | 基本設計。全体構成をまとめる |
| `docs/ADR/` | アーキテクチャ決定記録（Architecture Decision Record） |
| `docs/module_design/` | モジュールごとの設計書。モジュール内部に閉じた決定もここに記録する（[ADR 0017](docs/ADR/0017-limit-adr-scope-to-basic-design.md)） |
| [Figma: web-python-editor 画面設計](https://www.figma.com/design/g4H9KOklj4zVd8oQMUbb0g) | 画面設計。状態ごとのアートボードと配色トークン（[ADR 0008](docs/ADR/0008-manage-screen-design-in-figma.md)） |

### ADR の運用

設計過程の決定事項はすべて ADR に記録する。記録粒度は **1 決定 = 1 ファイル**。

- ファイル名: `NNNN-<英語スラッグ>.md`（連番は 0001 から。欠番は作らない）
- ステータス: `提案中` / `採用` / `却下` / `置き換え済み（→ NNNN）`
- 一度採用した ADR は書き換えず、決定を覆す場合は新しい ADR を追加して旧 ADR を `置き換え済み` にする
- **ADR に記録するのは[基本設計](docs/design.md)の記述を変える決定に限る**（[ADR 0017](docs/ADR/0017-limit-adr-scope-to-basic-design.md)）。判定は「その決定を反映するために `docs/design.md` を書き換える必要があるか」で行う
- モジュール内部に閉じた決定は、当該モジュールの設計書（`docs/module_design/`）へ直接記録する。迷う場合は ADR 側に倒す

### ADR 一覧

| # | タイトル | ステータス |
| --- | --- | --- |
| [0001](docs/ADR/0001-implement-as-chrome-extension.md) | Chrome 拡張機能として実装する | 採用 |
| [0002](docs/ADR/0002-use-vanilla-js-html-css.md) | 実装は素の JavaScript / HTML / CSS で行う | 採用 |
| [0003](docs/ADR/0003-use-codemirror6-as-editor.md) | エディタ基盤に CodeMirror 6 を採用する | 採用 |
| [0004](docs/ADR/0004-use-pyodide-as-python-runtime.md) | Python 実行基盤に Pyodide を採用する | 採用 |
| [0005](docs/ADR/0005-run-pyodide-in-web-worker.md) | Pyodide は Web Worker 上で実行する | 採用 |
| [0006](docs/ADR/0006-use-side-panel-as-editor-surface.md) | エディタの表示面としてサイドパネルを採用する | 採用 |
| [0007](docs/ADR/0007-use-esbuild-as-bundler.md) | ビルドツールに esbuild を採用する | 採用 |
| [0008](docs/ADR/0008-manage-screen-design-in-figma.md) | 画面設計は Figma で管理する | 採用 |
| [0009](docs/ADR/0009-use-light-theme-as-base.md) | UI の基本配色はライトテーマとする | 採用 |
| [0010](docs/ADR/0010-show-run-state-in-toolbar-status.md) | 実行状態はツールバーのステータス表示で示す | 採用 |
| [0011](docs/ADR/0011-show-errors-inline-in-output-pane.md) | 実行時エラーと初期化失敗は出力領域にインラインで表示する | 採用 |
| [0012](docs/ADR/0012-implement-stdin-as-terminal-with-jspi.md) | `input()` はターミナル形式で扱い、同期化に JSPI を用いる | 採用 |
| [0013](docs/ADR/0013-persist-code-in-storage-local.md) | 編集中のコードは `chrome.storage.local` に単一バッファとして自動保存する | 採用 |
| [0014](docs/ADR/0014-compose-codemirror-extensions-explicitly.md) | CodeMirror 6 は `basicSetup` を使わず、拡張を明示的に構成する | 採用 |
| [0015](docs/ADR/0015-check-syntax-before-run-in-worker.md) | 構文エラーは実行前に Worker の `compile()` で検出し、エディタ内に表示する | 採用 |
| [0016](docs/ADR/0016-replace-builtins-input-instead-of-setstdin.md) | 標準入力の差し替えは `setStdin()` ではなく `builtins.input` の置き換えで行う | 採用 |
| [0017](docs/ADR/0017-limit-adr-scope-to-basic-design.md) | ADR に記録する決定は基本設計を変えるものに限る | 採用 |
| [0018](docs/ADR/0018-delegate-completion-sources-to-python-support.md) | 補完ソースは `python()` が登録する 2 つに任せる | 採用 |
| [0019](docs/ADR/0019-flush-on-visibilitychange-hidden.md) | 保存のフラッシュ契機は `visibilitychange` の hidden のみとする | 採用 |
| [0020](docs/ADR/0020-send-diagnostics-as-line-column.md) | 構文チェックの診断は行・桁で送り、オフセットへの変換は UI 側で行う | 採用 |
| [0021](docs/ADR/0021-represent-eof-as-null-stdin-result.md) | `input()` の EOF は `stdinResult` の `text` を `null` にして表す | 採用 |
| [0022](docs/ADR/0022-queue-pasted-lines-as-stdin.md) | 貼り付けられた複数行は入力のキューとして扱う | 採用 |
| [0023](docs/ADR/0023-cap-output-pane-size.md) | 出力領域に行数と 1 行の文字数の上限を設ける | 採用 |
| [0024](docs/ADR/0024-mark-run-boundary-in-output.md) | 実行の開始時に出力領域へ区切りの行を入れる | 採用 |
| [0025](docs/ADR/0025-warm-up-python-before-ready.md) | `ready` を送る前に Python を一度暖機する | 採用 |
| [0026](docs/ADR/0026-keep-editor-editable-while-running.md) | 実行中もエディタは編集可能とする | 採用 |
| [0027](docs/ADR/0027-copy-pyodide-from-node-modules-at-build-time.md) | Pyodide 一式は `vendor/` に置かず、ビルド時に `node_modules` から配る | 採用 |

## 現在のステータス

構想・設計段階。実装コードはまだ存在しない。
