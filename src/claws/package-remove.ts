import { normalizeClawHubSha256Integrity } from "../infra/clawhub.js";
import { resolveInstalledClawHubPlugin } from "../plugins/plugin-install-preflight.js";
import {
  applyClawHubSkillUninstall,
  planClawHubSkillUninstall,
  type ClawHubSkillUninstallPlan,
} from "../skills/lifecycle/clawhub-uninstall.js";
import {
  acquireClawPackageLifecycleLease,
  maintainClawPackageLifecycleLease,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readClawPackageRefs,
  readClawInstallRecords,
  updateClawPackageRefStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";

type ClawPackageRemovalDecision = {
  packageRef: PersistedClawPackageRef;
  workspace: string;
  action: "uninstall" | "retain";
  reason?: string;
  skillPlan?: ClawHubSkillUninstallPlan;
};

export type ClawPackageRemovalResult = {
  kind: PersistedClawPackageRef["kind"];
  ref: string;
  version: string;
  action: "uninstalled" | "retained" | "error";
  reason?: string;
};

export type PackageRemovalDeps = {
  readPackageRefs?: typeof readClawPackageRefs;
  readInstallRecords?: typeof readClawInstallRecords;
  claimPackageRef?: typeof updateClawPackageRefStatus;
  resolvePlugin?: typeof resolveInstalledClawHubPlugin;
  planSkill?: typeof planClawHubSkillUninstall;
  uninstallSkill?: typeof applyClawHubSkillUninstall;
  acquirePackageLease?: typeof acquireClawPackageLifecycleLease;
};

type ClawPackageState = "present" | "missing" | "modified" | "ambiguous" | "incomplete";
export type ClawPackageInspection = PersistedClawPackageRef & {
  state: ClawPackageState;
  message?: string;
};

function sameArtifact(left: PersistedClawPackageRef, right: PersistedClawPackageRef): boolean {
  return left.kind === right.kind && left.source === right.source && left.ref === right.ref;
}

function sameVersionedArtifact(
  left: PersistedClawPackageRef,
  right: PersistedClawPackageRef,
): boolean {
  return sameArtifact(left, right) && left.version === right.version;
}

function hasAnotherClawOwner(params: {
  packageRef: PersistedClawPackageRef;
  workspace: string;
  refs: PersistedClawPackageRef[];
  installs: PersistedClawInstall[];
  statuses?: ReadonlySet<PersistedClawPackageRef["status"]>;
}): boolean {
  return params.refs.some((candidate) => {
    if (
      candidate.agentId === params.packageRef.agentId ||
      !sameArtifact(candidate, params.packageRef) ||
      (params.statuses && !params.statuses.has(candidate.status))
    ) {
      return false;
    }
    if (params.packageRef.kind === "plugin") {
      return true;
    }
    return params.installs.some(
      (install) => install.agentId === candidate.agentId && install.workspace === params.workspace,
    );
  });
}

function ownerInstallIsNewer(
  installedAt: string | number | undefined,
  packageRef: PersistedClawPackageRef,
): boolean {
  const timestamp = typeof installedAt === "number" ? installedAt : Date.parse(installedAt ?? "");
  return Number.isFinite(timestamp) && timestamp > packageRef.updatedAtMs;
}

function pluginIntegrityMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const normalizedActual = normalizeClawHubSha256Integrity(actual);
  const normalizedExpected = normalizeClawHubSha256Integrity(expected);
  return normalizedActual && normalizedExpected
    ? normalizedActual === normalizedExpected
    : actual === expected;
}

