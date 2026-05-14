// Trigger-collision tests for the playbook matcher (v0.4.6 correctness fix).
//
// Before this fix, two playbooks that registered the same trigger (e.g.
// `jellyfin-service-probe` and `vm_in_guest_diagnostic`, both keyed on
// `metric=service_http_status, type=state_change, severity=critical`)
// would result in only the FIRST playbook firing — the healing engine
// called `playbookEngine.match(anomaly)[0]` and dropped the rest. The
// v0.4.4 release notes promised the two would "fire together"; they did
// not.
//
// After the fix every playbook whose trigger matches fires, each subject
// to its own cooldown_minutes, requires_approval, and max_retries. These
// tests pin that behaviour down.

import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/agent/events.js";
import type { AgentCore, AgentRunResult } from "../../src/agent/core.js";
import { IncidentCoordinator } from "../../src/healing/incident-coordinator.js";
import { HealingEngine, type TickSummary } from "../../src/healing/healing-engine.js";
import { PlaybookEngine, type Playbook } from "../../src/healing/playbooks.js";
import type { RCAAnalyzer } from "../../src/healing/rca-analyzer.js";
import { HealthMonitor } from "../../src/monitoring/health.js";
import type { Anomaly, AnomalyDetector } from "../../src/monitoring/anomaly.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import { AgentEventType } from "../../src/types.js";

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    id: "anomaly-collision-1",
    type: "state_change",
    severity: "critical",
    metric: "service_http_status",
    labels: {
      vmid: "101",
      node: "pve1",
      name: "jellyfin",
      service_name: "jellyfin",
    },
    current_value: 0,
    message: "Jellyfin HTTP probe failing",
    detected_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRunResult(success = true): AgentRunResult {
  return {
    success,
    plan: {
      id: "plan-1",
      goal_id: "goal-1",
      steps: [],
      created_at: new Date().toISOString(),
      status: success ? "completed" : "failed",
      resource_estimate: {
        ram_mb: 0,
        disk_gb: 0,
        cpu_cores: 0,
        vms_created: 0,
        containers_created: 0,
      },
      reasoning: "test",
      revision: 1,
    },
    steps_completed: success ? 1 : 0,
    steps_failed: 0,
    replans: 0,
    duration_ms: 10,
    errors: [],
    outputs: [],
  };
}

function makeSummary(): TickSummary {
  return {
    timestamp: new Date().toISOString(),
    anomaliesDetected: 0,
    healingsStarted: 0,
    healingsCompleted: 0,
    healingsFailed: 0,
    openIncidents: 0,
    activeHeals: 0,
    circuitBreakerPaused: false,
  };
}

interface Ctx {
  dataDir: string;
  eventBus: EventBus;
  playbookEngine: PlaybookEngine;
  incidentCoordinator: IncidentCoordinator;
  runMock: ReturnType<typeof vi.fn>;
  engine: HealingEngine;
}

