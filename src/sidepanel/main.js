// サイドパネル UI の制御。本拡張で唯一、他のすべてを繋ぐモジュール。
// 設計: docs/module_design/main.md
//
// Python コードをこのスレッドで実行することはない（ADR 0005）。やるのは依頼と
// 表示だけである。

import { UI_TO_WORKER, WORKER_TO_UI } from "../shared/protocol.js";
import {
  applyViewState,
  createEditor,
  focusEditor,
  getCode,
  getViewState,
  showDiagnostics,
} from "./editor.js";

const STORAGE_KEY = "editorState";
const RECORD_VERSION = 1;

const IDLE_DELAY_MS = 500;

// 出力の上限（ADR 0023）。UI スレッドの DOM に積まれるため、Worker の分離では
// これを防げない。停止ボタンを押せなくなることは分離の目的そのものを失う。
const MAX_OUTPUT_LINES = 2000;
const MAX_LINE_CHARS = 10000;

// 実行の区切り（ADR 0024）。実行を開始したすべてのアートボードがこの行を持つ。
const RUN_SEPARATOR = "──────── 実行 ────────";

// 状態とツールバーの対応（ADR 0010）。ここ 1 箇所に閉じる。
// 印の色は style.css が body[data-state] から決める。
const STATES = {
  initializing: { label: "Pyodide を初期化中…", run: false, stop: false },
  ready: { label: "準備完了", run: true, stop: false },
  running: { label: "実行中…", run: false, stop: true },
  waitingInput: { label: "入力待ち", run: false, stop: true },
  done: { label: "準備完了", run: true, stop: false },
  error: { label: "準備完了", run: true, stop: false },
  initError: { label: "初期化に失敗しました", run: false, stop: false },
  restarting: { label: "停止しました。再初期化中…", run: false, stop: false },
};

const statusLabelEl = document.getElementById("status-label");
const runButton = document.getElementById("run-button");
const stopButton = document.getElementById("stop-button");
const editorEl = document.getElementById("editor");
const clearButton = document.getElementById("clear-button");
const outputEl = document.getElementById("output");

/** @type {import("@codemirror/view").EditorView | null} */
let view = null;
/** @type {Worker | null} */
let worker = null;
let state = "initializing";
/** @type {string | null} */
let currentRunId = null;
/** @type {string | null} */
let latestCheckId = null;
/** @type {number | null} */
let idleTimer = null;
/** 貼り付けで確定した行のうち、まだ input() へ渡していないもの（ADR 0022） @type {string[]} */
let stdinQueue = [];

// 入力待ちの行と、その中の編集可能な span。出力領域そのものは編集不可のまま
// 保ち、ここだけを開ける（ADR 0012 / 入力面の実装）。
let stdinLine = null;
let stdinInput = null;

// 貼り付けの余り。改行で終わっていない最後の行は確定させず、次の入力行へ持ち越す
// （ADR 0022）。キューが空になってから使う。
let stdinTail = "";

// 省略した旨を残す 1 行。黙って消すと出力の先頭が本当の先頭だと読めてしまう。
let truncatedNotice = null;

let idCounter = 0;

// ---------------------------------------------------------------- 起動

async function main() {
  setState("initializing");

  // エディタの表示と Pyodide の初期化を分離する（基本設計 §3.1）。初期化の
  // 数秒を待たせず、編集可能な状態で見せて実行ボタンだけを無効にしておく。
  view = createEditor({ parent: editorEl, onDocChanged: handleDocChanged });

  worker = createWorker();

  // Pyodide の初期化は待たない
  await restoreState();

  runButton.addEventListener("click", handleRunClick);
  stopButton.addEventListener("click", handleStopClick);
  clearButton.addEventListener("click", clearOutput);

  // pagehide は登録しない。サイドパネルの文書では発火しない（ADR 0019）。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveState();
  });
}

