import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NEXT_PORT = 3100;
const MOLI_PORT = 9222;

async function waitForPort(host: string, port: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://${host}:${port}`);
      if (resp.ok || resp.status < 500) return;
    } catch {
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function main(): Promise<void> {
  console.log("Starting Next.js production server...");
  const next: ChildProcess = spawn("npm", ["run", "start", "--", "--port", String(NEXT_PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  next.stdout?.on("data", (data: Buffer) => process.stdout.write(`[next] ${data}`));
  next.stderr?.on("data", (data: Buffer) => process.stderr.write(`[next:err] ${data}`));

  console.log("Starting Moli serve...");
  const moli: ChildProcess = spawn(
    "moli",
    ["serve", "--layout", "--host", "127.0.0.1", "--port", String(MOLI_PORT), "--timeout", "600"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: true },
  );
  moli.stdout?.on("data", (data: Buffer) => process.stdout.write(`[moli] ${data}`));
  moli.stderr?.on("data", (data: Buffer) => process.stderr.write(`[moli:err] ${data}`));

  try {
    console.log(`Waiting for Next.js on port ${NEXT_PORT}...`);
    await waitForPort("127.0.0.1", NEXT_PORT);
    console.log("Next.js ready.");
    console.log(`Waiting for Moli on port ${MOLI_PORT}...`);
    await waitForPort("127.0.0.1", MOLI_PORT);
    console.log("Moli ready.");

    const versionResp = await fetch(`http://127.0.0.1:${MOLI_PORT}/json/version`);
    const versionData = await versionResp.json() as { Browser?: string; "webSocketDebuggerUrl"?: string };
    console.log("Moli CDP version:", JSON.stringify(versionData, null, 2));
    console.log("\nRunning Playwright E2E tests...");
    const pw: ChildProcess = spawn("npx", ["playwright", "test", "--config", "playwright.config.ts", ...process.argv.slice(2)], {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        MOLI_CDP: `http://127.0.0.1:${MOLI_PORT}`,
        NEXT_PUBLIC_MAP_DIAGNOSTICS: "1",
        PLAYWRIGHT_BROWSERS_NONE: "1",
      },
    });
    const exit = Promise.withResolvers<number>();
    pw.on("exit", (code) => exit.resolve(code ?? 1));
    const exitCode = await exit.promise;
    process.exitCode = exitCode;
    console.log(`Playwright exit code: ${exitCode}`);
  } finally {
    next.kill("SIGTERM");
    moli.kill("SIGTERM");
    setTimeout(() => {
      next.kill("SIGKILL");
      moli.kill("SIGKILL");
    }, 3000);
  }
}

main().catch((error: unknown) => {
  console.error("E2E runner failed:", error);
  process.exit(1);
});
