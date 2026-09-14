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
| ビルドツール | esbuild（依存の結合とアセットコピーのみ） | [0007](docs/ADR/0007-use-esbuild-as-bundler.md) |
| Python 実行基盤 | Pyodide（コア + Python 標準ライブラリを同梱） | [0004](docs/ADR/0004-use-pyodide-as-python-runtime.md) |
| Python の実行コンテキスト | Web Worker（UI スレッドから分離） | [0005](docs/ADR/0005-run-pyodide-in-web-worker.md) |
| エディタの表示面 | サイドパネル（`chrome.sidePanel`） | [0006](docs/ADR/0006-use-side-panel-as-editor-surface.md) |

### 制約

- Manifest V3 は**リモートコードの読み込み・実行を禁止**する。依存ライブラリは CDN から読まず、すべてバンドルして拡張パッケージに同梱する。
- 実装そのものは素の JS / HTML / CSS だが、CodeMirror 6 が複数の ES Modules パッケージに分割されているため、**依存の結合を目的としたビルド工程は必要**になる。
- WebAssembly（Pyodide）の実行には manifest での `'wasm-unsafe-eval'` 宣言が必要。
- サードパーティの Python パッケージ（numpy 等）は同梱せず、標準ライブラリのみを対象とする。
- サイドパネル API の都合により、対応ブラウザは **Chrome 114 以降**。
- サイドパネルは表示幅が狭いため、エディタと出力は縦積みのレイアウトを前提とする。

## ドキュメント構成

| パス | 内容 |
| --- | --- |
| `docs/design.md` | 基本設計。全体構成をまとめる |
| `docs/ADR/` | アーキテクチャ決定記録（Architecture Decision Record） |

### ADR の運用

設計過程の決定事項はすべて ADR に記録する。記録粒度は **1 決定 = 1 ファイル**。

- ファイル名: `NNNN-<英語スラッグ>.md`（連番は 0001 から。欠番は作らない）
- ステータス: `提案中` / `採用` / `却下` / `置き換え済み（→ NNNN）`
- 一度採用した ADR は書き換えず、決定を覆す場合は新しい ADR を追加して旧 ADR を `置き換え済み` にする

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

## 現在のステータス

構想・設計段階。実装コードはまだ存在しない。
