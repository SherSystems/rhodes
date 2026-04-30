import { describe, it, expect } from "vitest";
import {
  validateProbe,
  validateProbes,
  probeDefSchema,
  serviceHealthConfigSchema,
  DEFAULT_PROBES,
  PROBE_KINDS,
} from "../../../src/autopilot/probes/schema.js";

const goodTcpProbe = {
  id: "tcp_test",
  target_host: "example",
  kind: "tcp",
  host: "127.0.0.1",
  port: 22,
};

const goodHttpsProbe = {
  id: "https_test",
  kind: "https",
  url: "https://example.com/health",
};

const goodPingProbe = {
  id: "ping_test",
  kind: "ping",
  host: "1.1.1.1",
};

describe("probeDefSchema", () => {
  it("accepts a well-formed tcp probe", () => {
    const out = validateProbe(goodTcpProbe);
    expect(out.id).toBe("tcp_test");
    expect(out.kind).toBe("tcp");
    expect(out.interval_s).toBe(60); // default
    expect(out.failures_to_alert).toBe(3); // default
    expect(out.cooldown_s).toBe(300); // default
    expect(out.timeout_ms).toBe(5_000); // default
    expect(out.insecure).toBe(true); // default
    expect(out.enabled).toBe(true); // default
  });

  it("accepts a well-formed https probe", () => {
    const out = validateProbe(goodHttpsProbe);
    expect(out.kind).toBe("https");
    expect(out.url).toBe("https://example.com/health");
  });

  it("accepts a well-formed ping probe", () => {
    const out = validateProbe(goodPingProbe);
    expect(out.kind).toBe("ping");
    expect(out.host).toBe("1.1.1.1");
  });

  it("rejects an empty id", () => {
    expect(() => validateProbe({ ...goodTcpProbe, id: "" })).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      validateProbe({ ...goodTcpProbe, kind: "udp" }),
    ).toThrow();
  });

  it("rejects a tcp probe missing host", () => {
    const { host: _omit, ...rest } = goodTcpProbe;
    void _omit;
    expect(() => validateProbe(rest)).toThrow(/host/);
  });

  it("rejects a tcp probe missing port", () => {
    const { port: _omit, ...rest } = goodTcpProbe;
    void _omit;
    expect(() => validateProbe(rest)).toThrow(/port/);
  });

  it("rejects an https probe missing url", () => {
    const { url: _omit, ...rest } = goodHttpsProbe;
    void _omit;
    expect(() => validateProbe(rest)).toThrow(/url/);
  });

  it("rejects an https probe with malformed url", () => {
    expect(() =>
      validateProbe({ ...goodHttpsProbe, url: "not-a-url" }),
    ).toThrow();
  });

  it("rejects a ping probe missing host", () => {
    expect(() =>
      validateProbe({ id: "p", kind: "ping" }),
    ).toThrow(/host/);
  });

  it("rejects negative cooldown", () => {
    expect(() =>
      validateProbe({ ...goodTcpProbe, cooldown_s: -1 }),
    ).toThrow();
  });

  it("rejects zero or negative interval", () => {
    expect(() =>
      validateProbe({ ...goodTcpProbe, interval_s: 0 }),
    ).toThrow();
    expect(() =>
      validateProbe({ ...goodTcpProbe, interval_s: -10 }),
    ).toThrow();
  });

  it("rejects a port outside 1..65535", () => {
    expect(() =>
      validateProbe({ ...goodTcpProbe, port: 0 }),
    ).toThrow();
    expect(() =>
      validateProbe({ ...goodTcpProbe, port: 70000 }),
    ).toThrow();
  });

  it("rejects zero or negative failures_to_alert", () => {
    expect(() =>
      validateProbe({ ...goodTcpProbe, failures_to_alert: 0 }),
    ).toThrow();
  });

  it("accepts overridden interval/cooldown/threshold", () => {
    const out = validateProbe({
      ...goodTcpProbe,
      interval_s: 30,
      failures_to_alert: 5,
      cooldown_s: 1200,
      timeout_ms: 2_000,
      insecure: false,
      enabled: false,
    });
    expect(out.interval_s).toBe(30);
    expect(out.failures_to_alert).toBe(5);
    expect(out.cooldown_s).toBe(1200);
    expect(out.timeout_ms).toBe(2_000);
    expect(out.insecure).toBe(false);
    expect(out.enabled).toBe(false);
  });

  it("accepts target_vm_id as either string or number", () => {
    expect(
      validateProbe({ ...goodTcpProbe, target_vm_id: 201 }).target_vm_id,
    ).toBe(201);
    expect(
      validateProbe({ ...goodTcpProbe, target_vm_id: "i-abc123" }).target_vm_id,
    ).toBe("i-abc123");
  });
});

describe("validateProbes (list)", () => {
  it("partitions valid and invalid entries", () => {
    const result = validateProbes([
      goodTcpProbe,
      { ...goodTcpProbe, id: "" },
      goodHttpsProbe,
    ]);
    expect(result.valid).toHaveLength(2);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.path === "id" && e.index === 1)).toBe(
      true,
    );
  });

  it("preserves probe id on errors", () => {
    const result = validateProbes([
      { id: "broken", kind: "https" /* missing url */ },
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].probeId).toBe("broken");
  });

  it("rejects an https probe with missing url even with valid id/kind", () => {
    const result = validateProbes([{ id: "x", kind: "https" }]);
    expect(result.valid).toHaveLength(0);
    expect(result.errors.some((e) => e.message.includes("url"))).toBe(true);
  });
});

describe("serviceHealthConfigSchema", () => {
  it("defaults to enabled with empty probe list", () => {
    const parsed = serviceHealthConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.probes).toEqual([]);
  });

  it("accepts an explicit probe list", () => {
    const parsed = serviceHealthConfigSchema.parse({
      enabled: true,
      probes: [goodTcpProbe, goodHttpsProbe],
    });
    expect(parsed.probes).toHaveLength(2);
  });

  it("rejects probes with bad shape", () => {
    expect(() =>
      serviceHealthConfigSchema.parse({
        probes: [{ id: "bad", kind: "tcp" }], // missing host/port
      }),
    ).toThrow();
  });
});

describe("DEFAULT_PROBES", () => {
  it("ships at least 2 example probes", () => {
    expect(DEFAULT_PROBES.length).toBeGreaterThanOrEqual(2);
  });

  it("all default probes pass schema validation", () => {
    for (const probe of DEFAULT_PROBES) {
      expect(() => probeDefSchema.parse(probe)).not.toThrow();
    }
  });

  it("includes the ESXi mgmt example probe", () => {
    const esxi = DEFAULT_PROBES.find((p) =>
      p.id.toLowerCase().includes("esxi"),
    );
    expect(esxi).toBeDefined();
    expect(esxi!.kind).toBe("https");
    expect(esxi!.url).toContain("192.168.86.46");
  });

  it("includes the localhost self-probe example", () => {
    const self = DEFAULT_PROBES.find(
      (p) => p.host === "127.0.0.1" || p.target_host === "localhost",
    );
    expect(self).toBeDefined();
  });

  it("ships defaults disabled by default to avoid surprise probing on boot", () => {
    // Operators must opt in; we never probe arbitrary endpoints without
    // someone flipping the flag.
    for (const probe of DEFAULT_PROBES) {
      expect(probe.enabled).toBe(false);
    }
  });
});

describe("PROBE_KINDS", () => {
  it("exposes the expected probe kinds", () => {
    expect(PROBE_KINDS).toEqual(["tcp", "https", "ping"]);
  });
});
