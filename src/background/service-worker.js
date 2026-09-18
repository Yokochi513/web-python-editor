// Service Worker。ツールバーアイコンのクリックでサイドパネルを開く設定だけを持つ。
// 設計: docs/module_design/service-worker.md

// 状態は一切持たない。MV3 の Service Worker は待機したまま放置されると停止され、
// メモリ上の状態が失われる。持たせると「たまたま停止していなかったときだけ動く」
// 挙動になるため、最初から持たない。
async function initPanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    // 再試行はしない。Service Worker にはユーザへ提示する画面がなく、
    // エラーを出力領域へ出す経路（ADR 0011）はサイドパネルが開いていて
    // 初めて成立する。その入口の設定自体が失敗している以上、ここで拾える
    // 手段は開発者向けのログに限られる。
    //
    // この失敗でアイコンのクリックには反応しなくなるが、Chrome のサイドパネル
    // 一覧から選べば拡張自体は使える。致命的ではない。
    console.error("setPanelBehavior に失敗した", err);
  }
}

// onInstalled への登録だけで足りる。setPanelBehavior の設定は Service Worker の
// 停止・再起動をまたいで残ることを実機で確認済み。起動のたびに呼び直す必要はない。
//
// reason（install / update）による分岐は置かない。どちらも設定内容は同じであり、
// 保存レコードの移行は読む側の restoreState が受け持つ（main.md）。
chrome.runtime.onInstalled.addListener(initPanelBehavior);
