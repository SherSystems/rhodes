// ============================================================
// RHODES — Graph Discovery Loop
//
// Per-tick driver invoked by the scheduler. Given a single
// registered writer, runs one discovery pass, captures the
// before/after deltas from the GraphStore so the scheduler can
// surface what was upserted, and produces a DiscoveryReport.
//
// The loop is deliberately small and synchronous-on-the-outside:
// the writer's discover() owns its own concurrency, and the
// scheduler owns the per-writer in-flight guard. This file is the
// thinnest possible wrapper that turns a writer + store into a
// uniform DiscoveryReport regardless of what the writer returned.
// ============================================================

import type { GraphStore } from "./store.js";
import type { DiscoveryReport, DiscoveryWriter } from "./discovery-scheduler.js";

/**
 * Run a single discovery pass for one writer.
 *
 * The store is snapshotted before/after so we can attribute counts
 * to this writer's pass without trusting the writer's bespoke
 * return shape (each provider's `discover()` returns different
 * stats objects). Errors from the writer surface in `report.errors`
 * rather than being thrown — the scheduler's guarantee is that one
 * sick writer never crashes the rest of the loop.
 */
export async function runDiscoveryPass(
  writer: DiscoveryWriter,
  store: GraphStore,
): Promise<DiscoveryReport> {
  const startedAt = new Date().toISOString();

  const resourcesBefore = store.listResources().length;
  const relationshipsBefore = store.listRelationships().length;

  const errors: string[] = [];
  try {
    await writer.discover();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const resourcesAfter = store.listResources().length;
  const relationshipsAfter = store.listRelationships().length;

  const finishedAt = new Date().toISOString();

  return {
    writer: writer.name,
    startedAt,
    finishedAt,
    // Upserts can also touch existing rows; the delta is a lower
    // bound on "things this writer surfaced". Adapters with their
    // own counters can be exposed later via a writer.lastStats hook.
    resourcesUpserted: Math.max(0, resourcesAfter - resourcesBefore),
    relationshipsUpserted: Math.max(0, relationshipsAfter - relationshipsBefore),
    errors,
  };
}