async function restoreState() {
  let record = null;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    record = stored[STORAGE_KEY] ?? null;
  } catch (err) {
    // 復元できなかった事実は握り潰さない。黙って空の文書を出すと、ユーザは
    // 前回の編集が消えたと受け取る。
    appendOutput("notice", "前回の内容を復元できませんでした。空の文書で始めます。", "muted");
    return;
  }

  if (record === null) return; // 初回起動

  // 未知（＝現在より新しい）版は読まない。こちらの解釈で読むと、内容を
  // 取り違えたまま上書きする。
  if (!Number.isFinite(record.version) || record.version > RECORD_VERSION) {
    appendOutput("notice", "保存されている内容が新しい形式のため復元できませんでした。", "muted");
    return;
  }

  // 既知の古い版はここで現在の形へ移行する。移行を Service Worker の
  // onInstalled に置かないのは、あちらがいつでも停止するため（service-worker.md）。
  // 版は現時点で 1 のみで、移行の対象がまだ無い。

  applyViewState(view, record);
}

function createWorker() {
  const url = new URL("../worker/pyodide-worker.js", import.meta.url);
  const created = new Worker(url, { type: "module" });
  created.onmessage = handleWorkerMessage;

  // Worker が起動できない場合、Worker 側の initError は送られてこない。
  // 送り手がいないためである。ここを塞がないと初期化中のまま永久に止まる。
  created.onerror = (event) => {
    appendOutput("error", `Worker を起動できませんでした: ${event.message ?? event.type}`);
    setState("initError");
  };

  return created;
}

function replaceWorker() {
  worker.terminate();

  // 破棄した Worker から遅れて届くメッセージは、runId が一致しないため
  // handleWorkerMessage が捨てる。
  currentRunId = null;
  freezeStdinLine();

  worker = createWorker();
  setState("restarting");
}

// ---------------------------------------------------------------- 受信

