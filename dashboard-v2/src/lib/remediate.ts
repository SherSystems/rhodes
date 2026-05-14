/**
 * Build a templated agent prompt from an incident.
 *
 * Ported from src/frontends/dashboard/template.ts buildRemediatePrompt —
 * keep the wording in lockstep so the legacy HUD and the React dashboard
 * produce identical agent commands for the same incident.
 */

import type { Incident } from "../types";

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

export function buildRemediatePrompt(incident: Incident | null | undefined): string {
  if (!incident) return "";
  const labels = (incident.labels ?? {}) as Record<string, unknown>;
  const metric = incident.metric ?? incident.metric_name ?? "";
  const name = asString(labels.name ?? labels.vmid ?? "");
  const vmid = labels.vmid !== undefined ? asString(labels.vmid) : "";
  const node = asString(labels.node) || "unknown node";

  if (metric === "vm_status" && labels.reason === "paused_io_error") {
    return (
      "Investigate VM " + name + " (vmid " + vmid + ") on " + node +
      " — currently in paused (io-error). Run the proxmox-storage-pause" +
      " playbook to diagnose snapshot bloat, propose a remediation plan," +
      " and wait for approval before executing."
    );
  }
  if (metric === "vm_status") {
    return (
      "Investigate VM " + name + " on " + node + " — anomaly: " +
      asString(labels.reason || metric) +
      ". Propose a remediation plan and wait for approval."
    );
  }
  if (metric === "service_http_status") {
    const service = asString(labels.service_name) || "(unnamed)";
    return (
      "Investigate service " + service +
      " — HTTP probe failing. Run the in-VM diagnostic playbook against the" +
      " target VM. Propose remediation and wait for approval."
    );
  }
  return (
    "Investigate the anomaly: " + (incident.anomaly_type || "unknown") +
    " on " + metric + " with labels " + JSON.stringify(labels) +
    ". Diagnose and propose a remediation plan."
  );
}
