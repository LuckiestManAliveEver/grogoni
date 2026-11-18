import type { SystemShopProvisionReport } from "./store.js";

/** `GROGONI_SYSTEM_SHOP=off` disables Jane's Shop provisioning for a deployment. On by default. */
export function systemShopProvisioningEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (env.GROGONI_SYSTEM_SHOP ?? "").trim().toLowerCase() !== "off";
}

/** One structured log line per provisioning that changed something or was blocked. */
export function logSystemShopProvision(report: SystemShopProvisionReport, runtime: string): void {
  if (report.status === "unchanged") return;
  const line = JSON.stringify({ event: "system_shop.provision", runtime, ...report });
  if (report.status === "blocked") console.error(line);
  else console.info(line);
}
