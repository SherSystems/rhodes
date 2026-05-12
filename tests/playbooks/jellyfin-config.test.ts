import { describe, it, expect } from "vitest";
import { DEFAULT_PLAYBOOKS } from "../../src/healing/playbooks.js";
import { jellyfinConfigFromEnv } from "../../src/playbooks/service-http-probe.js";

describe("jellyfin DEFAULT_PLAYBOOKS registration", () => {
  it("DEFAULT_PLAYBOOKS contains the jellyfin-service-probe entry", () => {
    const pb = DEFAULT_PLAYBOOKS.find((p) => p.id === "jellyfin-service-probe");
    expect(pb).toBeDefined();
    expect(pb!.name).toMatch(/jellyfin/i);
  });

  it("DEFAULT_PLAYBOOKS count is 8 (was 7 before service-probe addition)", () => {
    expect(DEFAULT_PLAYBOOKS).toHaveLength(8);
  });

  it("jellyfin playbook trigger references the service by label", () => {
    const pb = DEFAULT_PLAYBOOKS.find((p) => p.id === "jellyfin-service-probe");
    expect(pb!.trigger.labels?.service_name).toBe("jellyfin");
    expect(pb!.trigger.metric).toBe("service_http_status");
  });

  it("jellyfin playbook action carries the env-derived service config", () => {
    const pb = DEFAULT_PLAYBOOKS.find((p) => p.id === "jellyfin-service-probe");
    const action = pb!.actions[0];
    const cfg = (action.params as Record<string, unknown>).service_config as {
      service_name: string;
      probe_url: string;
    };
    expect(cfg.service_name).toBe("jellyfin");
    expect(cfg.probe_url).toContain("8096");
  });
});

describe("jellyfinConfigFromEnv", () => {
  it("default probe URL is the Tailscale address of the Jellyfin VM", () => {
    const cfg = jellyfinConfigFromEnv({});
    expect(cfg.probe_url).toBe("http://100.105.89.123:8096/health");
    expect(cfg.ssh_target).toBe("pranav@100.105.89.123");
  });

  it("JELLYFIN_PROBE_URL overrides the default", () => {
    const cfg = jellyfinConfigFromEnv({
      JELLYFIN_PROBE_URL: "http://10.0.0.5:8096/health",
    });
    expect(cfg.probe_url).toBe("http://10.0.0.5:8096/health");
  });

  it("JELLYFIN_SSH_TARGET / interval / timeout / threshold overrides apply", () => {
    const cfg = jellyfinConfigFromEnv({
      JELLYFIN_SSH_TARGET: "ops@jellyfin",
      JELLYFIN_PROBE_INTERVAL_SECS: "90",
      JELLYFIN_PROBE_TIMEOUT_MS: "12345",
      JELLYFIN_FAILURE_THRESHOLD: "5",
    });
    expect(cfg.ssh_target).toBe("ops@jellyfin");
    expect(cfg.probe_interval_secs).toBe(90);
    expect(cfg.probe_timeout_ms).toBe(12345);
    expect(cfg.failure_threshold).toBe(5);
  });

  it("matches body 'Healthy' for the /health endpoint", () => {
    const cfg = jellyfinConfigFromEnv({});
    expect(cfg.healthy_body_match).toBe("Healthy");
  });
});
