# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.x] - Unreleased

### Added

- Azure provider support using ARM SDK clients for Compute, Network, and Resources.
- Azure quickstart coverage in `docs/quickstart.md` (service principal bootstrap + required env vars).
- README setup examples now include Azure credentials and dashboard-v2 context.
- Proxmox -> Azure end-to-end execute path (`migrate_proxmox_to_azure`) with rollback cleanup for VM/disk/blob resources.
- Cloud uploader migration path that streams disk bytes over SSH through vClaw into AWS S3 / Azure page blobs (no `aws` / `az` CLI required on source hosts).

### Changed

- Dashboard server now serves the redesigned `dashboard-v2/dist` frontend by default.
- Dashboard screenshots in `docs/screenshots/topology.png` and `docs/screenshots/resources.png` were refreshed for dashboard-v2.
- Cross-provider migration coverage now includes executed Proxmox -> Azure runs plus AWS/VMware/Proxmox flows.
- AWS importer now prefers ImportSnapshot for raw-disk paths, registers AMIs with HVM/ENA/UEFI-preferred defaults, and keeps ImportImage fallback.
- Multipart upload tuning for migration artifacts (`queueSize=8`, `partSize=64 MiB`) improves large-disk ingest throughput.
- Agent reliability updates: planner schema validation (Zod) and executor retry/backoff/limit controls.
- Verified release test baseline at `1338 passed / 20 skipped` (`npm test -- --run` on 2026-04-19).

### Testing

- Added 65 AWS tests across `tests/providers/aws-adapter.test.ts` and `tests/providers/aws-client.test.ts`.
- Added 58 Azure tests across `tests/providers/azure-adapter.test.ts` and `tests/providers/azure-client.test.ts`.
- Added targeted migration tests: `tests/migration/cloud-uploader.test.ts`, `tests/migration/azure-workload-analyzer.test.ts`, `tests/migration/adapter-azure-routes.test.ts`, `tests/migration/aws-importer.test.ts`.
- Added dashboard migration-progress coverage in `tests/frontends/dashboard-v2-migration-progress.test.ts`.

### Fixed

- Fixed flaky monitoring date-window behavior in `tests/monitoring/run-telemetry.test.ts` by aligning timer control in test setup.
