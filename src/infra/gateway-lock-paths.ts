// Owns the lock path vocabulary: which file holds which kind of ownership.
import path from "node:path";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";

/**
 * `ownerLockPath` is the process owner, the file that actually serializes state
 * ownership. `stateLockPath` is its compatibility projection, and `configLockPath`
 * is the historical per-config lock; both are read for supported older runtimes
 * and neither takes ownership in current ones.
 */
export function resolveGatewayLockPaths(env: NodeJS.ProcessEnv, suppliedLockDir?: string) {
  const resolvedStateDir = resolveStateDir(env);
  const stateDir = resolveIdentityPathViaExistingAncestorSync(resolvedStateDir);
  const lockDir = suppliedLockDir ?? resolveGatewayLockDir(stateDir);
  const configPath = resolveConfigPath(env, resolvedStateDir);
  const configHash = sha256HexPrefixCore(configPath, 8);
  return {
    configLockPath: path.join(lockDir, `gateway.${configHash}.lock`),
    configPath,
    stateDir,
    stateLockPath: path.join(lockDir, "gateway.state.lock"),
    ownerLockPath: resolveGatewayStateOwnerPath(path.join(stateDir, "state", "openclaw.sqlite")),
  };
}