export async function inspectClawPackage(
  install: PersistedClawInstall,
  packageRef: PersistedClawPackageRef,
  deps: PackageRemovalDeps = {},
): Promise<ClawPackageInspection> {
  if (packageRef.status !== "complete") {
    return { ...packageRef, state: "incomplete", message: "Package installation is incomplete." };
  }
  if (packageRef.kind === "plugin") {
    const resolution = await (deps.resolvePlugin ?? resolveInstalledClawHubPlugin)({
      clawhubPackage: packageRef.ref,
    });
    if (resolution.status !== "found") {
      return {
        ...packageRef,
        state: resolution.status,
        message:
          resolution.status === "ambiguous"
            ? "Installed plugin identity is ambiguous."
            : "Installed plugin is missing.",
      };
    }
    if (
      resolution.installedVersion !== packageRef.version ||
      !pluginIntegrityMatches(resolution.record.integrity, packageRef.integrity)
    ) {
      return {
        ...packageRef,
        state: "modified",
        message: "Installed plugin version changed after the Claw was added.",
      };
    }
    return {
      ...packageRef,
      ownership: ownerInstallIsNewer(resolution.record.installedAt, packageRef)
        ? "independently-owned"
        : packageRef.ownership,
      state: "present",
    };
  }
  if (!install.workspace) {
    return {
      ...packageRef,
      state: "ambiguous",
      message: "Skill workspace provenance is missing.",
    };
  }
  const skill = await (deps.planSkill ?? planClawHubSkillUninstall)({
    workspaceDir: install.workspace,
    slug: packageRef.ref,
    expectedVersion: packageRef.version,
  });
  return skill.ok
    ? {
        ...packageRef,
        ownership: ownerInstallIsNewer(skill.plan.installedAt, packageRef)
          ? "independently-owned"
          : packageRef.ownership,
        state: "present",
      }
    : { ...packageRef, state: skill.code, message: skill.error };
}

export async function planClawPackageRemovals(
  install: PersistedClawInstall,
  packages: PersistedClawPackageRef[],
  options: OpenClawStateDatabaseOptions & { deps?: PackageRemovalDeps } = {},
): Promise<ClawPackageRemovalDecision[]> {
  const deps = options.deps ?? {};
  const allRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
  const allInstalls = (deps.readInstallRecords ?? readClawInstallRecords)(options);
  const decisions: ClawPackageRemovalDecision[] = [];
  for (const packageRef of packages) {
    const retain = (reason: string): void => {
      decisions.push({ packageRef, workspace: install.workspace, action: "retain", reason });
    };
    if (packageRef.status !== "complete") {
      retain("Package installation is incomplete.");
      continue;
    }
    if (packageRef.kind === "plugin") {
      retain("Plugins are global; removing a Claw releases its reference without uninstalling it.");
      continue;
    }
    if (!install.workspace) {
      retain("Skill workspace provenance is missing.");
      continue;
    }
    if (packageRef.ownership !== "claw-installed") {
      retain("Package is independently owned outside this Claw.");
      continue;
    }
    if (
      hasAnotherClawOwner({
        packageRef,
        workspace: install.workspace,
        refs: allRefs,
        installs: allInstalls,
      })
    ) {
      retain("Another Claw still references this package.");
      continue;
    }
    const skill = await (deps.planSkill ?? planClawHubSkillUninstall)({
      workspaceDir: install.workspace,
      slug: packageRef.ref,
      expectedVersion: packageRef.version,
    });
    if (!skill.ok) {
      retain(skill.error);
      continue;
    }
    if (ownerInstallIsNewer(skill.plan.installedAt, packageRef)) {
      retain("Package is independently owned outside this Claw.");
      continue;
    }
    decisions.push({
      packageRef,
      workspace: install.workspace,
      action: "uninstall",
      skillPlan: skill.plan,
    });
  }
  return decisions;
}

