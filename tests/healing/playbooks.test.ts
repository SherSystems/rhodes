import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PlaybookEngine,
  DEFAULT_PLAYBOOKS,
  type Playbook,
  type Anomaly,
} from "../../src/healing/playbooks.js";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";

// ── Helpers ────────────────────────────────────────────────

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    id: "anomaly-001",
    type: "threshold",
    severity: "critical",
    metric: "node_memory_pct",
    labels: { node: "pve1" },
    current_value: 95,
    message: "Node memory at 95%",
    detected_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "test_playbook",
    name: "Test Playbook",
    description: "A test playbook",
    trigger: {
      metric: "node_memory_pct",
      type: "threshold",
      severity: "critical",
    },
    actions: [
      {
        type: "restart_vm",
        params: {},
        description: "Test action",
      },
    ],
    cooldown_minutes: 15,
    requires_approval: false,
    max_retries: 2,
    ...overrides,
  };
}

// ── DEFAULT_PLAYBOOKS ──────────────────────────────────────

describe("DEFAULT_PLAYBOOKS", () => {
  it("has 8 default playbooks", () => {
    expect(DEFAULT_PLAYBOOKS).toHaveLength(8);
  });

  it("each playbook has all required fields", () => {
    const requiredFields: (keyof Playbook)[] = [
      "id",
      "name",
      "description",
      "trigger",
      "actions",
      "cooldown_minutes",
      "requires_approval",
      "max_retries",
    ];

    for (const playbook of DEFAULT_PLAYBOOKS) {
      for (const field of requiredFields) {
        expect(playbook).toHaveProperty(field);
      }
    }
  });

  it('"vm_unresponsive" triggers on vm_status flatline critical', () => {
    const pb = DEFAULT_PLAYBOOKS.find((p) => p.id === "vm_unresponsive");
    expect(pb).toBeDefined();
    expect(pb!.trigger).toEqual({
      metric: "vm_status",
      type: "flatline",
      severity: "critical",
    });
  });

  it('"vm_crashed" triggers on vm_status threshold critical', () => {
    const pb = DEFAULT_PLAYBOOKS.find((p) => p.id === "vm_crashed");
    expect(pb).toBeDefined();
    expect(pb!.trigger).toEqual({
      metric: "vm_status",
      type: "threshold",
      severity: "critical",
    });
  });

  it('"node_memory_critical" triggers on node_memory_pct threshold critical', () => {
    const pb = DEFAULT_PLAYBOOKS.find((p) => p.id === "node_memory_critical");
    expect(pb).toBeDefined();
    expect(pb!.trigger).toEqual({
      metric: "node_memory_pct",
      type: "threshold",
      severity: "critical",
    });
  });

  it('"disk_space_critical" requires approval', () => {
    const pb = DEFAULT_PLAYBOOKS.find((p) => p.id === "disk_space_critical");
    expect(pb).toBeDefined();
    expect(pb!.requires_approval).toBe(true);
  });

  it('"predictive_disk_full" triggers on disk_usage_pct trend warning', () => {
    const pb = DEFAULT_PLAYBOOKS.find((p) => p.id === "predictive_disk_full");
    expect(pb).toBeDefined();
    expect(pb!.trigger).toEqual({
      metric: "disk_usage_pct",
      type: "trend",
      severity: "warning",
    });
  });
});

// ── PlaybookEngine ─────────────────────────────────────────

