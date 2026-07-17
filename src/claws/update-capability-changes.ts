// Builds field-level capability change summaries for Claw update previews.
import { stableStringify } from "../agents/stable-stringify.js";

export type ClawUpdateCapabilityChange = {
  kind: "agent" | "package" | "mcpServer" | "cronJob";
  id: string;
  path: string;
  action: "add" | "change" | "remove" | "release" | "unchanged" | "manual";
  classification: "escalation" | "reduction" | "neutral";
  requiresDistinctConsent: boolean;
  reason: string;
  current?: unknown;
  desired?: unknown;
};

function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function rankedValue(value: unknown, rank: Record<string, number>): number {
  return typeof value === "string" ? (rank[value] ?? 0) : 0;
}

function isAgentEscalation(path: string, current: unknown, desired: unknown): boolean {
  if (desired === undefined || sameValue(current, desired)) {
    return false;
  }
  if (path === "sandbox.workspaceAccess") {
    const rank = { none: 0, ro: 1, rw: 2 } as Record<string, number>;
    return rankedValue(desired, rank) > rankedValue(current, rank);
  }
  if (path === "sandbox.mode") {
    const rank = { off: 0, "non-main": 1, all: 2 } as Record<string, number>;
    return rankedValue(desired, rank) > rankedValue(current, rank);
  }
  if (path === "tools.deny") {
    return Array.isArray(current) && Array.isArray(desired) && desired.length < current.length;
  }
  return path.startsWith("sandbox.") || path === "tools.allow" || current === undefined;
}

export function pushAgentCapabilityChanges(params: {
  changes: ClawUpdateCapabilityChange[];
  agentId: string;
  currentAgent: unknown;
  desiredAgent: unknown;
}): void {
  const fields = [
    ["sandbox", "mode"],
    ["sandbox", "scope"],
    ["sandbox", "workspaceAccess"],
    ["tools", "allow"],
    ["tools", "deny"],
    ["heartbeat", "every"],
    ["heartbeat", "activeHours"],
    ["heartbeat", "isolatedSession"],
    ["heartbeat", "skipWhenBusy"],
    ["heartbeat", "timeoutSeconds"],
  ] as const;
  for (const field of fields) {
    const current = getPath(params.currentAgent, field);
    const desired = getPath(params.desiredAgent, field);
    if (sameValue(current, desired)) {
      continue;
    }
    const path = field.join(".");
    const escalation = isAgentEscalation(path, current, desired);
    params.changes.push({
      kind: "agent",
      id: params.agentId,
      path: `agent.${path}`,
      action: "change",
      classification: escalation ? "escalation" : desired === undefined ? "reduction" : "neutral",
      requiresDistinctConsent: escalation,
      reason: `Agent capability field ${path} changes in the target manifest.`,
      ...(current === undefined ? {} : { current }),
      ...(desired === undefined ? {} : { desired }),
    });
  }
}

export function packageCapabilityChange(params: {
  pkg: { kind: string; ref: string; version: string };
  action: ClawUpdateCapabilityChange["action"];
  currentVersion?: string;
}): ClawUpdateCapabilityChange | undefined {
  if (params.pkg.kind !== "plugin" || params.action === "unchanged") {
    return undefined;
  }
  const reduction = params.action === "remove" || params.action === "release";
  return {
    kind: "package",
    id: `plugin:${params.pkg.ref}`,
    path: `packages.plugin.${params.pkg.ref}`,
    action: params.action,
    classification: reduction ? "reduction" : "escalation",
    requiresDistinctConsent: !reduction,
    reason: reduction
      ? "Target manifest removes or releases plugin executable code."
      : "Target manifest adds or changes plugin executable code.",
    ...(params.currentVersion ? { current: { version: params.currentVersion } } : {}),
    desired: { version: params.pkg.version },
  };
}

function safeMcpCapability(server: unknown): Record<string, unknown> | undefined {
  if (!server || typeof server !== "object") {
    return undefined;
  }
  const value = server as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["transport", "auth", "toolFilter", "timeout", "connectTimeout"]) {
    if (value[key] !== undefined) {
      result[key] = value[key];
    }
  }
  if (typeof value.command === "string") {
    result.command = value.command;
    result.argsCount = Array.isArray(value.args) ? value.args.length : 0;
  }
  if (typeof value.url === "string") {
    try {
      result.urlOrigin = new URL(value.url).origin;
    } catch {
      result.urlOrigin = "invalid-url";
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function mcpCapabilityChange(params: {
  id: string;
  action: ClawUpdateCapabilityChange["action"];
  current?: unknown;
  desired?: unknown;
}): ClawUpdateCapabilityChange | undefined {
  if (params.action === "unchanged") {
    return undefined;
  }
  const reduction = params.action === "remove" || params.action === "release";
  return {
    kind: "mcpServer",
    id: params.id,
    path: `mcpServers.${params.id}`,
    action: params.action,
    classification: reduction ? "reduction" : "escalation",
    requiresDistinctConsent: !reduction,
    reason: reduction
      ? "Target manifest removes or releases an MCP tool surface."
      : "Target manifest adds, restores, or changes an MCP tool surface.",
    ...(params.current ? { current: safeMcpCapability(params.current) } : {}),
    ...(params.desired ? { desired: safeMcpCapability(params.desired) } : {}),
  };
}

export function cronCapabilityChange(params: {
  id: string;
  action: ClawUpdateCapabilityChange["action"];
  current?: unknown;
  desired?: unknown;
}): ClawUpdateCapabilityChange | undefined {
  if (params.action === "unchanged") {
    return undefined;
  }
  const reduction = params.action === "remove";
  return {
    kind: "cronJob",
    id: params.id,
    path: `cronJobs.${params.id}`,
    action: params.action,
    classification: reduction ? "reduction" : "escalation",
    requiresDistinctConsent: !reduction,
    reason: reduction
      ? "Target manifest removes a scheduled automation."
      : "Target manifest adds, restores, or changes a scheduled automation.",
    ...(params.current ? { current: params.current } : {}),
    ...(params.desired ? { desired: params.desired } : {}),
  };
}
