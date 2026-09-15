# service-worker.jsファイル

## 背景・目的
<!-- なぜ必要か、何をするのか -->

Manifest V3 の拡張でバックグラウンドに置かれるスクリプト（[基本設計 §2.1](../design.md)）。

責務は**ツールバーアイコンのクリックでサイドパネルを開くようにする設定 1 つだけ**である。エディタの状態にも Python の実行にも関与しない。実行は Web Worker 上の Pyodide が担い（[ADR 0005](../ADR/0005-run-pyodide-in-web-worker.md)）、編集中のコードは `chrome.storage.local` が持つ（[ADR 0013](../ADR/0013-persist-code-in-storage-local.md)）ため、本モジュールが受け持つものは残らない。

責務をここまで絞るのは、**MV3 の Service Worker が待機状態のまま放置されると停止される**ためである（[基本設計 §2.1](../design.md)）。停止すればメモリ上の状態は失われる。状態を持たせた設計にすると「たまたま停止していなかったときだけ動く」挙動になり、再現しない不具合を生む。したがって最初から状態を持たない。

なお `chrome.sidePanel.setPanelBehavior()` を呼ばない場合、アイコンのクリックでは何も起きず、ユーザは Chrome のサイドパネル一覧から明示的に選ぶしかない。拡張の入口そのものがこの 1 行にかかっている。

## 関数一覧
<!-- どのような関数があるのか -->

| 関数名 | 引数 | 返り値 | 内容 |
| ------ | ---- | ------ | ---- |
| `initPanelBehavior` | なし | `Promise<void>` | アイコンのクリックでサイドパネルが開くよう設定する |

モジュールのトップレベルでは `chrome.runtime.onInstalled` に `initPanelBehavior` を登録するだけとし、他のリスナは登録しない。

## 関数詳細
<!-- 各関数の説明 -->

### initPanelBehavior関数

- シグネチャ
```js
async function initPanelBehavior(): Promise<void>
```

- 概要

`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` を呼び、ツールバーアイコンのクリックでサイドパネルが開く状態にする。拡張のインストール時および更新時に一度だけ実行する。

- 引数一覧

| 引数名 | 型  | 必須 | 内容 |
| ------ | --- | ---- | ---- |
| （なし） |     |      |      |

- 返り値一覧

| 返り値名 | 型  | 内容 |
| -------- | --- | ---- |
| （なし） | `Promise<void>` | 設定の完了のみを表す。値は返さない |

- フロー

1. `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` を呼ぶ
2. 返る Promise を待つ
3. 失敗した場合は `console.error` に記録して終える（下記「例外処理」）

**`onInstalled` への登録だけで足りる。** `setPanelBehavior` の設定は Service Worker の停止・再起動をまたいで永続化されることを実機で確認した（`spike/lifecycle-check/`、2026-09-15）。Service Worker を明示的に終了させたあと、`onInstalled` を経ずにツールバーアイコンのクリックでサイドパネルが開いた。Service Worker の起動のたびに呼び直す必要はない。

- 例外処理

`setPanelBehavior` が reject した場合に限り `console.error` へ記録する。**再試行は行わない。**

Service Worker にはユーザへ提示する画面がない。[ADR 0011](../ADR/0011-show-errors-inline-in-output-pane.md) が定めた「エラーは出力領域へインラインで出す」経路は、サイドパネルが開いていて初めて成立するものであり、その入口の設定自体が失敗している状況では使えない。したがってここで拾える手段は開発者向けのログに限られる。

この失敗が起きるとアイコンのクリックに反応しなくなるが、Chrome のサイドパネル一覧から選べば拡張自体は利用できる。**致命的ではないため、拡張の読み込みを止めるような扱いはしない。**

## 未決事項

- **`onInstalled` の `reason` で処理を分けるか。** 初回インストール（`install`）と更新（`update`）とで挙動を変える必要があるかを決めていない。現時点では設定内容が同一のため分ける理由は見当たらないが、[ADR 0013](../ADR/0013-persist-code-in-storage-local.md) の保存レコードがバージョン欄を持つため、**将来レコードの移行処理を置く場所として本モジュールが候補になる**。その場合は `reason` による分岐が必要になる。移行をここで行うか、サイドパネル UI の復元処理で行うかは決まっていない。
- **初回インストール時にサイドパネルを自動で開くか。** 拡張を入れた直後、ユーザが何をすればよいか分かる導線がない。開くとしても、どのタブに対して開くかという問題が残る。取り扱いを決めていない。
