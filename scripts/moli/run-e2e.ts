import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

function stopGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* Already gone. */
  }
}

async function main(): Promise<void> {
  console.log("Starting Next.js production server...");
  /* Its own process group, so stopping it also stops the next-server that npm and the shell start. */
  const next: ChildProcess = spawn("npm", ["run", "start", "--", "--port", String(NEXT_PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    detached: true,
  });
  next.stdout?.on("data", (data: Buffer) => process.stdout.write(`[next] ${data}`));
  next.stderr?.on("data", (data: Buffer) => process.stderr.write(`[next:err] ${data}`));

  /* Without Moli (or with E2E_BROWSER=local) the fixtures launch the local Chromium. */
  const useMoli = process.env.E2E_BROWSER !== "local" && spawnSync("sh", ["-c", "command -v moli"]).status === 0;
  let moli: ChildProcess | null = null;
  if (useMoli) {
    console.log("Starting Moli serve...");
    moli = spawn(
      "moli",
      ["serve", "--layout", "--host", "127.0.0.1", "--port", String(MOLI_PORT), "--timeout", "600"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: true },
    );
    moli.stdout?.on("data", (data: Buffer) => process.stdout.write(`[moli] ${data}`));
    moli.stderr?.on("data", (data: Buffer) => process.stderr.write(`[moli:err] ${data}`));
  } else {
    console.log("Moli not available: using the local Chromium.");
  }

  try {
    console.log(`Waiting for Next.js on port ${NEXT_PORT}...`);
    await waitForPort("127.0.0.1", NEXT_PORT);
    console.log("Next.js ready.");
    if (useMoli) {
      console.log(`Waiting for Moli on port ${MOLI_PORT}...`);
      await waitForPort("127.0.0.1", MOLI_PORT);
      const versionResp = await fetch(`http://127.0.0.1:${MOLI_PORT}/json/version`);
      const versionData = await versionResp.json() as { Browser?: string; "webSocketDebuggerUrl"?: string };
      console.log("Moli CDP version:", JSON.stringify(versionData, null, 2));
    }
    console.log("\nRunning Playwright E2E tests...");
    /* No shell: arguments such as a -g pattern with "|" reach Playwright verbatim. */
    const pw: ChildProcess = spawn("npx", ["playwright", "test", "--config", "playwright.config.ts", ...process.argv.slice(2)], {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        MOLI_CDP: `http://127.0.0.1:${MOLI_PORT}`,
        ...(useMoli ? {} : { E2E_BROWSER: "local" }),
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
    stopGroup(next, "SIGTERM");
    moli?.kill("SIGTERM");
    setTimeout(() => {
      stopGroup(next, "SIGKILL");
      moli?.kill("SIGKILL");
    }, 3000).unref();
  }
}

main().catch((error: unknown) => {
  console.error("E2E runner failed:", error);
  process.exit(1);
});