export async function applyClawPackageRemovals(
  decisions: ClawPackageRemovalDecision[],
  options: OpenClawStateDatabaseOptions & { deps?: PackageRemovalDeps } = {},
): Promise<ClawPackageRemovalResult[]> {
  const deps = options.deps ?? {};
  const results: ClawPackageRemovalResult[] = [];
  for (const decision of decisions) {
    const base = {
      kind: decision.packageRef.kind,
      ref: decision.packageRef.ref,
      version: decision.packageRef.version,
    };
    let packageLease: MaintainedClawPackageLifecycleLease | null = null;
    let claimed = false;
    try {
      const leaseArtifact =
        decision.packageRef.kind === "skill"
          ? {
              kind: decision.packageRef.kind,
              source: decision.packageRef.source,
              ref: decision.packageRef.ref,
              workspace: decision.workspace,
            }
          : {
              kind: decision.packageRef.kind,
              source: decision.packageRef.source,
              ref: decision.packageRef.ref,
            };
      const acquiredLease = (deps.acquirePackageLease ?? acquireClawPackageLifecycleLease)(
        leaseArtifact,
        { env: options.env, path: options.path, required: true },
      );
      if (!acquiredLease) {
        throw new Error(
          `Could not acquire package lifecycle lease for ${decision.packageRef.ref}.`,
        );
      }
      packageLease = maintainClawPackageLifecycleLease(acquiredLease);
      const currentRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
      const currentInstalls = (deps.readInstallRecords ?? readClawInstallRecords)(options);
      const currentRef = currentRefs.find(
        (candidate) =>
          candidate.agentId === decision.packageRef.agentId &&
          sameVersionedArtifact(candidate, decision.packageRef),
      );
      if (decision.action === "retain") {
        const ownershipMatches =
          currentRef?.ownership === decision.packageRef.ownership ||
          (decision.packageRef.ownership === "independently-owned" &&
            currentRef?.ownership === "claw-installed");
        if (!currentRef || currentRef.status !== decision.packageRef.status || !ownershipMatches) {
          throw new Error(
            `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed after removal planning.`,
          );
        }
        if (currentRef.status === "complete") {
          (deps.claimPackageRef ?? updateClawPackageRefStatus)(currentRef, "pending", options);
          claimed = true;
        }
        if (decision.reason === "Another Claw still references this package.") {
          const postClaimRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
          const postClaimInstalls = (deps.readInstallRecords ?? readClawInstallRecords)(options);
          if (
            !hasAnotherClawOwner({
              packageRef: decision.packageRef,
              workspace: decision.workspace,
              refs: postClaimRefs,
              installs: postClaimInstalls,
              statuses: new Set(["complete"]),
            })
          ) {
            throw new Error(
              `Package ${decision.packageRef.ref}@${decision.packageRef.version} no longer has another surviving Claw owner.`,
            );
          }
        }
        results.push({ ...base, action: "retained", reason: decision.reason });
        continue;
      }
      const sharedPackage = hasAnotherClawOwner({
        packageRef: decision.packageRef,
        workspace: decision.workspace,
        refs: currentRefs,
        installs: currentInstalls,
        statuses: new Set(["complete"]),
      });
      if (
        !currentRef ||
        currentRef.status !== "complete" ||
        currentRef.ownership !== "claw-installed" ||
        sharedPackage
      ) {
        throw new Error(
          `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed after removal planning.`,
        );
      }
      (deps.claimPackageRef ?? updateClawPackageRefStatus)(currentRef, "pending", options);
      claimed = true;
      const postClaimRefs = (deps.readPackageRefs ?? readClawPackageRefs)(options);
      const postClaimInstalls = (deps.readInstallRecords ?? readClawInstallRecords)(options);
      const postClaimRef = postClaimRefs.find(
        (candidate) =>
          candidate.agentId === decision.packageRef.agentId &&
          sameVersionedArtifact(candidate, decision.packageRef),
      );
      const postClaimShared = hasAnotherClawOwner({
        packageRef: decision.packageRef,
        workspace: decision.workspace,
        refs: postClaimRefs,
        installs: postClaimInstalls,
        statuses: new Set(["complete"]),
      });
      if (
        !postClaimRef ||
        postClaimRef.status !== "pending" ||
        postClaimRef.ownership !== "claw-installed" ||
        postClaimShared
      ) {
        throw new Error(
          `Package ${decision.packageRef.ref}@${decision.packageRef.version} ownership changed while claiming removal.`,
        );
      }
      if (decision.packageRef.kind !== "skill" || !decision.skillPlan) {
        throw new Error("Global plugins cannot be uninstalled by Claw removal.");
      }
      const removed = await (deps.uninstallSkill ?? applyClawHubSkillUninstall)(decision.skillPlan);
      packageLease.assertCurrent();
      if (!removed.ok) {
        throw new Error(removed.error);
      }
      (deps.claimPackageRef ?? updateClawPackageRefStatus)(
        decision.packageRef,
        "complete",
        options,
      );
      results.push({ ...base, action: "uninstalled" });
    } catch (error) {
      if (claimed) {
        try {
          (deps.claimPackageRef ?? updateClawPackageRefStatus)(
            decision.packageRef,
            "complete",
            options,
          );
        } catch {
          // Preserve the original cleanup failure as the actionable result.
        }
      }
      results.push({
        ...base,
        action: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      try {
        packageLease?.release();
      } catch {
        // Lease expiry recovers cleanup when the shared state database is unavailable.
      }
    }
  }
  return results;
}
