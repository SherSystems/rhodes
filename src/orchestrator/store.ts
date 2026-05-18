// ============================================================
// RHODES — Orchestrator Store (upgrade plans + runs)
//
// SQLite-backed persistence for UpgradePlans and UpgradeRuns.
// Matches the better-sqlite3 + WAL + idempotent-DDL pattern used
// across the codebase.
//
// Designed to survive process crashes: a runner that crashes
// mid-upgrade can re-open the store, find runs whose phase isn't
// terminal, and resume from where they left off (the runner reads
// the run's current phase + host index + per-host state and
// continues calling primitives from there).
// ============================================================

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { getDataDir } from "../config.js";
import { ORCHESTRATOR_SCHEMA_SQL } from "./schema.js";
import { TERMINAL_PHASES } from "./types.js";
import type {
  HostUpgradeProgress,
  UpgradePhase,
  UpgradePlan,
  UpgradeRun,
} from "./types.js";

interface PlanRow {
  id: string;
  cluster_resource_id: string;
  target_version: string;
  source_version: string;
  host_resource_ids: string;
  evacuation_mode: string;
  created_at: string;
  created_by: string;
  approved_at: string | null;
  approved_by: string | null;
}

interface RunRow {
  id: string;
  plan_id: string;
  phase: string;
  current_host_index: number;
  hosts: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export interface CreatePlanInput {
  clusterResourceId: string;
  targetVersion: string;
  sourceVersion: string;
  hostResourceIds: string[];
  evacuationMode: "live_migrate" | "evict" | "replace";
  createdBy: string;
}

export class OrchestratorStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    const path = dbPath ?? join(dataDir, "orchestrator.db");
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(ORCHESTRATOR_SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // ── Plan CRUD ────────────────────────────────────────────

  createPlan(input: CreatePlanInput): UpgradePlan {
    const plan: UpgradePlan = {
      id: randomUUID(),
      clusterResourceId: input.clusterResourceId,
      targetVersion: input.targetVersion,
      sourceVersion: input.sourceVersion,
      hostResourceIds: input.hostResourceIds,
      evacuationMode: input.evacuationMode,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };
    this.db
      .prepare(
        `INSERT INTO upgrade_plans
         (id, cluster_resource_id, target_version, source_version,
          host_resource_ids, evacuation_mode, created_at, created_by)
         VALUES (@id, @cluster, @target, @source, @hosts, @mode, @createdAt, @createdBy)`,
      )
      .run({
        id: plan.id,
        cluster: plan.clusterResourceId,
        target: plan.targetVersion,
        source: plan.sourceVersion,
        hosts: JSON.stringify(plan.hostResourceIds),
        mode: plan.evacuationMode,
        createdAt: plan.createdAt,
        createdBy: plan.createdBy,
      });
    return plan;
  }

  getPlan(id: string): UpgradePlan | null {
    const row = this.db
      .prepare("SELECT * FROM upgrade_plans WHERE id = ?")
      .get(id) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  listPlansForCluster(clusterResourceId: string): UpgradePlan[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM upgrade_plans WHERE cluster_resource_id = ? ORDER BY created_at DESC",
      )
      .all(clusterResourceId) as PlanRow[];
    return rows.map(rowToPlan);
  }

  /** All plans, newest first. Used by the dashboard list endpoint. */
  listAllPlans(): UpgradePlan[] {
    const rows = this.db
      .prepare("SELECT * FROM upgrade_plans ORDER BY created_at DESC")
      .all() as PlanRow[];
    return rows.map(rowToPlan);
  }

  recordApproval(planId: string, approvedBy: string): UpgradePlan {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE upgrade_plans SET approved_at = ?, approved_by = ? WHERE id = ?",
      )
      .run(at, approvedBy, planId);
    const updated = this.getPlan(planId);
    if (!updated) {
      throw new Error(`recordApproval: plan ${planId} not found after update`);
    }
    return updated;
  }

  // ── Run CRUD ─────────────────────────────────────────────

  createRun(planId: string): UpgradeRun {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error(`createRun: plan ${planId} not found`);
    const run: UpgradeRun = {
      id: randomUUID(),
      planId,
      phase: "pending",
      currentHostIndex: -1,
      hosts: plan.hostResourceIds.map((hostResourceId) => ({
        hostResourceId,
        state: "pending",
      })),
    };
    this.persistRun(run);
    return run;
  }

  getRun(id: string): UpgradeRun | null {
    const row = this.db
      .prepare("SELECT * FROM upgrade_runs WHERE id = ?")
      .get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRunsForPlan(planId: string): UpgradeRun[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM upgrade_runs WHERE plan_id = ? ORDER BY id DESC",
      )
      .all(planId) as RunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Active runs — non-terminal phases. Used by the runner on boot
   * to find runs to resume.
   */
  listActiveRuns(): UpgradeRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM upgrade_runs WHERE phase NOT IN ('completed', 'failed', 'aborted')
         ORDER BY started_at`,
      )
      .all() as RunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Persist a run snapshot — overwrites existing row. Called by the
   * runner after every FSM transition. Idempotent.
   */
  persistRun(run: UpgradeRun): void {
    this.db
      .prepare(
        `INSERT INTO upgrade_runs
         (id, plan_id, phase, current_host_index, hosts,
          started_at, completed_at, error_message)
         VALUES (@id, @planId, @phase, @hostIdx, @hosts, @startedAt, @completedAt, @err)
         ON CONFLICT(id) DO UPDATE SET
           phase              = excluded.phase,
           current_host_index = excluded.current_host_index,
           hosts              = excluded.hosts,
           started_at         = excluded.started_at,
           completed_at       = excluded.completed_at,
           error_message      = excluded.error_message`,
      )
      .run({
        id: run.id,
        planId: run.planId,
        phase: run.phase,
        hostIdx: run.currentHostIndex,
        hosts: JSON.stringify(run.hosts),
        startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null,
        err: run.errorMessage ?? null,
      });
  }

  /** For tests / observability. */
  listAllRuns(): UpgradeRun[] {
    const rows = this.db
      .prepare("SELECT * FROM upgrade_runs")
      .all() as RunRow[];
    return rows.map(rowToRun);
  }
}

// ── Row → object marshalers ────────────────────────────────

function rowToPlan(row: PlanRow): UpgradePlan {
  return {
    id: row.id,
    clusterResourceId: row.cluster_resource_id,
    targetVersion: row.target_version,
    sourceVersion: row.source_version,
    hostResourceIds: JSON.parse(row.host_resource_ids),
    evacuationMode: row.evacuation_mode as
      | "live_migrate"
      | "evict"
      | "replace",
    createdAt: row.created_at,
    createdBy: row.created_by,
    approvedAt: row.approved_at ?? undefined,
    approvedBy: row.approved_by ?? undefined,
  };
}

function rowToRun(row: RunRow): UpgradeRun {
  return {
    id: row.id,
    planId: row.plan_id,
    phase: row.phase as UpgradePhase,
    currentHostIndex: row.current_host_index,
    hosts: JSON.parse(row.hosts) as HostUpgradeProgress[],
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
  };
}

// Re-export for callers
export { TERMINAL_PHASES };
