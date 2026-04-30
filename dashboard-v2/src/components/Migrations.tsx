import { useStore } from "../store";
import { useEffect, useState, useMemo } from "react";
import {
  fetchMigrationVMs,
  planMigration,
  executeMigration,
  fetchMigrationHistory,
  fetchMigrationStatus,
} from "../api/client";
import type { MigrationVM, MigrationPlan, MigrationDirection, MigrationLiveRun } from "../types";
import { buildMigrationStatusEvent } from "../lib/migration-status";

type MigrationProvider = "vmware" | "proxmox" | "aws" | "azure";
type RouteExecutionSupport = "full" | "plan_only";

type MigrationRoute = {
  id: string;
  label: string;
  from: MigrationProvider;
  to: MigrationProvider;
  direction: MigrationDirection;
  executionSupport: RouteExecutionSupport;
  executionNote?: string;
};

const AZURE_PLAN_ONLY_NOTE =
  "Execution is not supported yet for this route. Use planning for sizing and preflight checks.";

const ROUTES: MigrationRoute[] = [
  { id: "vmware_to_proxmox", label: "VMware \u2192 Proxmox", from: "vmware", to: "proxmox", direction: "vmware_to_proxmox", executionSupport: "full" },
  { id: "proxmox_to_vmware", label: "Proxmox \u2192 VMware", from: "proxmox", to: "vmware", direction: "proxmox_to_vmware", executionSupport: "full" },
  { id: "vmware_to_aws", label: "VMware \u2192 AWS", from: "vmware", to: "aws", direction: "vmware_to_aws", executionSupport: "full" },
  { id: "aws_to_vmware", label: "AWS \u2192 VMware", from: "aws", to: "vmware", direction: "aws_to_vmware", executionSupport: "full" },
  { id: "proxmox_to_aws", label: "Proxmox \u2192 AWS", from: "proxmox", to: "aws", direction: "proxmox_to_aws", executionSupport: "full" },
  { id: "aws_to_proxmox", label: "AWS \u2192 Proxmox", from: "aws", to: "proxmox", direction: "aws_to_proxmox", executionSupport: "full" },
  { id: "vmware_to_azure", label: "VMware \u2192 Azure", from: "vmware", to: "azure", direction: "vmware_to_azure", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
  { id: "azure_to_vmware", label: "Azure \u2192 VMware", from: "azure", to: "vmware", direction: "azure_to_vmware", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
  { id: "proxmox_to_azure", label: "Proxmox \u2192 Azure", from: "proxmox", to: "azure", direction: "proxmox_to_azure", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
  { id: "azure_to_proxmox", label: "Azure \u2192 Proxmox", from: "azure", to: "proxmox", direction: "azure_to_proxmox", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
  { id: "aws_to_azure", label: "AWS \u2192 Azure", from: "aws", to: "azure", direction: "aws_to_azure", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
  { id: "azure_to_aws", label: "Azure \u2192 AWS", from: "azure", to: "aws", direction: "azure_to_aws", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
];

function isMigrationProvider(value: string): value is MigrationProvider {
  return value === "vmware" || value === "proxmox" || value === "aws" || value === "azure";
}

const STEP_LABELS: Record<string, string> = {
  export_config: "Export Config",
  power_off: "Power Off VM",
  transfer_disk: "Transfer Disk",
  convert_disk: "Convert Disk",
  resolve_target: "Resolve Target",
  import_vm: "Import VM",
  create_vm: "Create VM",
  cleanup: "Cleanup",
  // AWS steps
  upload_to_s3: "Upload to S3",
  import_ami: "Import as AMI",
  launch_instance: "Launch EC2 Instance",
  create_ami: "Create AMI",
  export_to_s3: "Export to S3",
  download_disk: "Download Disk",
  export_disk: "Export Disk",
  upload_to_azure: "Upload to Azure",
  create_managed_disk: "Create Managed Disk",
  capture_image: "Capture Image",
  stage_setup: "Setup Staging",
};

const LIVE_STAGE_LABELS: Record<string, string> = {
  upload: "Uploading to S3",
  upload_to_s3: "Uploading to S3",
  convert: "Converting to AMI",
  convert_disk: "Converting to AMI",
  import_ami: "Converting to AMI",
  register: "Registering image",
  register_image: "Registering image",
  create_ami: "Registering image",
  launch: "Launching EC2",
  launch_instance: "Launching EC2",
};

const ACTIVE_MIGRATION_RUNS_STORAGE_KEY = "vclaw.activeMigrationRuns";

function readStoredActiveMigrationRuns(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ACTIVE_MIGRATION_RUNS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

function writeStoredActiveMigrationRuns(runIds: string[]): void {
  if (typeof window === "undefined") return;
  if (runIds.length === 0) {
    window.localStorage.removeItem(ACTIVE_MIGRATION_RUNS_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(
    ACTIVE_MIGRATION_RUNS_STORAGE_KEY,
    JSON.stringify(runIds.slice(0, 50)),
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return "--";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const sec = Math.floor((end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function formatTimer(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function stageLabel(stage?: string): string {
  if (!stage) return "Preparing migration";
  const key = stage.trim().toLowerCase().replace(/ /g, "_");
  if (LIVE_STAGE_LABELS[key]) return LIVE_STAGE_LABELS[key];
  if (STEP_LABELS[key]) return STEP_LABELS[key];
  return stage.replace(/_/g, " ");
}

function runElapsedMs(run: MigrationLiveRun, nowMs: number): number {
  const start = new Date(run.startedAt).getTime();
  if (!Number.isFinite(start)) return 0;
  const end = run.completedAt ? new Date(run.completedAt).getTime() : nowMs;
  return Math.max(0, end - start);
}

function runEta(run: MigrationLiveRun, nowMs: number): string {
  if (run.status !== "running") return "--";
  const elapsed = runElapsedMs(run, nowMs);

  let basisPct = run.etaSample?.progressPct;
  let basisElapsed = run.etaSample?.elapsedMs;

  if ((!basisPct || !basisElapsed) && run.progressPct > 0) {
    basisPct = Math.min(run.progressPct, 20);
    basisElapsed = Math.round((elapsed * basisPct) / run.progressPct);
  }

  if (!basisPct || !basisElapsed || basisPct <= 0) return "--";
  const total = (basisElapsed / basisPct) * 100;
  const remaining = Math.max(0, total - elapsed);
  return formatTimer(remaining);
}

function migrationStatusLabel(run: MigrationLiveRun): string {
  if (run.status === "completed") return "SUCCESS";
  if (run.status === "failed") return "FAILED";
  return "RUNNING";
}

export default function Migrations() {
  const migrationHistory = useStore((s) => s.migrationHistory);
  const setMigrationHistory = useStore((s) => s.setMigrationHistory);
  const migrationRuns = useStore((s) => s.migrationRuns);
  const migrationRunOrder = useStore((s) => s.migrationRunOrder);
  const beginMigrationRun = useStore((s) => s.beginMigrationRun);
  const registerMigrationRun = useStore((s) => s.registerMigrationRun);
  const markMigrationRunFailed = useStore((s) => s.markMigrationRunFailed);
  const applyMigrationEvent = useStore((s) => s.applyMigrationEvent);
  const multiCluster = useStore((s) => s.multiCluster);

  const [routeId, setRouteId] = useState<string>("vmware_to_proxmox");
  const [vms, setVMs] = useState<MigrationVM[]>([]);
  const [selectedVM, setSelectedVM] = useState("");
  const [plan, setPlan] = useState<(MigrationPlan & { analysis?: any }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const availableRoutes = useMemo(() => {
    const connected = new Set<MigrationProvider>();
    for (const provider of multiCluster?.providers ?? []) {
      if (isMigrationProvider(provider.type)) {
        connected.add(provider.type);
      }
    }

    // Keep existing non-Azure routes visible even before multi-provider data arrives.
    const defaultRoutes = ROUTES.filter((routeItem) => routeItem.from !== "azure" && routeItem.to !== "azure");
    if (connected.size === 0) {
      return defaultRoutes;
    }

    const connectedRoutes = ROUTES.filter(
      (routeItem) => connected.has(routeItem.from) && connected.has(routeItem.to),
    );

    if (!connected.has("azure")) {
      return connectedRoutes.length > 0 ? connectedRoutes : defaultRoutes;
    }

    const azureRoutes = ROUTES.filter(
      (routeItem) => routeItem.from === "azure" || routeItem.to === "azure",
    );
    const merged = [...connectedRoutes];
    for (const routeItem of azureRoutes) {
      if (!merged.some((item) => item.id === routeItem.id)) {
        merged.push(routeItem);
      }
    }
    return merged.length > 0 ? merged : defaultRoutes;
  }, [multiCluster]);

  useEffect(() => {
    if (availableRoutes.some((routeItem) => routeItem.id === routeId)) return;
    setRouteId(availableRoutes[0]?.id ?? "vmware_to_proxmox");
  }, [availableRoutes, routeId]);

  const route = availableRoutes.find((item) => item.id === routeId) ?? availableRoutes[0] ?? ROUTES[0];
  const sourceProvider = route.from;
  const targetProvider = route.to;
  const selectedDirection = route.direction;
  const isExecutionSupported = route.executionSupport === "full";
  const hasPlanDisks = (plan?.vmConfig?.disks?.length ?? 0) > 0;
  const executeDisabledReason =
    !isExecutionSupported
      ? route.executionNote ?? "Execution is not supported for this route."
      : plan && !hasPlanDisks
        ? "Source VM has no attached disks. Nothing to migrate."
        : null;

  // Load VMs for selected direction
  useEffect(() => {
    setVMs([]);
    setSelectedVM("");
    setPlan(null);
    setError(null);
    fetchMigrationVMs(sourceProvider)
      .then((res) => setVMs(res.vms || []))
      .catch(() => setError("Failed to load VMs"));
  }, [sourceProvider]);

  // Load migration history on mount
  useEffect(() => {
    fetchMigrationHistory()
      .then((res) => setMigrationHistory(res.migrations || []))
      .catch(() => {});
  }, [setMigrationHistory]);

  // Rehydrate active migration progress after refresh when backend status is available.
  useEffect(() => {
    let cancelled = false;
    const runIds = readStoredActiveMigrationRuns();
    if (runIds.length === 0) return;

    (async () => {
      for (const runId of runIds) {
        try {
          const status = await fetchMigrationStatus(runId);
          if (cancelled) return;

          const migrationEvent = buildMigrationStatusEvent(status, runId);
          if (!migrationEvent) continue;
          applyMigrationEvent(migrationEvent.type, migrationEvent.data, new Date().toISOString());
        } catch {
          // Status endpoint may be unavailable; live SSE updates continue to work.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyMigrationEvent]);

  // Clock tick for elapsed/eta rendering
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handlePlan = async () => {
    if (!selectedVM) return;
    setLoading(true);
    setError(null);
    try {
      const result = await planMigration(selectedDirection, selectedVM);
      setPlan(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create migration plan");
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!selectedVM || !plan || !isExecutionSupported || !hasPlanDisks) return;
    const ok = window.confirm(
      `This will migrate "${plan.vmConfig?.name || selectedVM}" from ${sourceProvider.toUpperCase()} to ${targetProvider.toUpperCase()}. The source VM will be powered off. Continue?`
    );
    if (!ok) return;

    setLoading(true);
    setError(null);
    const localRunId = beginMigrationRun({
      direction: selectedDirection,
      vmId: selectedVM,
      vmName: plan.vmConfig?.name || plan.source?.vmName || selectedVM,
    });

    try {
      const result = await executeMigration(selectedDirection, selectedVM);
      registerMigrationRun(result, {
        localRunId,
        direction: selectedDirection,
        vmId: selectedVM,
        vmName: plan.vmConfig?.name || plan.source?.vmName || selectedVM,
      });

      if (result.status === "failed") {
        setError(result.error || "Migration failed");
      }
      setPlan(null);
      setSelectedVM("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Migration failed";
      setError(message);
      markMigrationRunFailed(localRunId, message);
    } finally {
      setLoading(false);
    }
  };
  const displayedRuns = useMemo(
    () => migrationRunOrder.map((runId) => migrationRuns[runId]).filter((run): run is MigrationLiveRun => run != null),
    [migrationRunOrder, migrationRuns],
  );

  useEffect(() => {
    const activeRunIds = displayedRuns
      .filter((run) => run.status === "running")
      .map((run) => run.id);
    writeStoredActiveMigrationRuns(activeRunIds);
  }, [displayedRuns]);

  return (
    <>
      {/* Main Migration Card */}
      <div className="card">
        <div className="card-head">
          <span>Cross-Provider Migration</span>
          <span className="badge" style={{ background: "var(--teal)", color: "#000" }}>
            BIDIRECTIONAL
          </span>
        </div>

        {/* Direction + VM Selector */}
        <div className="mig-controls">
          <div className="mig-field">
            <label>Direction</label>
            <select
              value={routeId}
              onChange={(e) => {
                setRouteId(e.target.value);
                setPlan(null);
                setError(null);
              }}
              disabled={loading}
            >
              {availableRoutes.map((routeOption) => (
                <option key={routeOption.id} value={routeOption.id}>
                  {routeOption.executionSupport === "plan_only"
                    ? `${routeOption.label} (plan only)`
                    : routeOption.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mig-field">
            <label>Source VM</label>
            <select
              value={selectedVM}
              onChange={(e) => {
                setSelectedVM(e.target.value);
                setPlan(null);
              }}
              disabled={loading}
            >
              <option value="">Select VM...</option>
              {vms.map((vm) => (
                <option key={vm.id} value={vm.id}>
                  {vm.name} ({vm.cpu} CPU, {vm.memoryMiB} MiB, {vm.diskGB} GB)
                </option>
              ))}
            </select>
          </div>

          <button
            className="btn-mig-plan"
            disabled={!selectedVM || loading}
            onClick={handlePlan}
          >
            {loading && !plan ? "Planning..." : "Plan"}
          </button>

          <button
            className="btn-mig-execute"
            disabled={!plan || loading || executeDisabledReason != null}
            title={executeDisabledReason ?? "Execute migration"}
            onClick={handleExecute}
          >
            {loading && plan ? "Migrating..." : "Migrate"}
          </button>
        </div>

        {!isExecutionSupported && (
          <div className="mig-error">
            {route.executionNote}
          </div>
        )}

        {plan && !hasPlanDisks && (
          <div className="mig-error">
            Source VM has no attached disks. Execution is disabled because there is no data to migrate.
          </div>
        )}

        {error && (
          <div className="mig-error">{error}</div>
        )}

        {/* Plan Preview */}
        {plan && (
          <div className="mig-plan-preview">
            <div className="mig-plan-title">Migration Plan</div>

            <div className="mig-plan-summary">
              <div className="mig-plan-row">
                <div className="mig-plan-cell">
                  <span className="mig-plan-label">VM</span>
                  <span className="mig-plan-value">{plan.vmConfig?.name || plan.source?.vmName || selectedVM}</span>
                </div>
                <div className="mig-plan-cell">
                  <span className="mig-plan-label">CPU</span>
                  <span className="mig-plan-value">{plan.vmConfig?.cpuCount || "?"} cores</span>
                </div>
                <div className="mig-plan-cell">
                  <span className="mig-plan-label">RAM</span>
                  <span className="mig-plan-value">{plan.vmConfig?.memoryMiB || "?"} MiB</span>
                </div>
                <div className="mig-plan-cell">
                  <span className="mig-plan-label">Disks</span>
                  <span className="mig-plan-value">
                    {plan.vmConfig?.disks?.length || 0}
                    {plan.vmConfig?.disks?.[0] && ` (${formatBytes(plan.vmConfig.disks[0].capacityBytes)})`}
                  </span>
                </div>
                <div className="mig-plan-cell">
                  <span className="mig-plan-label">Firmware</span>
                  <span className="mig-plan-value">{plan.vmConfig?.firmware?.toUpperCase() || "BIOS"}</span>
                </div>
              </div>
            </div>

            <div className="mig-plan-steps">
              <span className="mig-plan-label">Steps</span>
              <div className="mig-step-list">
                {plan.steps?.map((step, i) => (
                  <div key={step.name} className="mig-step-chip">
                    <span className="mig-step-num">{i + 1}</span>
                    {STEP_LABELS[step.name] || step.name}
                  </div>
                ))}
              </div>
            </div>

            <div className="mig-plan-route">
              <div className="mig-route-node">
                <span className="mig-route-provider">{plan.source?.provider?.toUpperCase()}</span>
                <span className="mig-route-detail">{plan.source?.vmName || selectedVM}</span>
              </div>
              <div className="mig-route-arrow">
                <svg width="32" height="16" viewBox="0 0 32 16">
                  <line x1="0" y1="8" x2="26" y2="8" stroke="var(--teal)" strokeWidth="2" />
                  <polygon points="26,3 32,8 26,13" fill="var(--teal)" />
                </svg>
              </div>
              <div className="mig-route-node">
                <span className="mig-route-provider">{plan.target?.provider?.toUpperCase()}</span>
                <span className="mig-route-detail">
                  {plan.target?.instanceType || plan.target?.storage || plan.target?.node}
                </span>
              </div>
            </div>

            {/* AWS Workload Analysis */}
            {plan.analysis && (
              <div className="mig-analysis">
                <div className="mig-plan-title" style={{ marginTop: 16 }}>Workload Analysis</div>
                <div className="mig-plan-summary">
                  <div className="mig-plan-row">
                    {plan.analysis.target?.recommended?.instanceType && (
                      <div className="mig-plan-cell">
                        <span className="mig-plan-label">EC2 Type</span>
                        <span className="mig-plan-value" style={{ color: "#FF9900" }}>
                          {plan.analysis.target.recommended.instanceType}
                        </span>
                      </div>
                    )}
                    {plan.analysis.costEstimate && (
                      <div className="mig-plan-cell">
                        <span className="mig-plan-label">Est. Cost</span>
                        <span className="mig-plan-value" style={{ color: "var(--teal)" }}>
                          ${plan.analysis.costEstimate.monthlyUSD?.toFixed(2)}/mo
                        </span>
                      </div>
                    )}
                    {plan.analysis.storage && (
                      <div className="mig-plan-cell">
                        <span className="mig-plan-label">Storage</span>
                        <span className="mig-plan-value">
                          {plan.analysis.storage.estimatedTargetGB?.toFixed(1)} GB EBS
                        </span>
                      </div>
                    )}
                    {plan.analysis.migrationTimeEstimateMinutes != null && (
                      <div className="mig-plan-cell">
                        <span className="mig-plan-label">Est. Time</span>
                        <span className="mig-plan-value">
                          ~{plan.analysis.migrationTimeEstimateMinutes} min
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                {plan.analysis.risks?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <span className="mig-plan-label">Risks</span>
                    <div style={{ marginTop: 4 }}>
                      {plan.analysis.risks.map((risk: string, i: number) => (
                        <div key={i} style={{ fontSize: 12, color: "#f59e0b", padding: "2px 0" }}>
                          ⚠ {risk}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {plan.analysis.target?.alternatives?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <span className="mig-plan-label">Alternatives</span>
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      {plan.analysis.target.alternatives.map((alt: any, i: number) => (
                        <span key={i} className="mig-step-chip" style={{ fontSize: 11 }}>
                          {alt.instanceType} (${alt.estimatedMonthlyCost?.toFixed(0)}/mo)
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Live Migration Progress */}
        {displayedRuns.length > 0 && (
          <div className="mig-progress-list" aria-live="polite">
            {displayedRuns.map((run) => {
              const elapsedMs = runElapsedMs(run, nowTick);
              const progressPct = Math.max(0, Math.min(100, run.progressPct));
              return (
                <div key={run.id} className={`mig-progress-item ${run.status}`}>
                  <div className="mig-progress-head">
                    <div className="mig-progress-title">
                      {run.vmName || run.vmId || run.migrationId}
                    </div>
                    <span className={`mig-progress-status ${run.status}`}>
                      {migrationStatusLabel(run)}
                    </span>
                  </div>

                  <div className="mig-progress-stage">{stageLabel(run.stage)}</div>

                  <div
                    className="mig-progress-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progressPct)}
                    aria-label={`Migration progress for ${run.vmName || run.migrationId}`}
                  >
                    <div className={`mig-progress-fill ${run.status}`} style={{ width: `${progressPct}%` }} />
                  </div>

                  <div className="mig-progress-meta">
                    <span>{Math.round(progressPct)}%</span>
                    <span>Elapsed {formatTimer(elapsedMs)}</span>
                    <span>ETA {runEta(run, nowTick)}</span>
                  </div>

                  {run.message && (
                    <div className="mig-progress-message">{run.message}</div>
                  )}

                  {run.status === "completed" && (run.amiId || run.instanceId || run.targetVmId) && (
                    <div className="mig-progress-links">
                      {run.amiId && (
                        <a
                          href={`https://console.aws.amazon.com/ec2/home?#ImageDetails:imageId=${encodeURIComponent(run.amiId)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          AMI {run.amiId}
                        </a>
                      )}
                      {run.instanceId && (
                        <a
                          href={`https://console.aws.amazon.com/ec2/home?#InstanceDetails:instanceId=${encodeURIComponent(run.instanceId)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          EC2 {run.instanceId}
                        </a>
                      )}
                      {!run.amiId && !run.instanceId && run.targetVmId && (
                        <span>Target VM {run.targetVmId}</span>
                      )}
                    </div>
                  )}

                  {run.status === "failed" && run.error && (
                    <div className="mig-progress-error">{run.error}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Migration History */}
      <div className="card">
        <div className="card-head">
          <span>Migration History</span>
          <span className="badge">{migrationHistory.length}</span>
        </div>

        {migrationHistory.length === 0 ? (
          <div className="empty-state">No migrations yet</div>
        ) : (
          <div className="mig-history">
            {migrationHistory.map((m) => (
              <div key={m.id} className="mig-history-item">
                <div className="mig-history-main">
                  <span className="mig-history-name">{m.vmConfig?.name || m.source?.vmName || "Unknown"}</span>
                  <span className={`mig-history-status ${m.status}`}>
                    {m.status === "completed" ? "SUCCESS" : m.status.toUpperCase()}
                  </span>
                </div>
                <div className="mig-history-detail">
                  <span>{m.source?.provider?.toUpperCase()} -&gt; {m.target?.provider?.toUpperCase()}</span>
                  <span>{m.startedAt ? new Date(m.startedAt).toLocaleString() : "--"}</span>
                  <span>{formatDuration(m.startedAt, m.completedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
