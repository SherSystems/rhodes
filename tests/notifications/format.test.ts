// ============================================================
// RHODES — Notifications: format helper unit tests
// Focuses on the approval-pending message body so the v0.4.5
// Telegram deep-link contract stays locked: when a dashboard URL
// is configured the alert MUST contain `?plan=<plan_id>`; when
// it isn't, the link line MUST be omitted entirely (so installs
// without RHODES_DASHBOARD_URL don't ship a half-broken URL).
// ============================================================

import { describe, it, expect } from "vitest";
import {
  buildPlanDeepLink,
  formatApprovalNeeded,
} from "../../src/notifications/format.js";

describe("buildPlanDeepLink", () => {
  it("appends ?plan=<id> to the base URL", () => {
    expect(buildPlanDeepLink("http://100.73.129.96:7412", "plan_abc")).toBe(
      "http://100.73.129.96:7412/?plan=plan_abc",
    );
  });

  it("normalises a trailing slash on the base URL", () => {
    expect(buildPlanDeepLink("http://rhodes.local:7412/", "plan_abc")).toBe(
      "http://rhodes.local:7412/?plan=plan_abc",
    );
  });

  it("URL-encodes the plan id", () => {
    expect(buildPlanDeepLink("http://rhodes.local", "plan id with spaces")).toBe(
      "http://rhodes.local/?plan=plan%20id%20with%20spaces",
    );
  });
});

describe("formatApprovalNeeded", () => {
  it("includes a ?plan=<id> deep link when dashboardUrl is set", () => {
    const alert = formatApprovalNeeded({
      planId: "plan_01HXYZ",
      action: "qm delsnapshot 200 autosnap_2026-04-18",
      tier: "risky_write",
      dashboardUrl: "http://100.73.129.96:7412",
    });
    expect(alert.kind).toBe("approval_needed");
    expect(alert.body).toContain("Approve at: http://100.73.129.96:7412/?plan=plan_01HXYZ");
    expect(alert.link).toBe("http://100.73.129.96:7412/?plan=plan_01HXYZ");
  });

  it("omits the deep-link line entirely when dashboardUrl is empty", () => {
    const alert = formatApprovalNeeded({
      planId: "plan_01HXYZ",
      action: "qm delsnapshot 200 autosnap_2026-04-18",
      tier: "risky_write",
    });
    expect(alert.body).not.toContain("Approve at:");
    expect(alert.body).not.toContain("?plan=");
    // Falls back to the bare "Plan: <id>" line so the operator still
    // has a referent in Telegram even on misconfigured installs.
    expect(alert.body).toContain("Plan: plan_01HXYZ");
    expect(alert.link).toBeUndefined();
  });

  it("never points at the legacy /plans/<id> path", () => {
    // Regression guard: v0.4.4 and earlier built /plans/<id> deep links
    // which never resolved on the dashboard. The deep-link contract is
    // now exclusively `?plan=<id>` against the dashboard root.
    const alert = formatApprovalNeeded({
      planId: "plan_01HXYZ",
      action: "qm delsnapshot",
      tier: "risky_write",
      dashboardUrl: "http://rhodes.local:7412",
    });
    expect(alert.body).not.toMatch(/\/plans\//);
    expect(alert.link).not.toMatch(/\/plans\//);
  });

  it("preserves action, tier, and optional description in the body", () => {
    const alert = formatApprovalNeeded({
      planId: "plan_01HXYZ",
      action: "qm delsnapshot",
      tier: "risky_write",
      description: "free 4.2GB on ssd-zfs",
      dashboardUrl: "http://rhodes.local:7412",
    });
    expect(alert.body).toContain("approval needed");
    expect(alert.body).toContain("qm delsnapshot");
    expect(alert.body).toContain("risky_write");
    expect(alert.body).toContain("free 4.2GB on ssd-zfs");
  });
});
