// Tests that an unactionable lock timeout names the lock file the operator must inspect.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { acquireGatewayLock, resolveGatewayLockPaths } from "./gateway-lock.js";

const fixtureRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-gateway-lock-unactionable-",
});

// A live PID whose identity the inspector cannot confirm: `/proc` reads fail
// when the reader runs outside the container that wrote the lock, so the owner
// stays "unknown" and the lock is never reclaimed, whatever its age.
const unverifiableOwner = {
  readProcessCmdline: () => null,
  readProcessStartTime: () => null,
};

async function makeCase() {
  const stateDir = await fixtureRootTracker.make("case");
  const lockDir = path.join(stateDir, "__locks");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
  return { env, lockDir, ...resolveGatewayLockPaths(env, lockDir) };
}

describe("Gateway lock timeout diagnostics", () => {
  beforeAll(async () => {
    await fixtureRootTracker.setup();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
  });

  it("names the state lock file when a held owner cannot be verified", async () => {
    const { env, lockDir, stateLockPath } = await makeCase();
    const holder = await acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      role: "gateway",
      timeoutMs: 2_000,
    });
    expect(holder).not.toBeNull();

    try {
      // withLegacyMigrationStateLock budgets: 250 ms to win, poll every 25 ms.
      const attempt = acquireGatewayLock({
        allowInTests: true,
        env,
        lockDir,
        role: "sqlite-maintenance",
        timeoutMs: 250,
        pollIntervalMs: 25,
        staleMs: 10 * 60_000,
        sleep: nativeSleep,
        ...unverifiableOwner,
      });
      await expect(attempt).rejects.toThrow(stateLockPath);
    } finally {
      await holder?.release();
    }
  });

  it("names the config lock file when its recorded owner cannot be verified", async () => {
    const { env, lockDir, configLockPath, configPath, stateDir } = await makeCase();
    await fs.mkdir(lockDir, { recursive: true });
    // A Gateway that exited without releasing leaves this payload behind. Its
    // PID is live, but the reader cannot confirm it, so the lock is never
    // reclaimed. The state lock is left free on purpose: acquireGatewayLock
    // takes it first, so a held state lock would mask this call site.
    await fs.writeFile(
      configLockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath,
        stateDir,
      }),
      "utf8",
    );

    const attempt = acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      role: "sqlite-maintenance",
      timeoutMs: 250,
      pollIntervalMs: 25,
      staleMs: 10 * 60_000,
      sleep: nativeSleep,
      ...unverifiableOwner,
    });
    await expect(attempt).rejects.toThrow(configLockPath);
  });
});
