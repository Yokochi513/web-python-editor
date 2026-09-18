# 0021. `input()` の EOF は `stdinResult` の `text` を `null` にして表す

## ステータス

採用（2026-09-15）

## コンテキスト

[ADR 0012](0012-implement-stdin-as-terminal-with-jspi.md) は `input()` をターミナル形式で扱うと決めたうえで、**EOF（`Ctrl+D`）を送れるようにするかを実装時の課題として残した**。[基本設計 §3.2](../design.md) の入力待ちは「1 行入力して確定する」経路しか持たず、入力を打ち切る手段がない。

打ち切れないと何が起こるか。`while True: input()` や、行を読み尽くすまで回るコードから抜ける手段が**停止ボタン（＝ Worker の破棄）だけ**になる。破棄すれば Pyodide の状態はすべて失われ（[基本設計 §3.3](../design.md)）、その実行の続きも失われる。ターミナル形式を名乗る以上、EOF は入力の一部である。

`Ctrl+D` が Chrome に奪われないかは確認していなかった。`Ctrl+D` はブックマークの追加に割り当てられている。使い捨ての拡張（`spike/input-surface/`）でサイドパネルの文書を実機で確かめたところ、**`keydown` で捕らえて `preventDefault()` すればブックマークは開かず、こちらに届く**ことが分かった。

残るのは表し方である。`stdinResult` のペイロードは `{ runId, text }`（[基本設計 §4](../design.md)）で、EOF を載せる欄がない。

## 決定

**EOF は `stdinResult` の `text` を `null` にして表す。** 別の欄（`eof: true` など）は足さない。

「返す行がない」ことを `text` の値で表せば、受け手の分岐は 1 つで済む。欄を足すと、`text` と `eof` の組み合わせのうち意味を持たないもの（`eof: true` かつ `text` が非 null など）が生まれる。

Worker 側は `builtins.input` の置き換え（[ADR 0016](0016-replace-builtins-input-instead-of-setstdin.md)）の中で判定し、`EOFError` を送出する。

```python
def _input(prompt=""):
    line = run_sync(js.askLine(str(prompt)))
    if line is None:
        raise EOFError("EOF when reading a line")
    return line
```

文言は CPython と同じにする。ユーザが手元の Python で見るものと揃う。

UI 側は **`Ctrl+D` を、入力行が空のときに限り** EOF として扱う。文字が入っているときは無視する。ターミナルの慣習に合わせたもので、打ちかけの文字を EOF で消す経路を作らない。確定した行としては何も残さず、`notice` として「EOF を送信しました」を 1 行出す。**何も残さないと、履歴を読み返したときに実行が中断した理由が消える。**

## 影響

- [基本設計 §4](../design.md) の `stdinResult` を `{ runId, text }`、`text` は「確定した 1 行。EOF の場合は `null`」に書き換える。
- [基本設計 §3.2](../design.md) の入力待ちに、EOF で `EOFError` が送出される経路を加える。`EOFError` は通常の実行時例外として `error` で届き、出力領域にインラインで表示される（[ADR 0011](0011-show-errors-inline-in-output-pane.md)）。
- [main.md](../module_design/main.md) の `commitStdin` は `text` に `null` を取り得る。
- [pyodide-worker.md](../module_design/pyodide-worker.md) の `askLine` の返り値は `Promise<string | null>` になる。**reject の経路は持たせないままでよい。** EOF は失敗ではなく、値のある解決である。
- [ADR 0012](0012-implement-stdin-as-terminal-with-jspi.md) が残した課題のうち EOF の項が解消する。入力履歴の項は「持たない」として [main.md](../module_design/main.md) に記録する。
