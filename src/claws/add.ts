// Applies the narrow agent/workspace creation slice of a consented Claw add plan.
import { mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import {
  persistClawInstallRecord,
  updateClawInstallRecordStatus,
  type PersistedClawInstall,
} from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";

export const CLAW_ADD_RESULT_SCHEMA_VERSION = "openclaw.clawAddResult.v1" as const;

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

export class ClawAddMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawAddMutationError";
  }
}

export type ClawAddResult = {
  schemaVersion: typeof CLAW_ADD_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  status: "complete" | "partial";
  claw: ClawAddPlan["claw"];
  agent: ClawAddPlan["agent"];
  workspaceCreated: boolean;
  configCommitted: boolean;
  installRecord?: PersistedClawInstall;
  error?: { code: string; message: string };
};

function hasUnsupportedMutationActions(plan: ClawAddPlan): boolean {
  return plan.actions.some((action) => !["agent", "workspace"].includes(action.kind));
}

export async function applyClawAddPlan(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    commitConfig?: ConfigCommit;
    persistRecord?: typeof persistClawInstallRecord;
    updateRecord?: typeof updateClawInstallRecordStatus;
    nowMs?: number;
  } = {},
): Promise<ClawAddResult> {
  if (plan.blockers.length > 0) {
    throw new ClawAddMutationError("plan_blocked", "The Claw add plan contains blockers.");
  }
  if (hasUnsupportedMutationActions(plan)) {
    throw new ClawAddMutationError(
      "unsupported_components",
      "This build can only add Claws with agent settings and an empty workspace; declared files, packages, MCP servers, or cron jobs require later lifecycle slices.",
    );
  }

  const persistRecord = options.persistRecord ?? persistClawInstallRecord;
  let installRecord: PersistedClawInstall;
  try {
    installRecord = persistRecord(plan, { ...options, status: "pending" });
  } catch (error) {
    throw new ClawAddMutationError("provenance_failed", (error as Error).message);
  }

  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  await mkdir(dirname(workspace), { recursive: true });
  try {
    await mkdir(workspace);
  } catch (error) {
    throw new ClawAddMutationError(
      "workspace_collision",
      `Could not create new workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
    );
  }

  try {
    const commit: ConfigCommit =
      options.commitConfig ??
      (async (transform) => {
        await transformConfigFileWithRetry({
          afterWrite: { mode: "auto" },
          transform: (config) => ({ nextConfig: transform(config) }),
        });
      });
    await commit((config) => {
      const existingAgents = config.agents?.list ?? [];
      if (listAgentIds(config).includes(plan.agent.finalId)) {
        throw new ClawAddMutationError(
          "agent_id_collision",
          `Agent ${JSON.stringify(plan.agent.finalId)} was created after planning.`,
        );
      }
      if (
        listAgentIds(config).some(
          (agentId) => resolve(resolveAgentWorkspaceDir(config, agentId)) === workspace,
        )
      ) {
        throw new ClawAddMutationError(
          "workspace_collision",
          `Workspace ${JSON.stringify(workspace)} is already assigned to an agent.`,
        );
      }
      const nextConfig: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          list: [...existingAgents, plan.agent.config],
        },
      };
      return nextConfig;
    });
  } catch (error) {
    await rmdir(workspace).catch(() => undefined);
    (options.updateRecord ?? updateClawInstallRecordStatus)(plan.agent.finalId, "partial", options);
    throw error;
  }

  try {
    (options.updateRecord ?? updateClawInstallRecordStatus)(
      plan.agent.finalId,
      "complete",
      options,
    );
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      status: "complete",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated: true,
      configCommitted: true,
      installRecord: {
        ...installRecord,
        status: "complete",
        updatedAtMs: options.nowMs ?? Date.now(),
      },
    };
  } catch (error) {
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      status: "partial",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated: true,
      configCommitted: true,
      error: { code: "provenance_failed", message: (error as Error).message },
    };
  }
}
