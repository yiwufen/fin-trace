// 自动化测试：会话归档 / 恢复 API（issue #24）
//
// 运行方式：npx tsx tests/archive-restore.test.ts
// 退出码 0 = 全部通过；非 0 = 存在失败。
//
// 测试隔离：会话存储路径为 process.cwd()/data/sessions，
// 测试在临时目录中执行（process.chdir），不污染真实 data/。

import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// ─── 测试环境：临时目录 + 空 settings（无 admin token，免鉴权）───

const tmp = mkdtempSync(join(tmpdir(), "fin-trace-archive-test-"));
const origCwd = process.cwd();
mkdirSync(join(tmp, "data"), { recursive: true });
writeFileSync(join(tmp, "data", "settings.json"), JSON.stringify({ web: { admin_token: "" } }), "utf-8");

// ─── mock HTTP req/res ───

function makeReq(url: string, method = "GET"): IncomingMessage {
  // IncomingMessage 的 url/method/headers 正常由 HTTP parser 填充，测试中直接注入
  const req = new IncomingMessage({ headers: {} } as never);
  (req as { url: string }).url = url;
  (req as { method: string }).method = method;
  req.headers = { host: "localhost" };
  return req;
}

interface CapturedResponse {
  status: number;
  body: string;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: "" };
  const res = {
    statusCode: 200,
    writeHead(code: number, _headers?: unknown) {
      captured.status = code;
      return this;
    },
    end(data?: string | Buffer) {
      if (data) captured.body = String(data);
      return this;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function main(): Promise<void> {
  // 关键：session-store 的 DATA_DIR 在模块加载时由 process.cwd() 解析，
  // 必须先 chdir 再动态 import，测试才能写入临时目录（不污染真实 data/）
  process.chdir(tmp);
  const { createSession, getSession, listSessions, listArchivedSessions } =
    await import("../src/session-store.js");
  const { handleApiRequest } = await import("../src/api.js");

  async function api(url: string, method = "GET"): Promise<CapturedResponse> {
    const { res, captured } = makeRes();
    await handleApiRequest(makeReq(url, method), res);
    return captured;
  }

  try {
    console.log("场景 ①：归档后会话从默认列表消失、出现在归档列表");
    const s1 = await createSession("测试会话A");
    const s2 = await createSession("测试会话B");
    let resp = await api("/api/sessions");
    let list = JSON.parse(resp.body) as { id: string }[];
    assert(list.some((s) => s.id === s1.id), "归档前会话 A 在默认列表");
    resp = await api(`/api/sessions/${s1.id}/archive`, "POST");
    assert(resp.status === 200, "归档 API 返回 200");
    const archResp = JSON.parse(resp.body) as { archived: boolean };
    assert(archResp.archived === true, "归档响应含 archived: true");
    list = JSON.parse((await api("/api/sessions")).body) as { id: string }[];
    assert(!list.some((s) => s.id === s1.id), "归档后会话 A 从默认列表消失（服务端过滤）");
    assert(list.some((s) => s.id === s2.id), "未归档会话 B 仍在默认列表");
    const archList = JSON.parse((await api("/api/sessions?archived=1")).body) as { id: string; title: string }[];
    assert(archList.some((s) => s.id === s1.id && s.title === "测试会话A"), "归档列表（?archived=1）包含会话 A 及标题");
    assert(!archList.some((s) => s.id === s2.id), "归档列表不包含未归档会话 B");

    console.log("场景 ④：归档持久化到会话 JSON 文件（archived === true）");
    const raw1 = JSON.parse(readFileSync(join(tmp, "data", "sessions", `${s1.id}.json`), "utf-8")) as { archived?: boolean; archived_at?: string };
    assert(raw1.archived === true, "JSON 文件中 archived === true");
    assert(typeof raw1.archived_at === "string" && raw1.archived_at.length > 0, "JSON 文件中记录 archived_at");
    const storeList = await listSessions();
    assert(!storeList.some((s) => s.id === s1.id), "store listSessions 过滤归档会话");
    const storeArchived = await listArchivedSessions();
    assert(storeArchived.some((s) => s.id === s1.id), "store listArchivedSessions 返回归档会话");

    console.log("场景 ②：恢复后会话回到默认列表、归档列表移除");
    resp = await api(`/api/sessions/${s1.id}/restore`, "POST");
    assert(resp.status === 200, "恢复 API 返回 200");
    assert((JSON.parse(resp.body) as { restored: boolean }).restored === true, "恢复响应含 restored: true");
    list = JSON.parse((await api("/api/sessions")).body) as { id: string }[];
    assert(list.some((s) => s.id === s1.id), "恢复后会话 A 回到默认列表");
    const archList2 = JSON.parse((await api("/api/sessions?archived=1")).body) as { id: string }[];
    assert(!archList2.some((s) => s.id === s1.id), "恢复后会话 A 从归档列表消失");
    const raw1b = JSON.parse(readFileSync(join(tmp, "data", "sessions", `${s1.id}.json`), "utf-8")) as { archived?: boolean };
    assert(raw1b.archived === undefined, "恢复后 JSON 文件清除归档标记（持久化）");

    console.log("场景 ③：不存在会话 ID 归档 / 恢复返回 404");
    resp = await api("/api/sessions/not-exist-id/archive", "POST");
    assert(resp.status === 404, "归档不存在会话返回 404");
    resp = await api("/api/sessions/not-exist-id/restore", "POST");
    assert(resp.status === 404, "恢复不存在会话返回 404");

    console.log("补充：重复归档幂等 / 未归档会话可恢复（幂等分支）");
    resp = await api(`/api/sessions/${s2.id}/archive`, "POST");
    assert(resp.status === 200, "再次归档返回 200");
    resp = await api(`/api/sessions/${s2.id}/archive`, "POST");
    assert(resp.status === 200, "重复归档幂等（200）");
    resp = await api(`/api/sessions/${s2.id}/restore`, "POST");
    assert(resp.status === 200, "归档会话恢复成功");
    const s2After = await getSession(s2.id);
    assert(s2After !== null && s2After.archived !== true, "恢复后 store 中无归档标记");

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    process.chdir(origCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
}

void main();
