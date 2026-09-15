# 0018. 補完ソースは `python()` が登録する 2 つに任せる

## ステータス

採用（2026-09-15）

## コンテキスト

[ADR 0014](0014-compose-codemirror-extensions-explicitly.md) で CodeMirror 6 の拡張を明示的に構成すると決め、[基本設計 §2.2](../design.md) の「含める」に「補完（`autocompletion` + `globalCompletion`）」を挙げた。この記述は `globalCompletion` を補完ソースとして明示的に指定する形を想定していた。

モジュール設計書（[editor.md](../module_design/editor.md)）を書く過程で、`globalCompletion` が Pyodide の名前空間を参照する補完ではないかという疑いが生じた。もしそうなら、Pyodide は Worker 側にある（[ADR 0005](0005-run-pyodide-in-web-worker.md)）ため UI スレッドの補完から同期的に参照できず、`postMessage` の往復を 1 組追加する必要があった。これは [基本設計 §4](../design.md) のメッセージ仕様を変える話になる。

`@codemirror/lang-python` の実装を確認した結果、**この疑いは誤りだった。**

```js
const globalCompletion = ifNotIn(dontComplete, completeFromList(globals.concat(snippets)));
```

`globalCompletion` は Python の組み込み名・キーワードの**静的なリスト**とスニペットを並べたものであり、Python の実行系を一切参照しない。Pyodide とは無関係である。

同時に、もう 1 つ分かったことがある。`python()` は `LanguageSupport` として、`localCompletionSource` と `globalCompletion` の**両方を言語データとして既に登録している**。

```js
function python() {
    return new LanguageSupport(pythonLanguage, [
        pythonLanguage.data.of({ autocomplete: localCompletionSource }),
        pythonLanguage.data.of({ autocomplete: globalCompletion }),
    ]);
}
```

したがって `autocompletion()` を置くだけで両方が効く。一方、`autocompletion({ override: [globalCompletion] })` と書くと `override` が言語データの登録を上書きし、**`localCompletionSource` が無効になる。**

`localCompletionSource` は編集中の文書の構文木から定義済みの名前（変数・関数・クラス・引数）を拾う補完である。**自分がいま書いたばかりの関数名を補完できるかどうかを分ける。** 組み込み名の補完より、書いている最中の体験への寄与は大きい。

## 決定

補完は `autocompletion()` のみを置き、補完ソースは `python()` が登録する 2 つ（`localCompletionSource` と `globalCompletion`）に任せる。**`override` は使わない。**

## 影響

- [基本設計 §2.2](../design.md) の「含める」の記述を、`autocompletion` 単体を置く形へ改める。
- [editor.md](../module_design/editor.md) の `buildExtensions` の表を同様に改める。
- **[ADR 0014](0014-compose-codemirror-extensions-explicitly.md) の方針とは矛盾しない。** `autocompletion` を含めるという選択自体は明示的である。補完ソースの登録は `python()` という 1 つの拡張の内部仕様であり、そこまで分解するなら `python()` 自体を分解する話になる。明示的に構成する対象は拡張の粒度までとする。
- **補完は Pyodide を参照しないため、初期化の完了前でも同じように効く。** エディタが初期化前から編集可能である（[基本設計 §3.1](../design.md)）ことと矛盾しない。[editor.md](../module_design/editor.md) に挙げていた「初期化完了前の補完の扱い」という未決事項は、前提が成り立たないため解消する。
- メッセージ仕様（[基本設計 §4](../design.md)）に補完のための往復は追加しない。
- **実行時にしか分からない名前は補完されない。** `import` したモジュールの属性などがこれにあたる。補完の対象は静的な組み込みリストと、文書の構文木から拾える名前に限られる。Pyodide の名前空間を引く補完は本プロジェクトの対象外とする。
