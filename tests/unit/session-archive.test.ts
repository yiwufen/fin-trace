// 会话归档/恢复 单元测试 — issue #24
// 运行: npx tsx tests/unit/session-archive.test.ts
// 说明: session-store 的 DATA_DIR 在模块加载时基于 process.cwd() 计算，
//       因此先 chdir 到临时目录，再动态 import，实现测试隔离。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const workDir = mkdtempSync(join(tmpdir(), "fin-trace-archive-test-"));
mkdirSync(join(workDir, "data", "sessions"), { recursive: true });
process.chdir(workDir);

const { createSession, getSession, listSessions, listArchivedSessions, archiveSession, restoreSession, appendChatMessages, createExploration, appendStep, completeExploration } = await import(
  "../../src/session-store.js"
);

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

console.log("会话归档/恢复测试");

// ─── A2/A12: 归档保留数据 ───
const s1 = await createSession("测试会话 A");
await appendChatMessages(s1.id, [
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好，有什么可以帮你？" },
]);
const expl = createExploration("测试探索目标", ["贵州茅台"], 2);
// 将 exploration 持久化（appendStep 依据磁盘上的会话文件工作）
{
  const p = join(workDir, "data", "sessions", `${s1.id}.json`);
  const cur = JSON.parse(readFileSync(p, "utf-8"));
  cur.explorations.push(expl);
  writeFileSync(p, JSON.stringify(cur, null, 2), "utf-8");
}
await appendStep(s1.id, expl.id, {
  step: 1, phase: "EXPLORING", decision: "test", tools_used: ["lookup"],
  new_entities: [], new_findings_count: 0, total_findings: 0, total_entities: 1, total_events: 0,
});

await test("归档后会话文件保留且标记为 true，主列表不再返回", async () => {
  const archived = await archiveSession(s1.id);
  assert.ok(archived, "archiveSession 应返回会话");
  assert.equal(archived!.archived, true);
  assert.ok(archived!.archived_at, "应有归档时间");
  // 数据文件保留（不 unlink）
  const onDisk = await getSession(s1.id);
  assert.ok(onDisk, "归档后 getSession 仍可读取（文件未删除）");
  assert.equal(onDisk!.archived, true);
  // 数据完整保留
  assert.equal(onDisk!.messages.length, 2);
  assert.equal(onDisk!.messages[0].content, "你好");
  assert.equal(onDisk!.explorations.length, 1);
  assert.equal(onDisk!.explorations[0].steps.length, 1);
  assert.equal(onDisk!.explorations[0].id, expl.id);
  // 主列表默认排除归档
  const main = await listSessions();
  assert.ok(!main.some((s) => s.id === s1.id), "主列表不应包含归档会话");
  const archList = await listArchivedSessions();
  assert.ok(archList.some((s) => s.id === s1.id), "归档列表应包含该会话");
});

await test("不存在会话归档返回 falsy", async () => {
  const r = await archiveSession("nonexistent-id");
  assert.ok(!r);
});

// ─── A4: 主列表默认排除归档 ───
const s2 = await createSession("测试会话 B");
await test("创建 2 个会话归档 1 个后主列表长度减 1", async () => {
  // s1 已归档，s2 正常 → 主列表只含 s2
  const main = await listSessions();
  assert.equal(main.length, 1);
  assert.equal(main[0].id, s2.id);
  assert.equal((await listArchivedSessions()).length, 1);
});

// ─── A3: 恢复逻辑 ───
await test("恢复后归档标记清除、回到主列表且 updated_at 晚于 archived_at", async () => {
  const before = await getSession(s1.id);
  const archivedAt = before!.archived_at!;
  // 保证时间戳可比较
  await new Promise((r) => setTimeout(r, 20));
  const restored = await restoreSession(s1.id);
  assert.ok(restored, "restoreSession 应返回会话");
  assert.notEqual(restored!.archived, true);
  assert.equal(restored!.archived_at, undefined);
  const main = await listSessions();
  assert.ok(main.some((s) => s.id === s1.id), "恢复后应回到主列表");
  assert.ok(!main.some((s) => s.id === s1.id && s.archived_at));
  assert.equal((await listArchivedSessions()).some((s) => s.id === s1.id), false);
  assert.ok(
    new Date(main.find((s) => s.id === s1.id)!.updated_at).getTime() > new Date(archivedAt).getTime(),
    "updated_at 应晚于 archived_at（回到主列表顶部语义）",
  );
  // 数据仍完整
  const data = await getSession(s1.id);
  assert.equal(data!.messages.length, 2);
  assert.equal(data!.explorations.length, 1);
});

await test("不存在会话恢复返回 falsy", async () => {
  const r = await restoreSession("nonexistent-id");
  assert.ok(!r);
});

// ─── 归档列表排序 ───
await test("归档列表按归档时间倒序", async () => {
  const a = await createSession("排序 A");
  const b = await createSession("排序 B");
  await archiveSession(a.id);
  await new Promise((r) => setTimeout(r, 20));
  await archiveSession(b.id);
  const arch = await listArchivedSessions();
  // b 后归档，应排在 a 前
  assert.ok(arch.findIndex((s) => s.id === b.id) < arch.findIndex((s) => s.id === a.id));
});

// 清理（临时目录留给 OS）
console.log(`\npassed: ${passed}, failed: ${failed}`);
if (failed > 0) {
  console.log("存在失败用例");
  process.exit(1);
} else {
  console.log("全部通过");
}
