# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

### Added

- Azure provider support using ARM SDK clients for Compute, Network, and Resources.
- Azure quickstart coverage in `docs/quickstart.md` (service principal bootstrap + required env vars).
- README setup examples now include Azure credentials and dashboard-v2 context.

### Changed

- Dashboard server now serves the redesigned `dashboard-v2/dist` frontend by default.
- Cross-provider migration coverage now includes AWS/VMware/Proxmox migration paths (including AWS S3-based transfer pipeline when configured).
- Verified release test baseline at `1265 passing` (`npm test -- --run` on 2026-04-18).

### Testing

- Added 65 AWS tests across `tests/providers/aws-adapter.test.ts` and `tests/providers/aws-client.test.ts`.
- Added 58 Azure tests across `tests/providers/azure-adapter.test.ts` and `tests/providers/azure-client.test.ts`.

### Fixed

- Fixed flaky monitoring date-window behavior in `tests/monitoring/run-telemetry.test.ts` by aligning timer control in test setup.