function handleWorkerMessage(event) {
  const data = event.data;

  // 停止を挟むと破棄済み Worker からの遅延メッセージがあり得る。runId を持つ
  // メッセージは currentRunId と一致しない限り捨てる。これが runId を設けた
  // 目的そのものである。異常ではなく、停止の正常な帰結。
  if ("runId" in data && data.runId !== currentRunId) return;

  switch (data.type) {
    case WORKER_TO_UI.READY:
      setState("ready");
      // 復元したコードがある場合に限り、初回の検査を一度行う。空の文書では
      // 意味がない。見送ると、1 文字打った 500ms 後に打った場所とは無関係な
      // ところへ唐突に下線が出ることになる。
      if (getCode(view).trim() !== "") requestCheck();
      break;

    case WORKER_TO_UI.STDOUT:
      appendOutput("stdout", data.text);
      break;

    case WORKER_TO_UI.STDERR:
      appendOutput("stderr", data.text);
      break;

    case WORKER_TO_UI.STDIN:
      // beginStdin より先に状態を進める。キューが残っていると beginStdin が
      // その場で commitStdin を呼び、commitStdin は waitingInput 以外では
      // 何もせず戻るため。
      setState("waitingInput");
      beginStdin(data.prompt);
      break;

    case WORKER_TO_UI.DONE:
      // ready / done / error はツールバーの表示が同一であり、実行が終わった
      // ことを語れるのが出力領域しかない（Figma アートボード 04）。
      appendOutput("notice", "実行が完了しました", "success");
      currentRunId = null;
      setState("done");
      endRun();
      break;

    case WORKER_TO_UI.ERROR:
      // traceback には要約行が含まれる。message を足すと要約が二重になる。
      appendOutput("error", data.traceback || data.message);
      currentRunId = null;
      setState("error");
      endRun();
      break;

    case WORKER_TO_UI.INIT_ERROR:
      appendOutput("error", data.message);
      setState("initError");
      break;

    case WORKER_TO_UI.CHECK_RESULT:
      applyCheckResult(data);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------- 操作

function handleRunClick() {
  // ボタンの活性は表示上の保証にすぎないため、防御を置く。
  if (state !== "ready" && state !== "done" && state !== "error") return;

  currentRunId = nextId("run");

  saveState(); // 実行時のフラッシュ（基本設計 §2.2）

  // 実行中は検査を行わないため、保留中の契機を残さない
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  // 出力領域は消さない。消すと、前回の traceback を見ながら直して実行する流れで
  // 直す根拠が失われ、input() で対話した履歴も実行のたびに消える。繰り返し
  // 実行したときの境目はこの区切りが示す（ADR 0024）。
  appendOutput("notice", RUN_SEPARATOR);

  worker.postMessage({ type: UI_TO_WORKER.RUN, runId: currentRunId, code: getCode(view) });
  setState("running");
}

function handleStopClick() {
  // 停止すると done も error も届かない。理由が履歴に残らないと、実行が
  // 終わったのか止めたのか後から読めない。
  appendOutput("notice", "実行を停止しました", "stopped");
  endRun();
  replaceWorker();
}

function setState(next) {
  const spec = STATES[next];
  if (spec === undefined) return;

  state = next;
  document.body.dataset.state = next;
  statusLabelEl.textContent = spec.label;
  runButton.disabled = !spec.run;
  stopButton.disabled = !spec.stop;

  // 再試行の導線はツールバーではなく出力領域の中に置く（Figma アートボード 06）。
  // ツールバーに置くと、初期化に成功した後もボタンの居場所が残り、状態ごとに
  // ツールバーの構造そのものが変わる。
  if (next === "initError") appendRetryBlock();
}

function appendRetryBlock() {
  const block = document.createElement("div");
  block.className = "out-retry";

  const note = document.createElement("div");
  note.className = "out-notice";
  note.textContent = "Python の実行はできませんが、コードの編集と保存は続けられます。";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button--primary";
  button.textContent = "再試行";
  button.addEventListener("click", () => {
    block.remove();
    replaceWorker();
  });

  block.append(note, button);
  outputEl.append(block);
  scrollOutputToEnd();
}

// ---------------------------------------------------------------- 出力領域

/**
 * 出力領域へ 1 件追記する（基本設計 §5.2）。
 * 種別ごとのタブや領域は設けない。届いた順に 1 本の流れとして積む。
 *
 * `variant` は notice の見え方を選ぶ。Figma は notice の内容ごとに色を変えて
 * いる（完了は status/success、停止は status/running、進行中は text/disabled）
 * ため、kind だけでは足りない。
 */
function appendOutput(kind, text, variant) {
  let body = String(text);

  // batched は行単位で呼ばれる以上、改行を含まない巨大な出力が 1 行として届く
  if (body.length > MAX_LINE_CHARS) {
    body = `${body.slice(0, MAX_LINE_CHARS)} …（以降を省略しました）`;
  }

  const el = document.createElement("div");
  if (kind === "notice") {
    el.className = variant ? `out-notice out-notice--${variant}` : "out-notice";
  } else if (kind === "error") {
    el.className = "out-error";
  } else {
    el.className = `out-line out-${kind}`;
  }

  // テキストとして入れる。文字列として扱わないと print("<b>") が表示を壊す。
  el.textContent = body;

  outputEl.append(el);
  trimOutput();
  scrollOutputToEnd();
  return el;
}

function trimOutput() {
  if (outputEl.children.length <= MAX_OUTPUT_LINES) return;

  let removed = 0;
  for (const child of [...outputEl.children]) {
    if (outputEl.children.length <= MAX_OUTPUT_LINES) break;
    // 入力待ちの行は対象から外す。プロンプトが消えると、何を聞かれているか
    // 分からないままキャレットだけが残る。
    if (child === stdinLine || child === truncatedNotice) continue;
    child.remove();
    removed += 1;
  }

  if (removed > 0 && truncatedNotice === null) {
    truncatedNotice = document.createElement("div");
    truncatedNotice.className = "out-notice out-notice--muted";
    truncatedNotice.textContent = "古い出力を省略しました";
    outputEl.prepend(truncatedNotice);
  }
}

function scrollOutputToEnd() {
  outputEl.scrollTop = outputEl.scrollHeight;
}

/**
 * 入力待ちの最中もクリアボタンは押せる。無効にすると「出力が溢れて読めないから
 * 消したい」という一番ありそうな動機を塞ぐ。一方でプロンプトまで消すと何を
 * 聞かれているか分からなくなるため、入力待ちの行は残す。
 */
function clearOutput() {
  if (state === "waitingInput" && stdinLine !== null) {
    while (outputEl.firstChild !== null && outputEl.firstChild !== stdinLine) {
      outputEl.firstChild.remove();
    }
  } else {
    outputEl.replaceChildren();
  }
  truncatedNotice = null;
}

// ---------------------------------------------------------------- 入力待ち

/**
 * 入力待ちに入る。プロンプトは stdin のペイロードで届き、Worker は print で
 * 流さない（ADR 0016）ため、表示は本関数の責任である。
 */
function beginStdin(prompt) {
  const line = document.createElement("div");
  line.className = "out-line out-line--stdin";

  const promptEl = document.createElement("span");
  promptEl.className = "out-prompt";
  promptEl.textContent = prompt; // 空文字でも行は立てる

  const inputEl = document.createElement("span");
  inputEl.className = "out-input";
  inputEl.setAttribute("contenteditable", "plaintext-only");
  inputEl.addEventListener("keydown", handleStdinKeydown);
  inputEl.addEventListener("beforeinput", handleStdinBeforeInput);

  line.append(promptEl, inputEl);
  outputEl.append(line);
  stdinLine = line;
  stdinInput = inputEl;
  scrollOutputToEnd();

  // 貼り付けで確定済みの行が残っていれば、それを先に渡す（ADR 0022）。
  // プロンプトは出し、消費した行も input として残す。
  if (stdinQueue.length > 0) {
    commitStdin(stdinQueue.shift());
    return;
  }

  // 改行で終わっていなかった最後の行は、ここで持ち越し分として入力行に入る
  if (stdinTail !== "") {
    inputEl.textContent = stdinTail;
    stdinTail = "";
  }

  inputEl.focus();
  moveCaretToEnd(inputEl);
}

function handleStdinKeydown(event) {
  // 入力行が空のときに限り Ctrl+D を EOF として扱う（ADR 0021）。文字が
  // 入っているときは無視する。preventDefault すればブックマーク追加には
  // 奪われない（実機で確認済み）。
  if (event.key === "d" && event.ctrlKey && !event.altKey && !event.metaKey) {
    if (stdinInput.textContent === "") {
      event.preventDefault();
      commitStdin(null);
    }
    return;
  }

  if (event.key !== "Enter") return;

  // 修飾キーを伴う Enter は無視する。改行も入れない。1 行 = 1 入力という
  // 対応を崩さないため。
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
    event.preventDefault();
    return;
  }

  // 変換中の Enter で確定しない。実機では変換確定の Enter は keydown として
  // 届かなかったが、IME の実装差に対する保険として判定を残す。誤れば変換を
  // 確定しただけで入力が送信される。
  if (event.isComposing || event.keyCode === 229) return;

  event.preventDefault();
  commitStdin(stdinInput.textContent);
}

/**
 * 貼り付けを横取りし、素のままでは入れさせない（ADR 0022）。横取りしないと
 * 改行を含んだ 1 つの値として確定する。input() の返り値に改行が含まれないことは
 * Python の約束であり、破ると後続の int() などが意図しない形で壊れる。
 */
function handleStdinBeforeInput(event) {
  if (event.inputType !== "insertFromPaste") return;
  event.preventDefault();

  const raw = event.dataTransfer?.getData("text/plain") ?? "";
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  // 改行で終わっていない最後の行。末尾が改行なら空文字になる。
  const tail = lines.pop();

  if (lines.length === 0) {
    insertAtCaret(tail);
    return;
  }

  // 1 本目は現在の入力へ足して確定し、残りはキューへ積む
  insertAtCaret(lines[0]);
  const text = stdinInput.textContent;
  stdinQueue.push(...lines.slice(1));
  stdinTail = tail;
  commitStdin(text);
}

function insertAtCaret(text) {
  if (text === "") return;

  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || !stdinInput.contains(selection.anchorNode)) {
    stdinInput.textContent += text;
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  stdinInput.normalize();
}

function moveCaretToEnd(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * 入力を確定し、stdinResult を返す。text が null のときは EOF を表し、Worker 側の
 * input() は EOFError を送出する（ADR 0021）。
 */
function commitStdin(text) {
  // 確定の直前に停止ボタンが押された経路があり得る。その場合 currentRunId は
  // 既に null で、送り先の Worker も破棄されている。
  if (state !== "waitingInput") return;

  const runId = currentRunId;
  freezeStdinLine(text);

  // 何も残さないと、履歴を読み返したときに実行が中断した理由が消える。
  // EOFError の traceback だけが唐突に現れることになる。
  if (text === null) appendOutput("notice", "EOF を送信しました", "muted");

  worker.postMessage({ type: UI_TO_WORKER.STDIN_RESULT, runId, text });
  setState("running");
}

/** 入力中の行を編集不可に戻し、キャレットを外す。確定と停止の両方から呼ぶ。 */
function freezeStdinLine(text) {
  if (stdinInput === null) return;

  if (typeof text === "string") stdinInput.textContent = text;
  stdinInput.removeAttribute("contenteditable");
  stdinInput.removeEventListener("keydown", handleStdinKeydown);
  stdinInput.removeEventListener("beforeinput", handleStdinBeforeInput);
  stdinInput.blur();

  stdinInput = null;
  stdinLine = null;
}

function endRun() {
  // キューが実行をまたいで残ると、次の実行が身に覚えのない値で進む（ADR 0022）
  stdinQueue = [];
  stdinTail = "";

  // 実行中にユーザが自分でエディタを触っていた場合、そのフォーカスを奪い返す
  // 理由はない。入力の確定時ではなく実行の終了時に戻すのは、input() がループ
  // する場合にフォーカスが往復するのを避けるため。
  if (outputEl.contains(document.activeElement)) focusEditor(view);
}

// ---------------------------------------------------------------- 保存と検査

function handleDocChanged() {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(onIdle, IDLE_DELAY_MS);
}

function onIdle() {
  idleTimer = null;
  // 保存を先に置くのは、検査が状態によっては見送られるのに対し、保存はどの
  // 状態でも行うべきだからである。
  saveState();
  requestCheck();
}

async function saveState() {
  const record = { version: RECORD_VERSION, ...getViewState(view) };

  try {
    // レコードは 1 件。複数ウィンドウから同時に書かれた場合は後勝ちとする
    // （ADR 0013）。storage.onChanged による追従は行わない。
    await chrome.storage.local.set({ [STORAGE_KEY]: record });
  } catch (err) {
    // 保存できていないことを黙っていると、パネルを閉じた時点で編集が失われる。
    // hidden からの呼び出しでは、この通知が出る前に文書が破棄され得る。
    appendOutput("notice", `保存できませんでした: ${err?.message ?? err}`, "muted");
  }
}

/**
 * 検査を行わない状態がある（基本設計 §3.4）。初期化完了前と、実行中・入力待ちの
 * 間。その間、既に表示されている下線は消さずに残す。消すと直ったと読めてしまう。
 */
function requestCheck() {
  if (state !== "ready" && state !== "done" && state !== "error") return;

  latestCheckId = nextId("check");
  worker.postMessage({ type: UI_TO_WORKER.CHECK, checkId: latestCheckId, code: getCode(view) });
}

function applyCheckResult(payload) {
  // 検査は非同期で、結果が届くまでに次の入力が進んでいることがある。古い結果を
  // 当てると、既に直したエラーの下線が復活する。
  if (payload.checkId !== latestCheckId) return;

  // 空配列を渡すのはここだけ。検査が通ったときにのみ下線が消える。
  showDiagnostics(view, payload.diagnostics);
}

/**
 * 一意性はサイドパネルの文書が生きている間だけ保てればよい。パネルを開き直せば
 * Worker も作り直され、古い識別子を持つ相手は存在しない。
 */
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

main();
