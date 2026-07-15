import { readClawPackageRefs, type PersistedClawPackageRef } from "../claws/provenance.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";

function clawPackageRefMatchesPluginInstall(
  ref: PersistedClawPackageRef,
  pluginId: string,
  record: PluginInstallRecord,
): boolean {
  if (ref.kind !== "plugin" || ref.source !== "clawhub" || record.source !== "clawhub") {
    return false;
  }
  const installedRef =
    record.clawhubPackage ?? record.spec?.replace(/^clawhub:/i, "").replace(/@[^@]+$/, "");
  const installedVersion = record.version ?? record.resolvedVersion;
  return (installedRef ?? pluginId) === ref.ref && installedVersion === ref.version;
}

/** Explain Claw dependents without blocking the operator-owned uninstall. */
export function collectClawPluginUninstallWarnings(params: {
  pluginId: string;
  installRecord?: PluginInstallRecord;
}): string[] {
  const installRecord = params.installRecord;
  if (!installRecord || installRecord.source !== "clawhub") {
    return [];
  }
  const refs = readClawPackageRefs({ kind: "plugin", source: "clawhub" }).filter((ref) =>
    clawPackageRefMatchesPluginInstall(ref, params.pluginId, installRecord),
  );
  const clawIds = [...new Set(refs.map((ref) => ref.clawName))].toSorted();
  if (clawIds.length === 0) {
    return [];
  }
  return [
    `Warning: plugin "${params.pluginId}" is referenced by Claw${clawIds.length === 1 ? "" : "s"}: ${clawIds.join(", ")}.`,
    "Uninstalling it may break those Claws until the plugin is reinstalled or the Claws are updated.",
  ];
}
