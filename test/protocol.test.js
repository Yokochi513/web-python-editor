// protocol.js が基本設計 §4 のメッセージ仕様と一致していることを確かめる。
//
// ここで守りたいのは「綴りの食い違いが無言の不通になる」ことである（protocol.md）。
// 期待値は設計書の表からそのまま写したものを持ち、実装と突き合わせる。実装を
// 参照して期待値を作ると、変えたことに気付けなくなる。

import test from "node:test";
import assert from "node:assert/strict";

import { UI_TO_WORKER, WORKER_TO_UI } from "../src/shared/protocol.js";

// 基本設計 §4 の「UI → Worker」の表
const EXPECTED_UI_TO_WORKER = {
  RUN: "run",
  STDIN_RESULT: "stdinResult",
  CHECK: "check",
};

// 基本設計 §4 の「Worker → UI」の表
const EXPECTED_WORKER_TO_UI = {
  READY: "ready",
  STDOUT: "stdout",
  STDERR: "stderr",
  STDIN: "stdin",
  DONE: "done",
  ERROR: "error",
  INIT_ERROR: "initError",
  CHECK_RESULT: "checkResult",
};

test("UI → Worker の種別が基本設計 §4 と一致する", () => {
  assert.deepEqual({ ...UI_TO_WORKER }, EXPECTED_UI_TO_WORKER);
});

test("Worker → UI の種別が基本設計 §4 と一致する", () => {
  assert.deepEqual({ ...WORKER_TO_UI }, EXPECTED_WORKER_TO_UI);
});

test("停止要求の種別を持たない", () => {
  // 停止は worker.terminate() で行うため、対応するメッセージが存在しない
  const names = [...Object.keys(UI_TO_WORKER), ...Object.keys(WORKER_TO_UI)];
  assert.ok(!names.some((name) => name.includes("STOP")), names.join(", "));
});

test("値に重複が無い", () => {
  const values = [...Object.values(UI_TO_WORKER), ...Object.values(WORKER_TO_UI)];
  assert.equal(new Set(values).size, values.length, values.join(", "));
});

test("import 側から書き換えられない", () => {
  assert.ok(Object.isFrozen(UI_TO_WORKER));
  assert.ok(Object.isFrozen(WORKER_TO_UI));
  assert.throws(() => {
    "use strict";
    UI_TO_WORKER.RUN = "変えた";
  });
});

test("振る舞いを持たない（関数を公開しない）", async () => {
  const module = await import("../src/shared/protocol.js");
  const functions = Object.entries(module).filter(([, value]) => typeof value === "function");
  assert.deepEqual(functions, [], "protocol.js は定数だけを公開する");
});