describe("PlaybookEngine", () => {
  let bus: EventBus;
  let engine: PlaybookEngine;

  beforeEach(() => {
    bus = new EventBus();
    engine = new PlaybookEngine(bus);
  });

  // ── register / unregister / get / getAll ──────────────────

  describe("register / unregister / get / getAll", () => {
    it("register() adds a playbook and get() retrieves it", () => {
      const pb = makePlaybook();
      engine.register(pb);
      expect(engine.get("test_playbook")).toBe(pb);
    });

    it("unregister() removes the playbook", () => {
      const pb = makePlaybook();
      engine.register(pb);
      engine.unregister("test_playbook");
      expect(engine.get("test_playbook")).toBeUndefined();
    });

    it("getAll() returns all registered playbooks", () => {
      const pb1 = makePlaybook({ id: "pb1" });
      const pb2 = makePlaybook({ id: "pb2" });
      engine.register(pb1);
      engine.register(pb2);

      const all = engine.getAll();
      expect(all).toHaveLength(2);
      expect(all.map((p) => p.id).sort()).toEqual(["pb1", "pb2"]);
    });
  });

  // ── match() ───────────────────────────────────────────────

  describe("match()", () => {
    it("returns matching playbook when metric and type match", () => {
      engine.register(makePlaybook());
      const anomaly = makeAnomaly();
      const matched = engine.match(anomaly);
      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe("test_playbook");
    });

    it("returns empty when no match", () => {
      engine.register(makePlaybook());
      const anomaly = makeAnomaly({ metric: "unrelated_metric" });
      const matched = engine.match(anomaly);
      expect(matched).toHaveLength(0);
    });

    it("respects severity filter in trigger", () => {
      engine.register(makePlaybook());
      // Playbook trigger requires severity: "critical", anomaly is "warning"
      const anomaly = makeAnomaly({ severity: "warning" });
      const matched = engine.match(anomaly);
      expect(matched).toHaveLength(0);
    });

    it("respects labels filter in trigger", () => {
      engine.register(
        makePlaybook({
          id: "label_filter_pb",
          trigger: {
            metric: "node_memory_pct",
            type: "threshold",
            severity: "critical",
            labels: { node: "pve2" },
          },
        }),
      );

      // Anomaly has node: "pve1", trigger requires node: "pve2"
      const anomaly = makeAnomaly({ labels: { node: "pve1" } });
      const matched = engine.match(anomaly);
      expect(matched).toHaveLength(0);

      // Now with matching label
      const anomaly2 = makeAnomaly({ labels: { node: "pve2" } });
      const matched2 = engine.match(anomaly2);
      expect(matched2).toHaveLength(1);
    });

    it('emits "playbook_matched" event when match found', () => {
      engine.register(makePlaybook());
      const events: unknown[] = [];
      bus.on(AgentEventType.PlaybookMatched, (e) => events.push(e));

      engine.match(makeAnomaly());

      expect(events).toHaveLength(1);
      expect((events[0] as any).data.playbook_ids).toContain("test_playbook");
    });

    it("does not match playbook on cooldown", () => {
      engine.register(makePlaybook({ cooldown_minutes: 60 }));
      engine.recordExecution("test_playbook", "anomaly-001", true);

      const matched = engine.match(makeAnomaly());
      expect(matched).toHaveLength(0);
    });

    it('emits "playbook_cooldown" event when on cooldown', () => {
      engine.register(makePlaybook({ cooldown_minutes: 60 }));
      engine.recordExecution("test_playbook", "anomaly-001", true);

      const events: unknown[] = [];
      bus.on(AgentEventType.PlaybookCooldown, (e) => events.push(e));

      engine.match(makeAnomaly());

      expect(events).toHaveLength(1);
      expect((events[0] as any).data.playbook_id).toBe("test_playbook");
    });
  });

  // ── toGoal() ──────────────────────────────────────────────

  describe("toGoal()", () => {
    it('returns a Goal with mode "watch" for non-approval playbooks', () => {
      const pb = makePlaybook({ requires_approval: false });
      const anomaly = makeAnomaly();
      const goal = engine.toGoal(pb, anomaly);
      expect(goal.mode).toBe("watch");
    });

    it('returns a Goal with mode "build" for approval-required playbooks', () => {
      const pb = makePlaybook({ requires_approval: true });
      const anomaly = makeAnomaly();
      const goal = engine.toGoal(pb, anomaly);
      expect(goal.mode).toBe("build");
    });

    it("Goal description is built based on playbook ID and anomaly labels", () => {
      const pb = makePlaybook({
        id: "node_memory_critical",
        requires_approval: false,
      });
      const anomaly = makeAnomaly({
        labels: { node: "pve1" },
        current_value: 95,
      });
      const goal = engine.toGoal(pb, anomaly);
      expect(goal.description).toContain("pve1");
      expect(goal.description).toContain("95");
    });

    it("Goal raw_input contains playbook_id and anomaly_id", () => {
      const pb = makePlaybook();
      const anomaly = makeAnomaly({ id: "anom-xyz" });
      const goal = engine.toGoal(pb, anomaly);
      const parsed = JSON.parse(goal.raw_input);
      expect(parsed.playbook_id).toBe("test_playbook");
      expect(parsed.anomaly_id).toBe("anom-xyz");
    });
  });

  // ── recordExecution / isOnCooldown / getExecutionHistory ──

  describe("recordExecution / isOnCooldown / getExecutionHistory", () => {
    it("recordExecution() stores execution and emits event", () => {
      engine.register(makePlaybook());
      const events: unknown[] = [];
      bus.on(AgentEventType.PlaybookExecuted, (e) => events.push(e));

      engine.recordExecution("test_playbook", "anomaly-001", true);

      const history = engine.getExecutionHistory();
      expect(history).toHaveLength(1);
      expect(history[0].playbook_id).toBe("test_playbook");
      expect(history[0].success).toBe(true);

      expect(events).toHaveLength(1);
    });

    it("isOnCooldown() returns true within cooldown period", () => {
      engine.register(makePlaybook({ cooldown_minutes: 60 }));
      engine.recordExecution("test_playbook", "anomaly-001", true);
      expect(engine.isOnCooldown("test_playbook")).toBe(true);
    });

    it("isOnCooldown() returns false after cooldown expires", () => {
      vi.useFakeTimers();
      try {
        engine.register(makePlaybook({ cooldown_minutes: 15 }));
        engine.recordExecution("test_playbook", "anomaly-001", true);

        expect(engine.isOnCooldown("test_playbook")).toBe(true);

        // Advance past the 15-minute cooldown
        vi.advanceTimersByTime(16 * 60 * 1000);

        expect(engine.isOnCooldown("test_playbook")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("isOnCooldown() returns false for unknown playbook", () => {
      expect(engine.isOnCooldown("nonexistent")).toBe(false);
    });

    it("getExecutionHistory() returns all executions", () => {
      engine.register(makePlaybook());
      engine.register(makePlaybook({ id: "other_pb" }));
      engine.recordExecution("test_playbook", "a1", true);
      engine.recordExecution("other_pb", "a2", false);

      expect(engine.getExecutionHistory()).toHaveLength(2);
    });

    it("getExecutionHistory(playbookId) filters by playbook", () => {
      engine.register(makePlaybook());
      engine.register(makePlaybook({ id: "other_pb" }));
      engine.recordExecution("test_playbook", "a1", true);
      engine.recordExecution("other_pb", "a2", false);
      engine.recordExecution("test_playbook", "a3", true);

      const filtered = engine.getExecutionHistory("test_playbook");
      expect(filtered).toHaveLength(2);
      expect(filtered.every((e) => e.playbook_id === "test_playbook")).toBe(
        true,
      );
    });
  });
});
