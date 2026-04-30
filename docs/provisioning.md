# VM Provisioning

End-to-end VM provisioning planning module for vClaw. Lets a user say
"spin up a Windows 11 VM for running a trading bot" and get a concrete,
type-safe `ProvisioningPlan` that downstream tools can execute on
Proxmox / vSphere / AWS / Azure.

## Vision

A single provisioning surface that handles the full lifecycle:

1. **Understand the request.** Natural-language prompt + optional
   structured hints → typed `VmProvisioningRequest`.
2. **Resolve an OS target.** Windows 11, Ubuntu 24.04, Rocky 9, etc.
3. **Resolve an ISO source.** Direct download URL + sha256 + size +
   "needs form bypass?" flag, fetched per-OS (fwlink for Windows,
   `releases.ubuntu.com` for Ubuntu, MirrorManager for Fedora/Rocky).
4. **Generate an unattend payload.** `autounattend.xml` for Windows,
   `cloud-init` user-data for Ubuntu/Debian/Fedora cloud images,
   `kickstart` for Rocky/RHEL netinst.
5. **Pick sane VM hardware defaults** from a static per-OS-family map
   (UEFI, TPM, disk bus, NIC) — never LLM-decided.
6. **Create the VM** on the chosen hypervisor and run post-install
   steps.

The LLM only owns the soft decisions: OS choice (when not pinned by
hint), VM name, vCPU / RAM / disk sizing for the workload. Everything
hardware- or correctness-critical is data, not prose.

## Current state — SCAFFOLD

This pass is **scaffolding only**. The planner can return a fully-shaped
`ProvisioningPlan` from a real-shape LLM call, but:

- ISO resolvers (`WindowsFwlinkResolver`, `UbuntuReleasesResolver`,
  `FedoraMirrorResolver`) all throw clearly-labeled TODO errors.
- Unattend generators (`WindowsAutounattendGenerator`,
  `CloudInitGenerator`, `KickstartGenerator`) all throw clearly-labeled
  TODO errors.
- `provision_execute_plan` (the runner) is a stub that returns an error.
- The plan emits placeholder `IsoSource` (empty `url`) and placeholder
  `UnattendConfig` (empty `xml` / `content`) so tests can verify shape.

What does work:

- `ProvisioningPlanner.plan(request, target)` returns a typed plan.
- LLM call is real-shape (system prompt + JSON response, validated by
  zod). Mockable via `deps.callLLM`.
- Static `HARDWARE_DEFAULTS` map (Windows: UEFI + TPM + virtio NIC;
  Linux: UEFI + virtio disk + virtio NIC).
- Hint propagation: user-supplied `os`, `vmName`, `cpuCount`,
  `memoryMiB`, `diskGb` override LLM choices.
- `ProvisioningAdapter` registers four tools with the agent registry
  (`provision_plan_vm`, `provision_resolve_iso`,
  `provision_generate_unattend`, `provision_execute_plan`).

## File layout

```
src/provisioning/
  types.ts                  Request / plan / config types
  iso-resolver.ts           Per-OS resolver interfaces + TODO stubs
  unattend-generator.ts     Per-OS generator interfaces + TODO stubs
  planner.ts                ProvisioningPlanner (LLM-driven)
  adapter.ts                InfraAdapter implementation
  index.ts                  Public exports + provisioningTools array
src/tools/provisioning/
  tools.ts                  Re-export shim (matches src/tools/system/)
tests/provisioning/
  planner.test.ts
  iso-resolver.test.ts
  unattend-generator.test.ts
```

## Prioritized TODOs

Tackle in order. Each step unblocks the next.

1. **Implement `UbuntuReleasesResolver.resolve()`.** Easiest win, no
   form bypass, public mirrors with stable URL shapes. Validates the
   resolver shape end-to-end. Map `ubuntu-24.04` → `noble`, GET
   `https://releases.ubuntu.com/<codename>/SHA256SUMS`, pick the
   `live-server-amd64.iso` entry, and assemble the URL.
2. **Implement `CloudInitGenerator.generate()` for Ubuntu.** Render a
   `#cloud-config` YAML with users, packages, locale/keyboard/timezone,
   hostname, runcmd. Wire `sshPublicKey` and `username` from hints. Then
   build a NoCloud seed ISO (separate helper) for VMs without
   datasource discovery.
3. **Implement `provision_execute_plan` for Proxmox + Linux.**
   Orchestrator that: downloads the resolved ISO to Proxmox storage,
   builds the cloud-init seed, calls `qm create` with the static
   hardware defaults, attaches both ISOs as CD-ROMs, starts the VM,
   waits for cloud-init phone-home, then powers off and detaches the
   seed. This is the "Hello World" milestone.
4. **Implement `WindowsFwlinkResolver.resolve()` for Windows 11.** Map
   `windows-11` → the consumer fwlink ID, follow redirects, capture the
   final Azure blob URL + expiry. Detect the form-bypass case (the
   front page gates with JS; the fwlink does not).
5. **Implement `WindowsAutounattendGenerator.generate()` for Windows
   11.** Template the `autounattend.xml` with `BypassNRO`, local admin,
   skip-OOBE-network, `SetupComplete.cmd` post-install hook. This is
   the highest-value milestone — finally satisfies the original user
   ask ("Windows 11 VM for a trading bot").
6. **Implement `provision_execute_plan` for Proxmox + Windows.** Same
   pipeline as Linux but with autounattend.xml stamped onto a virtual
   floppy or a second CD-ROM (Windows Setup looks for it on attached
   removable media at boot).
7. **Add `FedoraMirrorResolver.resolve()` and `KickstartGenerator`.**
   Fills out the Linux matrix.
8. **vSphere / AWS / Azure execute paths.** Reuse the resolved ISO +
   unattend artifacts; only the create-VM step changes per provider.
9. **Post-install runner.** Walk `plan.postInstall[]`, ssh in, run each
   step. Hooks into the existing `system` adapter's `ssh_exec` /
   `install_packages` tools.
10. **CLI / dashboard surfacing.** A `vclaw provision "..."` one-shot
    that prints the plan and asks for confirmation before executing.

## Out of scope for the scaffold

- Real ISO downloads / checksum verification.
- Real `autounattend.xml` / cloud-init / kickstart rendering.
- Provider-specific VM creation calls.
- Caching of resolved ISOs across runs.
- Windows OpenSSH `sshPublicKey` provisioning (Linux-only for now).
- Multi-disk VMs (single-disk only in the scaffold).
