// ============================================================
// RHODES — manifests_as Resolver (separate subsystem)
//
// The resolver infers `manifests_as` edges between provider
// perspectives of the same logical thing. Kept as its own
// subsystem (NOT entangled with ingestion) so:
//   - Stale edges don't accumulate inside adapter code
//   - The resolver has its own state and re-run cadence
//   - We can audit/diff inferred edges separately from direct edges
//
// JupiterOne's separate entity-mapping layer is the precedent.
//
// v0 strategy: explicit rule-based matchers. Match on (a)
// hostname equality (Proxmox VM name == vSphere ESXi hostname),
// (b) IP equality (Proxmox VM's primary IP == vSphere host's
// management IP). Stage 1 is the most common nested-lab case;
// production multi-cloud will need more. ML-based fuzzy matching
// is out of scope for v0.
// ============================================================

import type { GraphStore } from "./store.js";
import type { Resource } from "./types.js";

export interface ResolverMatch {
  fromId: string;
  toId: string;
  rule: string;
  confidence: "high" | "medium" | "low";
  evidence: Record<string, unknown>;
}

export interface ResolverRule {
  id: string;
  /** Return matches found between two candidate resource sets. */
  match: (left: Resource[], right: Resource[]) => ResolverMatch[];
}

/**
 * The canonical nested-lab rule: a Proxmox VM whose name matches a
 * vSphere ESXi host's hostname is the underlying VM for that host.
 *
 * Confidence: 'high' because in a nested setup these are typically
 * identical by convention (esxi-01 VM → esxi-01.local host). Verify
 * with at least one secondary signal (matching IP, MAC, etc.) before
 * promoting to confidence: 'high' in production.
 */
export const PROXMOX_VM_IS_VSPHERE_HOST: ResolverRule = {
  id: "proxmox_vm_is_vsphere_host_by_name",
  match(left, right) {
    const proxmoxVms = left.filter((r) => r.type === "proxmox_vm");
    const vsphereHosts = right.filter((r) => r.type === "vsphere_host");
    const matches: ResolverMatch[] = [];
    for (const vm of proxmoxVms) {
      for (const host of vsphereHosts) {
        if (namesMatch(vm.name, host.name)) {
          matches.push({
            fromId: vm.id,
            toId: host.id,
            rule: "proxmox_vm_is_vsphere_host_by_name",
            // 'medium' until secondary-signal verification lands
            confidence: "medium",
            evidence: { proxmoxName: vm.name, vsphereName: host.name },
          });
        }
      }
    }
    return matches;
  },
};

/**
 * Run the resolver over the current graph contents and upsert
 * `manifests_as` edges for every match. Returns the edges produced.
 *
 * Idempotent: re-running with the same graph state produces the
 * same edges (UNIQUE constraint on (from_id, to_id, type) in the
 * relationships table dedupes).
 */
export function runResolver(
  store: GraphStore,
  rules: ResolverRule[] = [PROXMOX_VM_IS_VSPHERE_HOST],
): { matches: ResolverMatch[]; edgesUpserted: number } {
  const resources = store.listResources();
  let edgesUpserted = 0;
  const allMatches: ResolverMatch[] = [];
  for (const rule of rules) {
    const matches = rule.match(resources, resources);
    for (const m of matches) {
      store.upsertRelationship({
        fromId: m.fromId,
        toId: m.toId,
        type: "manifests_as",
        properties: {
          rule: m.rule,
          confidence: m.confidence,
          evidence: m.evidence,
        },
        origin: "inferred",
      });
      edgesUpserted++;
      allMatches.push(m);
    }
  }
  return { matches: allMatches, edgesUpserted };
}

function namesMatch(a: string, b: string): boolean {
  // Normalize: lowercase, strip common suffixes (.local, .lan), trim whitespace.
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\.(local|lan|home|internal)$/, "")
      .trim();
  return norm(a) === norm(b);
}
