function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace("%", ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export type MigrationStatusEventType =
  | "MigrationProgress"
  | "MigrationCompleted"
  | "MigrationFailed";

export interface MigrationStatusEvent {
  type: MigrationStatusEventType;
  data: Record<string, unknown>;
}

export function buildMigrationStatusEvent(
  rawStatus: unknown,
  fallbackMigrationId: string,
): MigrationStatusEvent | null {
  const root = asRecord(rawStatus);
  if (!root) return null;

  const payload =
    asRecord(root.migration) ??
    asRecord(root.status) ??
    asRecord(root.data) ??
    root;

  const data: Record<string, unknown> = { ...payload };
  const migrationId = asString(data.migrationId ?? data.migration_id ?? data.id) ?? fallbackMigrationId;
  data.migrationId = migrationId;

  const status = asString(data.status ?? data.state)?.toLowerCase();
  const progress = asNumber(
    data.progressPct ?? data.progress_pct ?? data.progress ?? data.percentage,
  );

  let type: MigrationStatusEventType = "MigrationProgress";
  if (status === "failed" || status === "error") {
    type = "MigrationFailed";
  } else if (status === "completed" || (progress !== undefined && progress >= 100)) {
    type = "MigrationCompleted";
  }

  return { type, data };
}
