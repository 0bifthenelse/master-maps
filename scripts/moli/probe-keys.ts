import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const child: ChildProcess = spawn("/master/internet/target/release/master-internet-unit", [], {
  cwd: "/master/internet",
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();
child.stdout?.on("data", (c: Buffer) => {
  buffer += c.toString("utf8");
  let i = buffer.indexOf("\n");
  while (i >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf("\n");
    if (!line) continue;
    try {
      const p = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (typeof p.id !== "number") continue;
      const w = pending.get(p.id);
      if (!w) continue;
      pending.delete(p.id);
      w(p.result ?? p.error);
    } catch { /* partial */ }
  }
});
function rpc(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const w = Promise.withResolvers<unknown>();
  pending.set(id, (v) => w.resolve(v));
  setTimeout(() => { if (pending.delete(id)) w.resolve({ timeout: true }); }, 40000);
  return w.promise;
}
function notify(m: string, p: unknown): void { child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n"); }
async function tool(n: string, a: unknown = {}): Promise<string> {
  const r = (await rpc("tools/call", { name: n, arguments: a })) as { content?: { text?: string }[] };
  return (r.content ?? []).map((p) => p.text ?? "").join("");
}
const ZOOM = `(() => { const n=document.getElementById("scene-diagnostics"); const m=n? n.textContent.match(/camera-zoom=(-?[0-9.]+)/):null; const t=n? n.textContent.match(/camera-target-x=(-?[0-9.]+)/):null; return { zoom: m?Number(m[1]):null, tx: t?Number(t[1]):null, active: document.activeElement ? document.activeElement.tagName + "#" + (document.activeElement.id||"") : "none" }; })()`;
async function main(): Promise<void> {
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "p", version: "1" } });
  notify("notifications/initialized", {});
  await tool("profile_open", { name: "w4keys" });
  await tool("gpu_mode", { mode: "hardware" });
  await tool("set_viewport", { w: 1440, h: 900 });
  await tool("navigate", { url: "http://localhost:3202/" });
  await sleep(6000);
  console.log("initial:", await tool("evaluate", { expr: ZOOM }));
  console.log("--- press Equal with no focus ---");
  await tool("press_key", { key: "Equal" });
  await sleep(700);
  console.log("after Equal:", await tool("evaluate", { expr: ZOOM }));
  console.log("--- click canvas to focus ---");
  await tool("click_xy", { x: 700, y: 500 });
  await sleep(300);
  console.log("active after click:", await tool("evaluate", { expr: ZOOM }));
  await tool("press_key", { key: "Equal" });
  await sleep(700);
  console.log("after Equal#2:", await tool("evaluate", { expr: ZOOM }));
  await tool("press_key", { key: "KeyL" });
  await sleep(700);
  console.log("after KeyL:", await tool("evaluate", { expr: ZOOM }));
  console.log("--- real synthetic keydown via evaluate ---");
  await tool("evaluate", { expr: `(() => { for (let i=0;i<3;i++) window.dispatchEvent(new KeyboardEvent("keydown", { code: "Equal", key: "=", bubbles: true })); return true; })()` });
  await sleep(900);
  console.log("after synthetic x3:", await tool("evaluate", { expr: ZOOM }));
  console.log("--- wheel scroll on canvas ---");
  await tool("scroll", { dx: 0, dy: -240 });
  await sleep(700);
  console.log("after wheel:", await tool("evaluate", { expr: ZOOM }));
  await tool("profile_close");
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => { child.kill("SIGTERM"); });
