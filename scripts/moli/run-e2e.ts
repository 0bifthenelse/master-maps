/**
 * Moli E2E runner script.
 *
 * Starts Next production server on port 3100,
 * starts Moli serve on port 9222,
 * connects Playwright via CDP,
 * runs Playwright tests.
 *
 * Usage: tsx scripts/moli/run-e2e.ts
 */

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
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function main() {
  console.log("Starting Next.js production server...");
  const next = spawn("npm", ["run", "start", "--", "--port", String(NEXT_PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  next.stdout?.on("data", (d: Buffer) => process.stdout.write(`[next] ${d}`));
  next.stderr?.on("data", (d: Buffer) => process.stderr.write(`[next:err] ${d}`));

  console.log("Starting Moli serve...");
  const moli = spawn("moli", ["serve", "--layout", "--host", "127.0.0.1", "--port", String(MOLI_PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  moli.stdout?.on("data", (d: Buffer) => process.stdout.write(`[moli] ${d}`));
  moli.stderr?.on("data", (d: Buffer) => process.stderr.write(`[moli:err] ${d}`));

  try {
    console.log(`Waiting for Next.js on port ${NEXT_PORT}...`);
    await waitForPort("127.0.0.1", NEXT_PORT);
    console.log("Next.js ready.");

    console.log(`Waiting for Moli on port ${MOLI_PORT}...`);
    await waitForPort("127.0.0.1", MOLI_PORT);
    console.log("Moli ready.");

    // Verify Moli CDP endpoint
    const versionResp = await fetch(`http://127.0.0.1:${MOLI_PORT}/json/version`);
    const versionData = await versionResp.json() as { Browser?: string; "webSocketDebuggerUrl"?: string };
    console.log("Moli CDP version:", JSON.stringify(versionData, null, 2));

    // Run Playwright tests
    console.log("\nRunning Playwright E2E tests...");
    const pw = spawn("npx", ["playwright", "test", "--config", "playwright.config.ts"], {
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

    const exitCode = await new Promise<number>((resolve) => {
      pw.on("exit", resolve);
    });

    process.exitCode = exitCode;
    console.log(`Playwright exit code: ${exitCode}`);
  } finally {
    // Cleanup
    next.kill("SIGTERM");
    moli.kill("SIGTERM");
    // Force kill after 3 seconds
    setTimeout(() => {
      next.kill("SIGKILL");
      moli.kill("SIGKILL");
    }, 3000);
  }
}

main().catch((err) => {
  console.error("E2E runner failed:", err);
  process.exit(1);
});