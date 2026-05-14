/**
 * Approval-flow helpers ported from the legacy HUD (template.ts).
 *
 * These mirror the behavior of v0.4.3-v0.4.5 so the new React dashboard
 * has feature parity:
 *  - isSafetySnapshot:    detect rhodes-safety-* pre-remediation snapshots
 *                         so they render with a distinctly non-destructive
 *                         badge + green border.
 *  - tierClass:           normalize tier strings for class-name use.
 *  - readDeepLinkPlanId:  read the ?plan=<id> query param once on load.
 */

import type { PendingApproval } from "../api/client";

const SAFETY_PREFIX = /^rhodes-safety-/i;
const SAFETY_INLINE = /rhodes-safety-/i;
const QM_SNAPSHOT = /(^|\b)qm\s+snapshot\b/i;

export function isSafetySnapshot(entry: PendingApproval | null | undefined): boolean {
  if (!entry) return false;
  if (entry.scope !== "step") return false;

  const action = typeof entry.action === "string" ? entry.action : "";
  if (!QM_SNAPSHOT.test(action)) return false;

  const params = entry.params && typeof entry.params === "object" ? entry.params : {};
  const candidates: unknown[] = [
    (params as Record<string, unknown>).snapname,
    (params as Record<string, unknown>).snap_name,
    (params as Record<string, unknown>).snapshot_name,
    (params as Record<string, unknown>).name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && SAFETY_PREFIX.test(candidate)) return true;
  }
  // Also catch the snap name appearing inline in the action string
  // (e.g. "qm snapshot 200 rhodes-safety-2026-05-13T...").
  if (SAFETY_INLINE.test(action)) return true;
  return false;
}

const VALID_TIERS = new Set(["read", "safe_write", "risky_write", "destructive", "never"]);

export function tierClass(tier: string): string {
  const lower = String(tier ?? "").toLowerCase().replace(/[^a-z_]/g, "");
  return VALID_TIERS.has(lower) ? lower : "read";
}

export const TIER_LABEL: Record<string, string> = {
  read: "READ",
  safe_write: "SAFE WRITE",
  risky_write: "RISKY WRITE",
  destructive: "DESTRUCTIVE",
  never: "FORBIDDEN",
};

export function tierLabel(tier: string): string {
  const cls = tierClass(tier);
  return TIER_LABEL[cls] ?? cls.toUpperCase();
}

/**
 * Read the ?plan=<id> deep-link target from the current location.search.
 * Returns null on SSR or when the parameter is missing/empty.
 */
export function readDeepLinkPlanId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = new URLSearchParams(window.location.search).get("plan");
    return value && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}