function makeContext(opts?: { maxConcurrentHeals?: number }): Ctx {
  const dataDir = `/tmp/rhodes-trigger-collision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const eventBus = new EventBus();
  const toolRegistry = {
    execute: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getClusterState: vi.fn().mockResolvedValue(null),
    getAllTools: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistry;
  const healthMonitor = new HealthMonitor(toolRegistry, eventBus);
  const anomalyDetector = { detect: vi.fn().mockReturnValue([]) } as unknown as AnomalyDetector;
  const incidentCoordinator = new IncidentCoordinator(eventBus, dataDir);
  const playbookEngine = new PlaybookEngine(eventBus);
  const runMock = vi.fn().mockResolvedValue(makeRunResult(true));
  const agentCore = {
    run: runMock,
    aiConfig: { provider: "openai", apiKey: "test", model: "gpt-test" },
  } as unknown as AgentCore;
  const rcaAnalyzer = { analyze: vi.fn().mockResolvedValue(undefined) } as unknown as RCAAnalyzer;
  const engine = new HealingEngine(
    eventBus,
    healthMonitor,
    anomalyDetector,
    incidentCoordinator,
    {
      pollIntervalMs: 1000,
      healingEnabled: true,
      maxConcurrentHeals: opts?.maxConcurrentHeals ?? 4,
    },
    { agentCore, playbookEngine, rcaAnalyzer, toolRegistry },
  );

  return { dataDir, eventBus, playbookEngine, incidentCoordinator, runMock, engine };
}

// Two playbooks that share the same trigger — the production collision
// (jellyfin-service-probe + vm_in_guest_diagnostic) mirrored as a test
// fixture. Both key on service_http_status / state_change / critical.
function makeProbePlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "service-probe",
    name: "Service HTTP Probe",
    description: "Restart the in-VM service",
    trigger: {
      metric: "service_http_status",
      type: "state_change",
      severity: "critical",
    },
    actions: [{ type: "custom_goal", params: { goal: "restart" }, description: "Restart" }],
    cooldown_minutes: 5,
    requires_approval: false,
    max_retries: 2,
    ...overrides,
  };
}

function makeDiagnosticPlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "vm-diagnostic",
    name: "In-VM Diagnostic",
    description: "SSH in and run the 9-command sweep",
    trigger: {
      metric: "service_http_status",
      type: "state_change",
      severity: "critical",
    },
    actions: [{ type: "custom_goal", params: { goal: "diagnose" }, description: "Diagnose" }],
    cooldown_minutes: 15,
    requires_approval: false,
    max_retries: 1,
    ...overrides,
  };
}

describe("playbook trigger collision (v0.4.6 correctness fix)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("fires BOTH playbooks when two register the same trigger", async () => {
    const ctx = makeContext();
    tempDirs.push(ctx.dataDir);
    ctx.playbookEngine.register(makeProbePlaybook());
    ctx.playbookEngine.register(makeDiagnosticPlaybook());

    const summary = makeSummary();
    await ctx.engine.handleAnomaly(makeAnomaly(), summary);

    expect(ctx.runMock).toHaveBeenCalledTimes(2);
    const playbookIds = ctx.runMock.mock.calls
      .map((call) => JSON.parse((call[0] as { raw_input: string }).raw_input).playbook_id)
      .sort();
    expect(playbookIds).toEqual(["service-probe", "vm-diagnostic"]);

    expect(summary.healingsStarted).toBe(2);
    expect(summary.healingsCompleted).toBe(2);

    // PlaybookMatched event carries both ids (the matcher already emits
    // an array; this defends against future regression on the matcher
    // side too).
    const matchedEvents = ctx.eventBus
      .getHistory()
      .filter((event) => event.type === AgentEventType.PlaybookMatched);
    expect(matchedEvents).toHaveLength(1);
    const ids = (matchedEvents[0].data as { playbook_ids: string[] }).playbook_ids.slice().sort();
    expect(ids).toEqual(["service-probe", "vm-diagnostic"]);
  });

  it("emits HealingStarted for each playbook on the same anomaly", async () => {
    const ctx = makeContext();
    tempDirs.push(ctx.dataDir);
    ctx.playbookEngine.register(makeProbePlaybook());
    ctx.playbookEngine.register(makeDiagnosticPlaybook());

    await ctx.engine.handleAnomaly(makeAnomaly(), makeSummary());

    const startedEvents = ctx.eventBus
      .getHistory()
      .filter((event) => event.type === AgentEventType.HealingStarted);
    expect(startedEvents).toHaveLength(2);
    const startedPlaybookIds = startedEvents
      .map((event) => (event.data as { playbook_id: string }).playbook_id)
      .sort();
    expect(startedPlaybookIds).toEqual(["service-probe", "vm-diagnostic"]);
  });

  it("respects cooldown independently per playbook — only the non-cooled one fires", async () => {
    // If service-probe was just executed and is on cooldown, the matcher
    // filters it out. vm-diagnostic still fires because its cooldown
    // counter is separate.
    const ctx = makeContext();
    tempDirs.push(ctx.dataDir);
    ctx.playbookEngine.register(makeProbePlaybook({ cooldown_minutes: 60 }));
    ctx.playbookEngine.register(makeDiagnosticPlaybook());

    // Simulate a prior successful run of service-probe.
    ctx.playbookEngine.recordExecution("service-probe", "previous-anomaly", true);

    await ctx.engine.handleAnomaly(makeAnomaly(), makeSummary());

    expect(ctx.runMock).toHaveBeenCalledTimes(1);
    const playbookId = JSON.parse(
      (ctx.runMock.mock.calls[0][0] as { raw_input: string }).raw_input,
    ).playbook_id;
    expect(playbookId).toBe("vm-diagnostic");

    // The cooled-out playbook emits a PlaybookCooldown event so the
    // operator can see why it didn't fire.
    const cooldownEvents = ctx.eventBus
      .getHistory()
      .filter((event) => event.type === AgentEventType.PlaybookCooldown);
    expect(cooldownEvents).toHaveLength(1);
    expect((cooldownEvents[0].data as { playbook_id: string }).playbook_id).toBe("service-probe");
  });

  it("respects requires_approval independently per playbook — auto fires, approval-required escalates", async () => {
    const ctx = makeContext();
    tempDirs.push(ctx.dataDir);
    ctx.playbookEngine.register(makeProbePlaybook({ requires_approval: false }));
    ctx.playbookEngine.register(makeDiagnosticPlaybook({ requires_approval: true }));

    const summary = makeSummary();
    await ctx.engine.handleAnomaly(makeAnomaly(), summary);

    // Only the auto playbook reached the agent.
    expect(ctx.runMock).toHaveBeenCalledTimes(1);
    const ran = JSON.parse(
      (ctx.runMock.mock.calls[0][0] as { raw_input: string }).raw_input,
    ).playbook_id;
    expect(ran).toBe("service-probe");

    expect(summary.healingsStarted).toBe(1);
    expect(summary.healingsCompleted).toBe(1);

    // The approval-required playbook surfaces as a HealingEscalated event
    // with its own playbook_id, so the operator sees it in pending
    // approvals while the auto one already ran.
    const escalations = ctx.eventBus
      .getHistory()
      .filter((event) => event.type === AgentEventType.HealingEscalated)
      .map((event) => (event.data as { playbook_id?: string }).playbook_id);
    expect(escalations).toContain("vm-diagnostic");
    expect(escalations).not.toContain("service-probe");
  });

  it("does NOT double-fire the same playbook id when both suggestPlaybook and match() return it", async () => {
    // suggestPlaybook (learned pattern) can return a playbook id that is
    // also in the trigger-match set. The engine dedupes by id so we don't
    // accidentally run the same playbook twice.
    const ctx = makeContext();
    tempDirs.push(ctx.dataDir);
    ctx.playbookEngine.register(makeProbePlaybook());
    ctx.playbookEngine.register(makeDiagnosticPlaybook());

    // Force suggestPlaybook to return "service-probe" — which is also in
    // the trigger-match set.
    ctx.incidentCoordinator.incidentManager.suggestPlaybook = vi
      .fn()
      .mockReturnValue("service-probe");

    await ctx.engine.handleAnomaly(makeAnomaly(), makeSummary());

    // Both unique playbooks fire — exactly once each.
    expect(ctx.runMock).toHaveBeenCalledTimes(2);
    const ids = ctx.runMock.mock.calls
      .map((call) => JSON.parse((call[0] as { raw_input: string }).raw_input).playbook_id)
      .sort();
    expect(ids).toEqual(["service-probe", "vm-diagnostic"]);
  });
});
