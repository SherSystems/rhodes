import { describe, expect, it } from "vitest";
import { buildMigrationStatusEvent } from "../../dashboard-v2/src/lib/migration-status";

describe("migration status hydration helpers", () => {
  it("promotes completed snapshots to MigrationCompleted and preserves ids", () => {
    const event = buildMigrationStatusEvent(
      {
        migration: {
          migrationId: "mig-101",
          status: "completed",
          progressPct: 100,
          amiId: "ami-123",
        },
      },
      "fallback-id",
    );

    expect(event).toBeTruthy();
    expect(event?.type).toBe("MigrationCompleted");
    expect(event?.data.migrationId).toBe("mig-101");
    expect(event?.data.amiId).toBe("ami-123");
  });

  it("maps failed snapshots to MigrationFailed", () => {
    const event = buildMigrationStatusEvent(
      {
        data: {
          migration_id: "mig-102",
          state: "failed",
          error: "conversion failed",
        },
      },
      "fallback-id",
    );

    expect(event).toBeTruthy();
    expect(event?.type).toBe("MigrationFailed");
    expect(event?.data.migrationId).toBe("mig-102");
  });

  it("uses fallback id for in-progress snapshots without ids", () => {
    const event = buildMigrationStatusEvent(
      {
        progressPct: 22,
        stage: "upload",
      },
      "fallback-run-1",
    );

    expect(event).toBeTruthy();
    expect(event?.type).toBe("MigrationProgress");
    expect(event?.data.migrationId).toBe("fallback-run-1");
    expect(event?.data.progressPct).toBe(22);
  });
});
