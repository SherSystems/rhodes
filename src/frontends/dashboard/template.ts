// ============================================================
// RHODES — Dashboard HTML Template
// Clean, premium SaaS-grade real-time agent dashboard
// Inspired by Vercel, Linear, and Grafana design systems
// ============================================================

export function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RHODES — Infrastructure Agent</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='none'%3E%3Crect width='100' height='100' rx='18' fill='%231E2328'/%3E%3Cg stroke='%234DA3F7' stroke-width='9' stroke-linejoin='miter' stroke-linecap='square' fill='none'%3E%3Cpolyline points='22,22 64,38 22,54'/%3E%3Cpolyline points='22,46 64,62 22,78'/%3E%3C/g%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* ── Reset ───────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  /* RHODES brand palette — see /home/pranav/rhodes-brand/BRAND_BIBLE.md §3 */
  --bg-primary: #1E2328;       /* Gunmetal */
  --bg-card: #2A2F36;          /* Steel raised */
  --bg-elevated: #2F363D;      /* Slate */
  --bg-hover: #353B43;
  --bg-active: #3D444D;

  --border: rgba(255, 255, 255, 0.07);
  --border-subtle: rgba(255, 255, 255, 0.04);
  --border-focus: rgba(255, 255, 255, 0.12);

  --text-primary: #E6E9EC;     /* Paper */
  --text-secondary: #8B949E;   /* Steel */
  --text-tertiary: #6E7681;
  --text-accent: #ffffff;

  /* Accent — Rhodes Blue (canonical, image wins over markdown export) */
  --teal: #4DA3F7;
  --teal-deep: #2F8AE0;
  --teal-muted: rgba(77, 163, 247, 0.10);
  --teal-border: rgba(77, 163, 247, 0.20);

  --green: #22C55E;
  --green-muted: rgba(34, 197, 94, 0.10);
  --red: #EF4444;
  --red-muted: rgba(239, 68, 68, 0.10);
  --amber: #F5A623;
  --amber-muted: rgba(245, 166, 35, 0.10);
  --blue: #4DA3F7;
  --blue-muted: rgba(77, 163, 247, 0.10);
  --purple: #a78bfa;
  --purple-muted: rgba(167, 139, 250, 0.10);

  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-brand: 'Syne', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;

  --radius: 8px;
  --radius-sm: 6px;
  --radius-lg: 12px;
}

html { font-size: 14px; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }

body {
  font-family: var(--font-sans);
  background: var(--bg-primary);
  color: var(--text-primary);
  min-height: 100vh;
  line-height: 1.5;
}

/* ── Animations (minimal, purposeful) ────────────────── */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Scrollbar ───────────────────────────────────────── */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-focus); }

/* ── Header ──────────────────────────────────────────── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 48px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  position: sticky;
  top: 0;
  z-index: 50;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-brand);
  font-weight: 800;
  font-size: 1rem;
  color: var(--text-accent);
  letter-spacing: -0.035em;
}

.logo .brand-accent {
  color: var(--teal);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.conn-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  color: var(--text-tertiary);
}

.conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
}

.conn-dot.live {
  background: var(--teal);
}

.conn-dot.dead {
  background: var(--red);
}

.mode-pill {
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 0.71rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.mode-pill.build { background: var(--blue-muted); color: var(--blue); }
.mode-pill.watch { background: var(--teal-muted); color: var(--teal); }
.mode-pill.investigate { background: var(--amber-muted); color: var(--amber); }

/* ── Stat Row ────────────────────────────────────────── */
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1px;
  background: var(--border);
  border-bottom: 1px solid var(--border);
}

.stat-cell {
  background: var(--bg-primary);
  padding: 16px 24px;
}

.stat-label {
  font-size: 0.71rem;
  font-weight: 500;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-accent);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.stat-value .unit {
  font-size: 0.78rem;
  font-weight: 400;
  color: var(--text-tertiary);
  margin-left: 2px;
}

/* ── Main Layout ─────────────────────────────────────── */
.main {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 0;
  max-width: 1440px;
  margin: 0 auto;
  min-height: calc(100vh - 48px - 73px);
}

@media (max-width: 1080px) {
  .main { grid-template-columns: 1fr; }
}

.col-left {
  border-right: 1px solid var(--border);
}

/* ── Card ────────────────────────────────────────────── */
.card {
  border-bottom: 1px solid var(--border);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-subtle);
}

.card-title {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.card-title svg { width: 14px; height: 14px; opacity: 0.6; }

.card-badge {
  font-size: 0.64rem;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
  font-variant-numeric: tabular-nums;
}

.card-body { padding: 16px 24px; }
.card-body.flush { padding: 0; }

/* ── Active Plan / Pipeline ──────────────────────────── */
.plan-header {
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.plan-goal-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}

.plan-mode-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
  margin-top: 1px;
}

.plan-mode-icon.build { background: var(--blue-muted); color: var(--blue); }
.plan-mode-icon.watch { background: var(--green-muted); color: var(--green); }
.plan-mode-icon.investigate { background: var(--amber-muted); color: var(--amber); }
.plan-mode-icon.heal { background: var(--purple-muted); color: var(--purple); }

.plan-goal-text {
  flex: 1;
  min-width: 0;
}

.plan-goal {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text-accent);
  line-height: 1.4;
  margin-bottom: 2px;
}

.plan-reasoning {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.plan-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 0.71rem;
  color: var(--text-tertiary);
}

.plan-meta-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.plan-meta-item .meta-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.plan-progress-bar {
  flex: 1;
  height: 3px;
  background: var(--bg-active);
  border-radius: 2px;
  overflow: hidden;
  min-width: 80px;
}

.plan-progress-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--teal);
  transition: width 0.4s ease;
}

.plan-progress-fill.has-failures { background: var(--amber); }

/* Pipeline steps (vertical list) */
.pipeline {
  padding: 0;
}

.pipe-step {
  display: flex;
  align-items: stretch;
  position: relative;
}

.pipe-step-gutter {
  width: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  position: relative;
}

.pipe-step-number {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid var(--border);
  background: var(--bg-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.64rem;
  font-weight: 600;
  color: var(--text-tertiary);
  z-index: 2;
  flex-shrink: 0;
  transition: all 0.3s ease;
}

.pipe-step-line {
  width: 2px;
  flex: 1;
  background: var(--border);
  transition: background 0.3s ease;
}

.pipe-step:last-child .pipe-step-line { display: none; }

/* Step statuses */
.pipe-step.pending .pipe-step-number { border-color: var(--border); color: var(--text-tertiary); }
.pipe-step.running .pipe-step-number { border-color: var(--blue); color: var(--blue); background: var(--blue-muted); animation: pulse 1.5s ease-in-out infinite; }
.pipe-step.success .pipe-step-number { border-color: var(--teal); color: var(--teal); background: var(--teal-muted); }
.pipe-step.failed .pipe-step-number { border-color: var(--red); color: var(--red); background: var(--red-muted); }
.pipe-step.skipped .pipe-step-number { opacity: 0.3; }

.pipe-step.success .pipe-step-line { background: var(--teal); opacity: 0.3; }
.pipe-step.running .pipe-step-line { background: linear-gradient(to bottom, var(--blue) 0%, var(--border) 100%); opacity: 0.3; }

.pipe-step-content {
  flex: 1;
  padding: 4px 16px 16px 0;
  min-width: 0;
}

.pipe-step-action {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-primary);
  font-family: var(--font-mono);
  margin-bottom: 2px;
}

.pipe-step-desc {
  font-size: 0.71rem;
  color: var(--text-tertiary);
  line-height: 1.4;
  margin-bottom: 4px;
}

.pipe-step-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pipe-step-tier {
  font-size: 0.60rem;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pipe-step-tier.read { background: var(--blue-muted); color: var(--blue); }
.pipe-step-tier.safe_write { background: var(--green-muted); color: var(--green); }
.pipe-step-tier.risky_write { background: var(--amber-muted); color: var(--amber); }
.pipe-step-tier.destructive { background: var(--red-muted); color: var(--red); }

.pipe-step-duration {
  font-size: 0.64rem;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

.pipe-step-error {
  margin-top: 4px;
  font-size: 0.71rem;
  color: var(--red);
  padding: 6px 10px;
  background: var(--red-muted);
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--red);
}

.pipe-step.running .pipe-step-action { color: var(--blue); }
.pipe-step.failed .pipe-step-action { color: var(--red); }

/* Replan banner */
.plan-replan-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  background: var(--amber-muted);
  border-bottom: 1px solid rgba(245, 166, 35, 0.15);
  font-size: 0.75rem;
  color: var(--amber);
  animation: fadeIn 0.3s ease-out;
}

.plan-replan-banner .replan-icon {
  font-size: 0.85rem;
  flex-shrink: 0;
}

/* Plan completion */
.plan-complete-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 24px;
  font-size: 0.78rem;
}

.plan-complete-banner.success { background: var(--teal-muted); color: var(--teal); }
.plan-complete-banner.partial { background: var(--amber-muted); color: var(--amber); }

/* Step output results */
.step-output {
  margin-top: 6px;
  padding: 8px 12px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--teal);
  max-height: 200px;
  overflow-y: auto;
  animation: fadeIn 0.2s ease-out;
}

.step-output-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.64rem;
  color: var(--text-tertiary);
  cursor: pointer;
  margin-top: 4px;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--bg-elevated);
  border: none;
  font-family: var(--font-sans);
  transition: background 0.12s, color 0.12s;
}

.step-output-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.step-output-toggle svg {
  width: 10px;
  height: 10px;
  transition: transform 0.15s ease;
}

.step-output-toggle.open svg {
  transform: rotate(90deg);
}

.step-output table {
  font-size: 0.71rem;
  width: 100%;
}

.step-output table th {
  font-size: 0.64rem;
  padding: 4px 10px;
  background: var(--bg-active);
}

.step-output table td {
  padding: 4px 10px;
  font-size: 0.71rem;
}

.step-output pre {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  line-height: 1.5;
}

/* ── Nested Audit (plan → steps → details) ─────────── */
.audit-plan-group {
  border-bottom: 1px solid var(--border);
}

.audit-plan-group:last-child {
  border-bottom: none;
}

.audit-plan-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}

.audit-plan-header:hover {
  background: var(--bg-hover);
}

.audit-plan-chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform 0.2s ease;
}

.audit-plan-group.open > .audit-plan-header .audit-plan-chevron {
  transform: rotate(90deg);
}

.audit-plan-goal {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.audit-plan-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.audit-plan-stat {
  font-size: 0.60rem;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono);
}

.audit-plan-stat.count { background: rgba(255,255,255,0.06); color: var(--text-secondary); }
.audit-plan-stat.ok { background: var(--green-muted); color: var(--green); }
.audit-plan-stat.fail { background: var(--red-muted); color: var(--red); }

.audit-plan-result {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.audit-plan-result.success { background: var(--teal); }
.audit-plan-result.failed { background: var(--red); }
.audit-plan-result.mixed { background: var(--amber); }

.audit-plan-steps {
  display: none;
  padding-left: 8px;
}

.audit-plan-group.open > .audit-plan-steps {
  display: block;
}

.empty-state {
  text-align: center;
  padding: 40px 24px;
  color: var(--text-tertiary);
  font-size: 0.78rem;
}

.empty-state .icon {
  font-size: 1.5rem;
  margin-bottom: 8px;
  opacity: 0.3;
}

/* ── VM Table ────────────────────────────────────────── */
.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}

thead th {
  text-align: left;
  padding: 8px 16px;
  font-weight: 500;
  color: var(--text-tertiary);
  font-size: 0.71rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
  position: sticky;
  top: 0;
}

tbody td {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

tbody tr:hover {
  background: var(--bg-hover);
}

tbody tr:last-child td {
  border-bottom: none;
}

.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 0.71rem;
  font-weight: 500;
}

.status-tag.running { background: var(--teal-muted); color: var(--teal); }
.status-tag.stopped { background: var(--red-muted); color: var(--red); }
.status-tag.paused { background: var(--amber-muted); color: var(--amber); }

.resource-bar {
  width: 60px;
  height: 4px;
  background: var(--bg-active);
  border-radius: 2px;
  overflow: hidden;
  display: inline-block;
  vertical-align: middle;
  margin-left: 6px;
}

.resource-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s;
}

.resource-bar-fill.low { background: var(--teal); }
.resource-bar-fill.medium { background: var(--amber); }
.resource-bar-fill.high { background: var(--red); }

/* ── Event Log (right column) ────────────────────────── */
.event-log {
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.event-item {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 0.75rem;
  line-height: 1.5;
  animation: fadeIn 0.2s ease-out;
  transition: background 0.12s;
}

.event-item:hover {
  background: var(--bg-hover);
}

.event-item-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.event-icon {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  flex-shrink: 0;
  margin-top: 1px;
}

.event-icon.plan { background: var(--purple-muted); color: var(--purple); }
.event-icon.step { background: var(--blue-muted); color: var(--blue); }
.event-icon.ok { background: var(--teal-muted); color: var(--teal); }
.event-icon.err { background: var(--red-muted); color: var(--red); }
.event-icon.warn { background: var(--amber-muted); color: var(--amber); }
.event-icon.info { background: rgba(255,255,255,0.06); color: var(--text-secondary); }

.event-body {
  flex: 1;
  min-width: 0;
}

.event-title {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 1px;
}

.event-title .event-action {
  font-family: var(--font-mono);
  font-size: 0.71rem;
  color: var(--blue);
  font-weight: 400;
}

.event-detail {
  font-size: 0.71rem;
  color: var(--text-tertiary);
  line-height: 1.4;
}

.event-detail.error-detail {
  color: var(--red);
  margin-top: 3px;
  padding: 4px 8px;
  background: var(--red-muted);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.68rem;
}

.event-ts {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.64rem;
  white-space: nowrap;
  flex-shrink: 0;
  padding-top: 2px;
}

.event-duration {
  font-family: var(--font-mono);
  font-size: 0.64rem;
  color: var(--text-tertiary);
  margin-left: 4px;
}

.event-badge {
  padding: 0 5px;
  border-radius: 3px;
  font-size: 0.64rem;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  line-height: 1.7;
}

.event-badge.plan { background: var(--purple-muted); color: var(--purple); }
.event-badge.step { background: var(--blue-muted); color: var(--blue); }
.event-badge.ok { background: var(--green-muted); color: var(--green); }
.event-badge.err { background: var(--red-muted); color: var(--red); }
.event-badge.warn { background: var(--amber-muted); color: var(--amber); }
.event-badge.info { background: rgba(255,255,255,0.06); color: var(--text-secondary); }

.event-msg {
  color: var(--text-secondary);
  word-break: break-word;
}

.event-log-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: 0.78rem;
  flex-direction: column;
  gap: 8px;
}

.event-log-empty .empty-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-tertiary);
  opacity: 0.3;
  animation: pulse 2s ease-in-out infinite;
}

/* Event groups (collapsible per plan) */
.event-group {
  border-bottom: 1px solid var(--border);
}

.event-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  cursor: pointer;
  user-select: none;
  background: var(--bg-elevated);
  transition: background 0.12s;
  border-bottom: 1px solid var(--border-subtle);
}

.event-group-header:hover {
  background: var(--bg-hover);
}

.event-group-chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform 0.2s ease;
}

.event-group.collapsed .event-group-chevron {
  transform: rotate(-90deg);
}

.event-group.collapsed .event-group-items {
  display: none;
}

.event-group-goal {
  font-size: 0.71rem;
  font-weight: 500;
  color: var(--text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.event-group-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.event-group-stat {
  font-size: 0.60rem;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono);
}

.event-group-stat.steps { background: var(--blue-muted); color: var(--blue); }
.event-group-stat.ok { background: var(--green-muted); color: var(--green); }
.event-group-stat.fail { background: var(--red-muted); color: var(--red); }

.event-group-result {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.event-group-result.success { background: var(--teal); }
.event-group-result.failed { background: var(--red); }
.event-group-result.running { background: var(--blue); animation: pulse 1.5s ease-in-out infinite; }

.event-group-items {
  /* shown by default, hidden when .collapsed */
}

/* ── Nodes Grid ──────────────────────────────────────── */
.nodes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}

.node-card {
  padding: 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-card);
}

.node-name {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.node-name .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.node-name .dot.online { background: var(--teal); }
.node-name .dot.offline { background: var(--red); }

.node-stat {
  display: flex;
  justify-content: space-between;
  font-size: 0.71rem;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}

.node-stat span:last-child {
  font-family: var(--font-mono);
  color: var(--text-secondary);
}

/* ── Incidents ──────────────────────────────────────── */
.incidents-section {
  padding: 0;
}

.incidents-section-title {
  font-size: 0.71rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 16px 24px 8px;
}

.incident-card {
  border-bottom: 1px solid var(--border-subtle);
  padding: 14px 24px;
  cursor: pointer;
  transition: background 0.12s;
  animation: fadeIn 0.3s ease-out;
}

.incident-card:hover {
  background: var(--bg-hover);
}

.incident-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.incident-severity {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.64rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

.incident-severity.critical {
  background: var(--red-muted);
  color: var(--red);
}

.incident-severity.warning {
  background: var(--amber-muted);
  color: var(--amber);
}

.incident-status-pill {
  font-size: 0.60rem;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.incident-status-pill.open {
  background: var(--red-muted);
  color: var(--red);
}

.incident-status-pill.healing {
  background: var(--blue-muted);
  color: var(--blue);
  animation: pulse 1.5s ease-in-out infinite;
}

.incident-status-pill.resolved {
  background: var(--teal-muted);
  color: var(--teal);
}

.incident-status-pill.failed {
  background: var(--red-muted);
  color: var(--red);
}

.incident-desc {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-primary);
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.incident-card-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 0.68rem;
  color: var(--text-tertiary);
}

.incident-metric-val {
  font-family: var(--font-mono);
  color: var(--text-secondary);
}

.incident-playbook {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--blue);
}

.incident-playbook .spinner {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
}

.incident-time-ago {
  margin-left: auto;
  font-family: var(--font-mono);
}

/* Incident compact row (resolved/failed) */
.incident-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 24px;
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: background 0.12s;
  font-size: 0.75rem;
  animation: fadeIn 0.3s ease-out;
}

.incident-row:hover {
  background: var(--bg-hover);
}

.incident-sev-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.incident-sev-dot.critical { background: var(--red); }
.incident-sev-dot.warning { background: var(--amber); }

.incident-row-desc {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.incident-row-duration {
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  font-size: 0.68rem;
  flex-shrink: 0;
}

.incident-row-resolution {
  font-size: 0.68rem;
  color: var(--text-tertiary);
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.incident-row-result {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.incident-row-result.resolved { background: var(--teal); }
.incident-row-result.failed { background: var(--red); }

.incident-pattern-tag {
  font-size: 0.57rem;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--purple-muted);
  color: var(--purple);
  flex-shrink: 0;
}

/* ── Remediate button on incident cards ─────────────── */
.incident-card-header .incident-remediate-wrap {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.incident-remediate-btn {
  appearance: none;
  border: 1px solid var(--teal-border);
  background: var(--teal-muted);
  color: var(--teal);
  font-family: var(--font-sans);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s, opacity 0.12s;
  flex-shrink: 0;
}

.incident-remediate-btn:hover:not(:disabled) {
  background: var(--teal);
  color: var(--bg-primary);
  border-color: var(--teal);
}

.incident-remediate-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}

.incident-remediate-done {
  font-size: 0.66rem;
  color: var(--text-tertiary);
  font-style: italic;
  flex-shrink: 0;
}

/* ── Pending Approvals Panel ────────────────────────── */
.approvals-section {
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  padding: 0;
  animation: fadeIn 0.25s ease-out;
}

.approvals-section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 24px 8px;
}

.approvals-section-title {
  font-family: var(--font-brand);
  font-weight: 700;
  letter-spacing: -0.02em;
  font-size: 0.86rem;
  color: var(--text-accent);
  text-transform: none;
}

.approvals-count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--teal);
  color: var(--bg-primary);
  font-family: var(--font-mono);
  font-size: 0.66rem;
  font-weight: 700;
}

.approvals-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 24px 14px;
}

.approval-card {
  border: 1px solid var(--border);
  border-left: 3px solid var(--teal);
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: fadeIn 0.2s ease-out;
}

.approval-card.safety {
  border-left-color: var(--green);
  background: linear-gradient(180deg, rgba(34, 197, 94, 0.04), var(--bg-card) 40%);
  opacity: 0.92;
}

/* Telegram deep-link arrival: brief ring pulse around the target card. */
@keyframes deepLinkPulse {
  0%   { box-shadow: 0 0 0 0 rgba(77, 163, 247, 0.55); }
  50%  { box-shadow: 0 0 0 6px rgba(77, 163, 247, 0.18); }
  100% { box-shadow: 0 0 0 0 rgba(77, 163, 247, 0.00); }
}

.approval-card.deep-link-highlight {
  animation: deepLinkPulse 2s ease-out 1;
}

.approval-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.approval-action {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-primary);
  word-break: break-word;
  flex: 1;
  min-width: 0;
}

.approval-tier {
  font-size: 0.60rem;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

.approval-tier.read { background: var(--green-muted); color: var(--green); }
.approval-tier.safe_write { background: var(--blue-muted); color: var(--blue); }
.approval-tier.risky_write { background: var(--amber-muted); color: var(--amber); }
.approval-tier.destructive { background: var(--red-muted); color: var(--red); }

.approval-safety-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.60rem;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 3px;
  background: var(--green-muted);
  color: var(--green);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

.approval-time {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.approval-reasoning {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
}

.approval-params {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 3px 12px;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--text-secondary);
}

.approval-params .pk { color: var(--text-tertiary); }
.approval-params .pv { color: var(--text-primary); word-break: break-word; }

.approval-card-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.approval-btn {
  appearance: none;
  font-family: var(--font-sans);
  font-size: 0.74rem;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s, border-color 0.12s, color 0.12s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.approval-btn.approve {
  background: var(--teal);
  color: var(--bg-primary);
  border: 1px solid var(--teal);
}

.approval-btn.approve:hover:not(:disabled) {
  background: var(--teal-deep);
  border-color: var(--teal-deep);
}

.approval-btn.reject {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-focus);
}

.approval-btn.reject:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.approval-btn:disabled {
  opacity: 0.55;
  cursor: progress;
}

.approval-btn .spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.approval-state-pill {
  font-size: 0.72rem;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
}

.approval-state-pill.approved { color: var(--teal); border-color: var(--teal-border); }
.approval-state-pill.rejected { color: var(--text-tertiary); }

.approval-error {
  font-size: 0.70rem;
  color: var(--red);
  font-family: var(--font-mono);
}

/* ── Toast for transient errors ─────────────────────── */
.rhodes-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  background: var(--bg-card);
  border: 1px solid var(--red);
  border-left-width: 3px;
  color: var(--text-primary);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 0.78rem;
  z-index: 200;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  animation: fadeIn 0.2s ease-out;
  max-width: 360px;
}

/* Narrow viewport reflow: ensure approval cards stay readable */
@media (max-width: 720px) {
  .approval-card-header { gap: 6px; }
  .approval-action { font-size: 0.72rem; }
  .approval-params { grid-template-columns: 1fr; gap: 1px 0; }
  .incident-card-header .incident-remediate-wrap { margin-left: 0; width: 100%; }
}

/* Incident Timeline (expanded) */
.incident-timeline {
  padding: 4px 24px 16px 24px;
  animation: fadeIn 0.25s ease-out;
}

.timeline-entry {
  display: flex;
  align-items: stretch;
  position: relative;
}

.timeline-gutter {
  width: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
}

.timeline-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  z-index: 2;
  flex-shrink: 0;
  border: 2px solid var(--border);
  background: var(--bg-primary);
}

.timeline-dot.detected {
  border-color: var(--red);
  background: var(--red-muted);
  color: var(--red);
}

.timeline-dot.action {
  border-color: var(--blue);
  background: var(--blue-muted);
  color: var(--blue);
}

.timeline-dot.action.success {
  border-color: var(--teal);
  background: var(--teal-muted);
  color: var(--teal);
}

.timeline-dot.action.fail {
  border-color: var(--red);
  background: var(--red-muted);
  color: var(--red);
}

.timeline-dot.resolved {
  border-color: var(--teal);
  background: var(--teal-muted);
  color: var(--teal);
}

.timeline-dot.failed {
  border-color: var(--red);
  background: var(--red-muted);
  color: var(--red);
}

.timeline-line {
  width: 2px;
  flex: 1;
  background: var(--border);
  min-height: 8px;
}

.timeline-entry:last-child .timeline-line { display: none; }

.timeline-content {
  flex: 1;
  padding: 0 0 12px 10px;
  min-width: 0;
}

.timeline-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 1px;
}

.timeline-detail {
  font-size: 0.68rem;
  color: var(--text-tertiary);
  line-height: 1.4;
}

.timeline-time {
  font-size: 0.64rem;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  margin-top: 1px;
}

.timeline-duration-badge {
  display: inline-block;
  font-size: 0.60rem;
  font-family: var(--font-mono);
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--teal-muted);
  color: var(--teal);
  margin-left: 6px;
}

.timeline-duration-badge.failed {
  background: var(--red-muted);
  color: var(--red);
}

/* Incident tab badge */
.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 0.57rem;
  font-weight: 700;
  background: var(--red);
  color: #fff;
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}

.tab-badge.zero {
  background: var(--bg-active);
  color: var(--text-tertiary);
}

/* Healing warning banners */
.healing-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  font-size: 0.75rem;
  animation: fadeIn 0.3s ease-out;
  border-bottom: 1px solid var(--border-subtle);
}

.healing-banner.paused {
  background: var(--amber-muted);
  color: var(--amber);
}

.healing-banner.escalated {
  background: var(--red-muted);
  color: var(--red);
}

.incidents-empty {
  text-align: center;
  color: var(--text-tertiary);
  padding: 40px 24px;
  font-size: 0.82rem;
}

.incidents-empty .empty-icon {
  font-size: 2rem;
  margin-bottom: 8px;
  opacity: 0.4;
}

/* ── Governance / Audit ──────────────────────────────── */
.gov-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
}

.gov-item {
  padding: 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-card);
}

.gov-label {
  font-size: 0.71rem;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}

.gov-value {
  font-size: 1.1rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.gov-value.ok { color: var(--teal); }
.gov-value.warn { color: var(--amber); }
.gov-value.danger { color: var(--red); }
.gov-value.neutral { color: var(--text-primary); }

/* ── Audit Accordion ────────────────────────────────── */
.audit-list {
  max-height: 500px;
  overflow-y: auto;
}

.audit-row {
  border-bottom: 1px solid var(--border-subtle);
}

.audit-row:last-child {
  border-bottom: none;
}

.audit-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}

.audit-header:hover {
  background: var(--bg-hover);
}

.audit-chevron {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform 0.2s ease;
}

.audit-row.open .audit-chevron {
  transform: rotate(90deg);
}

.audit-header .audit-time {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--text-tertiary);
  white-space: nowrap;
  flex-shrink: 0;
  min-width: 64px;
}

.audit-header .audit-action {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-header .audit-tier {
  font-size: 0.64rem;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.audit-tier.read { background: var(--blue-muted); color: var(--blue); }
.audit-tier.safe_write { background: var(--teal-muted); color: var(--teal); }
.audit-tier.risky_write { background: var(--amber-muted); color: var(--amber); }
.audit-tier.destructive { background: var(--red-muted); color: var(--red); }

.audit-header .audit-result-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.audit-result-dot.success { background: var(--teal); }
.audit-result-dot.failed { background: var(--red); }
.audit-result-dot.blocked { background: var(--amber); }
.audit-result-dot.rolled_back { background: var(--purple); }

.audit-detail {
  display: none;
  padding: 0 16px 14px 42px;
  animation: fadeIn 0.15s ease-out;
}

.audit-row.open .audit-detail {
  display: block;
}

.audit-detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 20px;
  margin-bottom: 10px;
}

.audit-detail-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.audit-detail-item .label {
  font-size: 0.64rem;
  font-weight: 500;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.audit-detail-item .value {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  word-break: break-all;
}

.audit-detail-item .value.ok { color: var(--green); }
.audit-detail-item .value.err { color: var(--red); }
.audit-detail-item .value.warn { color: var(--amber); }

.audit-reasoning {
  font-size: 0.75rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 10px;
  padding: 8px 12px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--border-focus);
}

.audit-params {
  font-size: 0.71rem;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  padding: 8px 12px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
}

.audit-error {
  font-size: 0.75rem;
  color: var(--red);
  padding: 8px 12px;
  background: var(--red-muted);
  border-radius: var(--radius-sm);
  margin-top: 8px;
}

.audit-approval {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.71rem;
  padding: 2px 8px;
  border-radius: 3px;
}

/* ── Tab Bar ─────────────────────────────────────────── */
.tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  padding: 0 24px;
  gap: 0;
}

.tab {
  padding: 10px 16px;
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-tertiary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
  user-select: none;
}

.tab:hover { color: var(--text-secondary); }
.tab.active { color: var(--text-primary); border-bottom-color: var(--text-primary); }

.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* ── Topology Map ───────────────────────────────────── */
.topo-container {
  position: relative;
  width: 100%;
  min-height: 600px;
  background: var(--bg-primary);
  overflow: hidden;
}

.topo-svg {
  width: 100%;
  height: 100%;
  min-height: 600px;
}

.topo-grid-line {
  stroke: var(--border-subtle);
  stroke-width: 0.5;
}

/* Node boxes */
.topo-node-box {
  cursor: pointer;
  transition: filter 0.2s;
}
.topo-node-box:hover {
  filter: brightness(1.2);
}
.topo-node-rect {
  fill: var(--bg-card);
  stroke: var(--border-focus);
  stroke-width: 1.5;
  rx: 10;
  ry: 10;
}
.topo-node-label {
  fill: var(--text-primary);
  font-family: var(--font-brand);
  font-size: 13px;
  font-weight: 700;
}
.topo-node-sublabel {
  fill: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 10px;
}
.topo-status-dot {
  r: 4;
}
.topo-status-dot.online { fill: var(--teal); }
.topo-status-dot.offline { fill: var(--red); }
.topo-status-dot.unknown { fill: var(--text-tertiary); }

/* Resource bars inside nodes */
.topo-bar-bg {
  fill: rgba(255,255,255,0.06);
  rx: 2; ry: 2;
}
.topo-bar-fill {
  rx: 2; ry: 2;
  transition: width 0.5s ease;
}
.topo-bar-label {
  fill: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}

/* Connection lines */
.topo-link {
  fill: none;
  stroke-width: 1.5;
  transition: stroke 0.3s, stroke-width 0.3s;
}
.topo-link.running {
  stroke: var(--teal);
  stroke-dasharray: 6 4;
  animation: topoFlowDash 1.5s linear infinite;
}
.topo-link.stopped {
  stroke: var(--text-tertiary);
  opacity: 0.4;
}
.topo-link.paused {
  stroke: var(--amber);
  stroke-dasharray: 4 4;
  opacity: 0.6;
}
.topo-link.highlight {
  stroke-width: 2.5;
  filter: drop-shadow(0 0 4px currentColor);
}

@keyframes topoFlowDash {
  to { stroke-dashoffset: -20; }
}

/* VM circles */
.topo-vm-group {
  cursor: pointer;
}
.topo-vm-group:hover .topo-vm-circle {
  stroke-width: 3;
  filter: brightness(1.3);
}
.topo-vm-circle {
  stroke-width: 2;
  transition: fill 0.3s, stroke 0.3s;
}
.topo-vm-circle.running {
  fill: var(--teal-muted);
  stroke: var(--teal);
}
.topo-vm-circle.stopped {
  fill: var(--red-muted);
  stroke: var(--red);
  opacity: 0.7;
}
.topo-vm-circle.paused {
  fill: var(--amber-muted);
  stroke: var(--amber);
}

/* Glow for running VMs */
.topo-vm-glow {
  fill: none;
  stroke-width: 1;
  opacity: 0;
}
.topo-vm-glow.running {
  stroke: var(--teal);
  opacity: 0.5;
  animation: topoGlowPulse 2.5s ease-in-out infinite;
}

@keyframes topoGlowPulse {
  0%, 100% { opacity: 0.2; r: inherit; }
  50% { opacity: 0.6; }
}

/* Incident / healing effects */
.topo-vm-incident-ring {
  fill: none;
  stroke-width: 2.5;
  stroke: var(--red);
  stroke-dasharray: 4 3;
  animation: topoIncidentPulse 1s ease-in-out infinite;
}

@keyframes topoIncidentPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.topo-vm-healing-ring {
  fill: none;
  stroke-width: 2;
  stroke: var(--amber);
  stroke-dasharray: 8 4;
  animation: spin 2s linear infinite;
  transform-origin: center;
}

.topo-vm-healed-flash {
  fill: none;
  stroke: var(--teal);
  stroke-width: 3;
  opacity: 0;
  animation: topoHealedFlash 1s ease-out forwards;
}

@keyframes topoHealedFlash {
  0% { opacity: 1; r: 10; }
  100% { opacity: 0; r: 35; }
}

/* VM labels */
.topo-vm-label {
  fill: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 500;
  text-anchor: middle;
  pointer-events: none;
}
.topo-vm-id-label {
  fill: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 8px;
  text-anchor: middle;
  pointer-events: none;
}

/* Storage blocks */
.topo-storage-rect {
  fill: var(--bg-elevated);
  stroke: var(--border);
  stroke-width: 1;
  rx: 6; ry: 6;
}
.topo-storage-label {
  fill: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 500;
}
.topo-storage-sub {
  fill: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
.topo-storage-bar-bg {
  fill: rgba(255,255,255,0.06);
  rx: 2; ry: 2;
}
.topo-storage-bar-fill {
  rx: 2; ry: 2;
  transition: width 0.5s ease;
}

/* Tooltip */
.topo-tooltip {
  position: absolute;
  left: 0;
  top: 0;
  background: var(--bg-elevated);
  border: 1px solid var(--border-focus);
  border-radius: var(--radius);
  padding: 10px 14px;
  font-size: 0.75rem;
  color: var(--text-primary);
  pointer-events: none;
  z-index: 100;
  opacity: 0;
  transition: opacity 0.15s;
  will-change: transform;
  max-width: 280px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  backdrop-filter: blur(8px);
}
.topo-tooltip.visible {
  opacity: 1;
}
.topo-tooltip .tt-title {
  font-weight: 600;
  font-size: 0.82rem;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.topo-tooltip .tt-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 2px 0;
  font-family: var(--font-mono);
  font-size: 0.71rem;
}
.topo-tooltip .tt-row .tt-key {
  color: var(--text-tertiary);
}
.topo-tooltip .tt-row .tt-val {
  color: var(--text-primary);
  font-weight: 500;
}

/* Detail side panel */
.topo-detail-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: 280px;
  height: 100%;
  background: var(--bg-card);
  border-left: 1px solid var(--border);
  padding: 16px;
  overflow-y: auto;
  transform: translateX(100%);
  transition: transform 0.25s ease;
  z-index: 50;
}
.topo-detail-panel.open {
  transform: translateX(0);
}
.topo-detail-close {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
.topo-detail-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.topo-detail-title {
  font-family: var(--font-brand);
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 4px;
}
.topo-detail-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.75rem;
  margin-bottom: 12px;
}
.topo-detail-status .dot {
  width: 7px; height: 7px; border-radius: 50%;
}
.topo-detail-status .dot.running { background: var(--teal); }
.topo-detail-status .dot.stopped { background: var(--red); }
.topo-detail-status .dot.paused { background: var(--amber); }
.topo-detail-section {
  margin-bottom: 14px;
}
.topo-detail-section-title {
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.topo-detail-row {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  font-size: 0.78rem;
}
.topo-detail-row .dk { color: var(--text-tertiary); }
.topo-detail-row .dv { color: var(--text-primary); font-family: var(--font-mono); font-weight: 500; }

/* Legend */
.topo-legend {
  position: absolute;
  bottom: 12px;
  left: 16px;
  display: flex;
  gap: 16px;
  font-size: 0.68rem;
  color: var(--text-tertiary);
  background: rgba(11,17,32,0.85);
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  backdrop-filter: blur(4px);
}
.topo-legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
}
.topo-legend-dot {
  width: 8px; height: 8px; border-radius: 50%;
}
.topo-legend-rect {
  width: 12px; height: 8px; border-radius: 2px;
}

/* ── Loading ─────────────────────────────────────────── */
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--text-secondary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  display: inline-block;
}

.loading-bar {
  height: 2px;
  background: var(--bg-active);
  position: relative;
  overflow: hidden;
}

.loading-bar::after {
  content: '';
  position: absolute;
  left: -40%;
  width: 40%;
  height: 100%;
  background: var(--teal);
  animation: loading 1s ease-in-out infinite;
}

@keyframes loading {
  0% { left: -40%; }
  100% { left: 100%; }
}

/* ── Resource Gauges & Sparklines ────────────────────── */
.resource-gauges {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  padding: 20px 24px;
}

.gauge-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: border-color 0.3s;
}

.gauge-card:hover {
  border-color: var(--border-focus);
}

.gauge-svg {
  position: relative;
  width: 100px;
  height: 100px;
}

.gauge-svg svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.gauge-svg .gauge-track {
  fill: none;
  stroke: var(--bg-active);
  stroke-width: 8;
}

.gauge-svg .gauge-fill {
  fill: none;
  stroke-width: 8;
  stroke-linecap: round;
  transition: stroke-dasharray 0.6s ease, stroke 0.4s ease;
}

.gauge-pct {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 1.28rem;
  font-weight: 700;
  color: var(--text-accent);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.gauge-pct .gauge-pct-unit {
  font-size: 0.71rem;
  font-weight: 400;
  color: var(--text-tertiary);
}

.gauge-label {
  font-size: 0.71rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}

.gauge-detail {
  font-size: 0.68rem;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

/* Sparklines section */
.sparklines-section {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  padding: 0 24px 20px;
}

.sparkline-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  transition: border-color 0.3s;
}

.sparkline-card:hover {
  border-color: var(--border-focus);
}

.sparkline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.sparkline-title {
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.sparkline-value {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-accent);
  font-variant-numeric: tabular-nums;
}

.sparkline-svg {
  width: 100%;
  height: 40px;
  overflow: visible;
}

.sparkline-svg .sparkline-area {
  fill: url(#sparkGrad);
  opacity: 0.15;
}

.sparkline-svg .sparkline-line {
  fill: none;
  stroke: var(--teal);
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}

/* Per-node breakdown */
.node-breakdown {
  padding: 0 24px 20px;
}

.node-breakdown-title {
  font-size: 0.71rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 10px;
}

.node-breakdown-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}

.node-break-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}

.node-break-name {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.node-break-name .nbdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--teal);
}

.node-break-name .nbdot.offline { background: var(--red); }

.node-break-bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}

.node-break-bar-label {
  font-size: 0.64rem;
  color: var(--text-tertiary);
  width: 30px;
  flex-shrink: 0;
}

.node-break-bar-track {
  flex: 1;
  height: 6px;
  background: var(--bg-active);
  border-radius: 3px;
  overflow: hidden;
}

.node-break-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.5s ease, background 0.4s ease;
}

.node-break-bar-pct {
  font-size: 0.64rem;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  width: 36px;
  text-align: right;
  flex-shrink: 0;
}

@media (max-width: 768px) {
  .resource-gauges { grid-template-columns: 1fr; }
  .sparklines-section { grid-template-columns: 1fr; }
}

/* ── Predictions ────────────────────────────────────── */
.predictions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

.prediction-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 20px;
  transition: border-color 0.2s, opacity 0.3s;
}

.prediction-card.status-healthy { border-left: 3px solid var(--green); }
.prediction-card.status-warning { border-left: 3px solid var(--amber); }
.prediction-card.status-critical { border-left: 3px solid var(--red); }

.prediction-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.prediction-metric {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.prediction-node {
  font-size: 0.72rem;
  color: var(--text-tertiary);
  background: var(--bg-card);
  padding: 2px 8px;
  border-radius: 10px;
}

.prediction-value-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.prediction-current {
  font-size: 1.5rem;
  font-weight: 600;
  font-family: var(--font-mono);
  line-height: 1;
}

.prediction-current.healthy { color: var(--green); }
.prediction-current.warning { color: var(--amber); }
.prediction-current.critical { color: var(--red); }

.prediction-trend {
  font-size: 1rem;
  opacity: 0.8;
}

.prediction-trend.rising { color: var(--red); }
.prediction-trend.stable { color: var(--text-tertiary); }
.prediction-trend.falling { color: var(--green); }

.prediction-slope {
  font-size: 0.72rem;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.prediction-bar-container {
  margin: 10px 0 6px;
  position: relative;
  height: 20px;
  background: var(--bg-card);
  border-radius: 4px;
  overflow: hidden;
}

.prediction-bar-current {
  height: 100%;
  border-radius: 4px 0 0 4px;
  transition: width 0.5s ease;
}

.prediction-bar-projected {
  position: absolute;
  top: 0;
  height: 100%;
  opacity: 0.3;
  transition: left 0.5s ease, width 0.5s ease;
}

.prediction-bar-threshold {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: var(--red);
  opacity: 0.7;
}

.prediction-bar-threshold::after {
  content: '90%';
  position: absolute;
  top: -14px;
  left: -10px;
  font-size: 0.6rem;
  color: var(--red);
  font-family: var(--font-mono);
}

.prediction-bar-proj-marker {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: var(--amber);
  opacity: 0.8;
}

.prediction-bar-proj-marker::after {
  content: '24h';
  position: absolute;
  bottom: -14px;
  left: -8px;
  font-size: 0.6rem;
  color: var(--amber);
  font-family: var(--font-mono);
}

.prediction-countdown {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-top: 4px;
}

.prediction-countdown .time-value {
  font-weight: 600;
  font-family: var(--font-mono);
}

.prediction-countdown .time-value.healthy { color: var(--green); }
.prediction-countdown .time-value.warning { color: var(--amber); }
.prediction-countdown .time-value.critical { color: var(--red); }

.prediction-status-text {
  font-size: 0.72rem;
  margin-top: 6px;
  padding: 4px 8px;
  border-radius: 4px;
}

.prediction-status-text.healthy {
  background: var(--green-muted);
  color: var(--green);
}
.prediction-status-text.warning {
  background: var(--amber-muted);
  color: var(--amber);
}
.prediction-status-text.critical {
  background: var(--red-muted);
  color: var(--red);
}

.predictions-empty {
  text-align: center;
  padding: 24px;
  color: var(--text-tertiary);
  font-size: 0.82rem;
}

/* ── Right-sizing Recommendations ────────────────────── */
.rightsizing-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
}
.rightsizing-card {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  transition: border-color 0.2s;
}
.rightsizing-card.severity-red { border-left: 3px solid var(--red); }
.rightsizing-card.severity-amber { border-left: 3px solid var(--amber); }
.rightsizing-card.severity-green { border-left: 3px solid var(--teal); }
.rightsizing-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.rightsizing-vm-name {
  font-family: var(--font-heading);
  font-weight: 600;
  font-size: 0.88rem;
  color: var(--text-primary);
}
.rightsizing-vm-meta {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}
.rightsizing-savings {
  font-size: 0.78rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
}
.rightsizing-savings.high { background: var(--red-muted); color: var(--red); }
.rightsizing-savings.medium { background: var(--amber-muted); color: var(--amber); }
.rightsizing-savings.low { background: var(--teal-muted); color: var(--teal); }
.rightsizing-resource {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.rightsizing-resource-label {
  font-size: 0.72rem;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  width: 32px;
  flex-shrink: 0;
}
.rightsizing-bar-container {
  flex: 1;
  height: 18px;
  background: rgba(255,255,255,0.04);
  border-radius: 4px;
  position: relative;
  overflow: hidden;
}
.rightsizing-bar-used {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s ease;
}
.rightsizing-bar-allocated {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  border-right: 2px dashed rgba(255,255,255,0.25);
}
.rightsizing-bar-recommended {
  position: absolute;
  top: 0;
  height: 100%;
  border-left: 2px solid var(--teal);
  opacity: 0.8;
}
.rightsizing-resource-detail {
  font-size: 0.72rem;
  color: var(--text-secondary);
  width: 140px;
  flex-shrink: 0;
  text-align: right;
}
.rightsizing-resource-detail .rec {
  color: var(--teal);
  font-weight: 500;
}
.rightsizing-stats {
  display: flex;
  gap: 16px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.rightsizing-stat {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}
.rightsizing-stat span {
  color: var(--text-secondary);
  font-weight: 500;
}
.rightsizing-empty {
  text-align: center;
  padding: 24px;
  color: var(--text-tertiary);
  font-size: 0.82rem;
}
.rightsizing-summary {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.rightsizing-summary-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  font-size: 0.78rem;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
}
.rightsizing-summary-pill .pill-count {
  font-weight: 700;
  font-family: var(--font-heading);
}

/* ── Chaos Engineering Panel ─────────────────────────── */
.chaos-controls {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.chaos-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 140px; }
.chaos-field label { font-size: 0.71rem; color: var(--text-tertiary); font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; }
.chaos-field select {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
  font-family: var(--font-sans);
  outline: none;
  cursor: pointer;
}
.chaos-field select:focus { border-color: var(--teal-border); }

.chaos-actions { display: flex; gap: 8px; align-items: flex-end; }

.btn-simulate {
  background: var(--blue-muted);
  color: var(--blue);
  border: 1px solid rgba(59,158,255,0.2);
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
  font-family: var(--font-sans);
  transition: background 0.15s, border-color 0.15s;
}
.btn-simulate:hover { background: rgba(59,158,255,0.18); border-color: rgba(59,158,255,0.35); }
.btn-simulate:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-execute-chaos {
  background: var(--red-muted);
  color: var(--red);
  border: 1px solid rgba(239,68,68,0.25);
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font-sans);
  transition: background 0.15s, border-color 0.15s;
  letter-spacing: 0.02em;
}
.btn-execute-chaos:hover { background: rgba(239,68,68,0.2); border-color: rgba(239,68,68,0.45); }
.btn-execute-chaos:disabled { opacity: 0.35; cursor: not-allowed; }

.chaos-sim-results {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: 16px;
  display: none;
}
.chaos-sim-results.visible { display: block; animation: fadeIn 0.2s ease; }
.chaos-sim-title { font-size: 0.78rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }

.chaos-blast-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.chaos-blast-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  background: var(--bg-card);
  border-radius: var(--radius-sm);
  font-size: 0.78rem;
}
.chaos-blast-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.chaos-blast-dot.direct { background: var(--red); }
.chaos-blast-dot.indirect { background: var(--amber); }
.chaos-blast-dot.safe { background: var(--teal); }

.chaos-sim-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 14px;
}
.chaos-sim-stat {
  background: var(--bg-card);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  text-align: center;
}
.chaos-sim-stat-label { font-size: 0.67rem; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
.chaos-sim-stat-value { font-size: 1.1rem; font-weight: 700; font-family: var(--font-brand); }

.chaos-sim-recommendation {
  font-size: 0.78rem;
  color: var(--text-secondary);
  padding: 10px 12px;
  background: var(--bg-card);
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--blue);
}

.risk-low { color: var(--teal); }
.risk-medium { color: var(--amber); }
.risk-high { color: var(--red); }

/* Chaos execution live view */
.chaos-execution {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: 16px;
  display: none;
}
.chaos-execution.visible { display: block; animation: fadeIn 0.2s ease; }

.chaos-exec-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 14px;
}
.chaos-exec-status-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 0.71rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.chaos-exec-status-badge.executing { background: var(--amber-muted); color: var(--amber); }
.chaos-exec-status-badge.recovering { background: var(--blue-muted); color: var(--blue); }
.chaos-exec-status-badge.verifying { background: var(--purple-muted); color: var(--purple); }
.chaos-exec-status-badge.completed { background: var(--green-muted); color: var(--green); }
.chaos-exec-status-badge.failed { background: var(--red-muted); color: var(--red); }

.chaos-exec-timer {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.chaos-exec-phases {
  display: flex; gap: 2px; margin-bottom: 14px;
}
.chaos-phase {
  flex: 1; height: 4px; border-radius: 2px;
  background: var(--border);
  transition: background 0.3s;
}
.chaos-phase.active { background: var(--amber); animation: pulse 1.5s infinite; }
.chaos-phase.done { background: var(--teal); }
.chaos-phase.failed { background: var(--red); }

.chaos-exec-log {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.chaos-log-entry {
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  padding: 3px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.chaos-log-entry .chaos-log-time { color: var(--text-tertiary); margin-right: 8px; }

/* Chaos results comparison */
.chaos-results {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  display: none;
}
.chaos-results.visible { display: block; animation: fadeIn 0.2s ease; }

.chaos-verdict {
  text-align: center;
  padding: 20px 0;
  margin-bottom: 16px;
}
.chaos-verdict-label { font-size: 0.71rem; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
.chaos-verdict-value { font-size: 2rem; font-weight: 800; font-family: var(--font-brand); }
.chaos-verdict-value.pass { color: var(--teal); }
.chaos-verdict-value.partial { color: var(--amber); }
.chaos-verdict-value.fail { color: var(--red); }

.chaos-resilience-score {
  text-align: center;
  margin-bottom: 16px;
}
.chaos-resilience-number { font-size: 2.8rem; font-weight: 800; font-family: var(--font-brand); color: var(--teal); }
.chaos-resilience-label { font-size: 0.71rem; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; }

.chaos-comparison {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 16px;
}
.chaos-compare-cell {
  background: var(--bg-card);
  border-radius: var(--radius-sm);
  padding: 12px;
  text-align: center;
}
.chaos-compare-label { font-size: 0.67rem; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
.chaos-compare-value { font-size: 1.15rem; font-weight: 700; font-family: var(--font-brand); color: var(--text-primary); }

.chaos-event-log {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}
.chaos-event-entry {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 8px;
  font-size: 0.75rem;
  background: var(--bg-card);
  border-radius: var(--radius-sm);
}
.chaos-event-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.chaos-event-dot.action { background: var(--blue); }
.chaos-event-dot.incident { background: var(--red); }
.chaos-event-dot.heal { background: var(--teal); }

.chaos-history-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 0.78rem;
}
.chaos-history-item:last-child { border-bottom: none; }
.chaos-history-meta { color: var(--text-tertiary); font-size: 0.71rem; }

/* ── Command Palette (Cmd+K) ───────────────────────── */
@keyframes cmdPaletteFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes cmdPaletteFadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes cmdPaletteSlideIn {
  from { opacity: 0; transform: translateY(-20px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes cmdPaletteSlideOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(-20px) scale(0.97); }
}
@keyframes cmdPaletteSpin {
  to { transform: rotate(360deg); }
}

.cmd-palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: none;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  background: rgba(5, 8, 18, 0.65);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.cmd-palette-overlay.open {
  display: flex;
  animation: cmdPaletteFadeIn 0.18s ease-out;
}
.cmd-palette-overlay.closing {
  animation: cmdPaletteFadeOut 0.14s ease-in forwards;
}

.cmd-palette {
  width: 100%;
  max-width: 640px;
  background: #0f1729;
  border: 1px solid var(--teal-border);
  border-radius: 16px;
  box-shadow: 0 0 0 1px rgba(10,205,170,0.08), 0 24px 80px rgba(0,0,0,0.6), 0 0 60px rgba(10,205,170,0.06);
  overflow: hidden;
  animation: cmdPaletteSlideIn 0.22s ease-out;
}
.cmd-palette-overlay.closing .cmd-palette {
  animation: cmdPaletteSlideOut 0.14s ease-in forwards;
}

.cmd-palette-input-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.cmd-palette-icon {
  flex-shrink: 0;
  color: var(--teal);
  opacity: 0.7;
}
.cmd-palette-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font-family: var(--font-sans);
  font-size: 1.15rem;
  font-weight: 500;
  color: var(--text-primary);
  caret-color: var(--teal);
}
.cmd-palette-input::placeholder {
  color: var(--text-tertiary);
  font-weight: 400;
}
.cmd-palette-kbd {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-sans);
  font-size: 0.7rem;
  color: var(--text-tertiary);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 2px 6px;
}

.cmd-palette-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-subtle);
}
.cmd-palette-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  font-family: var(--font-sans);
  font-size: 0.78rem;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 100px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.cmd-palette-chip:hover {
  color: var(--teal);
  border-color: var(--teal-border);
  background: var(--teal-muted);
}

.cmd-palette-response {
  display: none;
  padding: 16px 20px;
  max-height: 340px;
  overflow-y: auto;
}
.cmd-palette-response.visible {
  display: block;
}
.cmd-palette-response-label {
  font-family: var(--font-brand);
  font-size: 0.71rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--teal);
  margin-bottom: 10px;
}
.cmd-palette-response-body {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  line-height: 1.65;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
.cmd-palette-response-body.error {
  color: var(--red);
}
.cmd-palette-response-body.success {
  color: var(--text-primary);
}

.cmd-palette-loading {
  display: none;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  font-size: 0.85rem;
  color: var(--text-secondary);
}
.cmd-palette-loading.visible {
  display: flex;
}
.cmd-palette-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--teal);
  border-radius: 50%;
  animation: cmdPaletteSpin 0.6s linear infinite;
}

.cmd-palette-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  border-top: 1px solid var(--border-subtle);
  font-size: 0.7rem;
  color: var(--text-tertiary);
}
.cmd-palette-footer-keys {
  display: flex;
  gap: 12px;
}
.cmd-palette-footer-keys span {
  display: flex;
  align-items: center;
  gap: 4px;
}
.cmd-palette-footer-keys kbd {
  font-family: var(--font-sans);
  font-size: 0.65rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--text-tertiary);
}

/* Header Cmd+K trigger button */
.cmd-k-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-family: var(--font-sans);
  font-size: 0.78rem;
  color: var(--text-tertiary);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s ease;
}
.cmd-k-trigger:hover {
  color: var(--text-secondary);
  border-color: var(--teal-border);
  background: var(--bg-hover);
}
.cmd-k-trigger kbd {
  font-family: var(--font-sans);
  font-size: 0.68rem;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--text-tertiary);
}

</style>
</head>
<body>

<!-- ── Shadow Mode Banner ──────────────────────────── -->
<!-- Hidden by default; main.js flips display:flex when /api/agent/status
     returns shadow_mode=true. Sits above the header so it's never missed. -->
<div id="shadowModeBanner" style="display:none;background:#3a2a14;color:#ffb84d;padding:10px 18px;font-family:var(--font-brand);font-weight:700;letter-spacing:0.06em;text-align:center;border-bottom:1px solid #c88533;text-transform:uppercase;">
  SHADOW MODE &middot; RHODES_DRY_RUN=true &middot; Tier-1 reads execute; Tier-2+ writes are planned/logged but NOT executed.
</div>

<!-- ── Header ──────────────────────────────────────── -->
<header class="header">
  <div class="logo">
    <svg width="24" height="24" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="RHODES">
      <rect width="100" height="100" rx="18" fill="#1E2328"/>
      <g stroke="#4DA3F7" stroke-width="9" stroke-linejoin="miter" stroke-linecap="square" fill="none">
        <polyline points="22,22 64,38 22,54"/>
        <polyline points="22,46 64,62 22,78"/>
      </g>
    </svg>
    RHO<span class="brand-accent">DES</span>
  </div>
  <div class="header-right">
    <button class="cmd-k-trigger" id="cmdKTrigger" title="Command Palette">
      Ask RHODES
      <kbd>\u2318K</kbd>
    </button>
    <div class="conn-status">
      <span class="conn-dot" id="connDot"></span>
      <span id="connLabel">Connecting...</span>
    </div>
    <span class="mode-pill watch" id="modePill">WATCH</span>
  </div>
</header>

<!-- ── Command Palette Overlay ─────────────────────── -->
<div class="cmd-palette-overlay" id="cmdPaletteOverlay">
  <div class="cmd-palette" id="cmdPalette">
    <div class="cmd-palette-input-row">
      <svg class="cmd-palette-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
      </svg>
      <input type="text" class="cmd-palette-input" id="cmdPaletteInput" placeholder="Ask RHODES anything..." autocomplete="off" spellcheck="false">
      <span class="cmd-palette-kbd">ESC</span>
    </div>
    <div class="cmd-palette-chips" id="cmdPaletteChips">
      <button class="cmd-palette-chip" data-cmd="List running VMs">List running VMs</button>
      <button class="cmd-palette-chip" data-cmd="Show cluster health">Show cluster health</button>
      <button class="cmd-palette-chip" data-cmd="Restart VM 104">Restart VM 104</button>
      <button class="cmd-palette-chip" data-cmd="What's using the most CPU?">What's using the most CPU?</button>
      <button class="cmd-palette-chip" data-cmd="Prepare node for maintenance">Prepare node for maintenance</button>
    </div>
    <div class="cmd-palette-loading" id="cmdPaletteLoading">
      <div class="cmd-palette-spinner"></div>
      <span>RHODES is thinking...</span>
    </div>
    <div class="cmd-palette-response" id="cmdPaletteResponse">
      <div class="cmd-palette-response-label">Response</div>
      <div class="cmd-palette-response-body" id="cmdPaletteResponseBody"></div>
    </div>
    <div class="cmd-palette-footer">
      <span>RHODES Agent</span>
      <div class="cmd-palette-footer-keys">
        <span><kbd>\u21B5</kbd> Run</span>
        <span><kbd>ESC</kbd> Close</span>
      </div>
    </div>
  </div>
</div>

<!-- ── Stats Row ───────────────────────────────────── -->
<div class="stat-row" id="statRow">
  <div class="stat-cell">
    <div class="stat-label">Nodes</div>
    <div class="stat-value" id="statNodes">-</div>
  </div>
  <div class="stat-cell">
    <div class="stat-label">VMs</div>
    <div class="stat-value" id="statVMs">-</div>
  </div>
  <div class="stat-cell">
    <div class="stat-label">Containers</div>
    <div class="stat-value" id="statCTs">-</div>
  </div>
  <div class="stat-cell">
    <div class="stat-label">Running</div>
    <div class="stat-value" id="statRunning">-</div>
  </div>
  <div class="stat-cell">
    <div class="stat-label">Avg CPU</div>
    <div class="stat-value" id="statCPU">-<span class="unit">%</span></div>
  </div>
  <div class="stat-cell">
    <div class="stat-label">Avg RAM</div>
    <div class="stat-value" id="statRAM">-<span class="unit">%</span></div>
  </div>
</div>

<!-- ── Main Content ────────────────────────────────── -->
<div class="main">
  <!-- Left Column -->
  <div class="col-left">
    <!-- Pending Approvals (only renders when there are pending plans) -->
    <div class="approvals-section" id="approvalsSection" style="display:none">
      <div class="approvals-section-header">
        <span class="approvals-section-title">Pending Approvals</span>
        <span class="approvals-count-badge" id="approvalsCountBadge">0</span>
      </div>
      <div class="approvals-list" id="approvalsList"></div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <div class="tab active" data-tab="topology">
        <svg style="width:13px;height:13px;vertical-align:-2px;margin-right:3px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><circle cx="4" cy="19" r="3"/><circle cx="20" cy="19" r="3"/><line x1="12" y1="8" x2="4" y2="16"/><line x1="12" y1="8" x2="20" y2="16"/></svg>
        Topology
      </div>
      <div class="tab" data-tab="plan">Active Plan</div>
      <div class="tab" data-tab="resources">Resources</div>
      <div class="tab" data-tab="nodes">Nodes</div>
      <div class="tab" data-tab="incidents">
        <svg style="width:13px;height:13px;vertical-align:-2px;margin-right:3px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Incidents<span class="tab-badge zero" id="incidentTabBadge">0</span>
      </div>
      <div class="tab" data-tab="governance">Governance</div>
      <div class="tab" data-tab="chaos">
        <svg style="width:13px;height:13px;vertical-align:-2px;margin-right:3px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        Chaos
      </div>
    </div>

    <!-- Tab: Topology Map -->
    <div class="tab-panel active" id="tab-topology">
      <div class="topo-container" id="topoContainer">
        <svg class="topo-svg" id="topoSvg"></svg>
        <div class="topo-tooltip" id="topoTooltip"></div>
        <div class="topo-detail-panel" id="topoDetailPanel">
          <button class="topo-detail-close" id="topoDetailClose">&times;</button>
          <div id="topoDetailContent"></div>
        </div>
        <div class="topo-legend">
          <div class="topo-legend-item"><div class="topo-legend-dot" style="background:var(--teal)"></div> Running</div>
          <div class="topo-legend-item"><div class="topo-legend-dot" style="background:var(--red)"></div> Stopped</div>
          <div class="topo-legend-item"><div class="topo-legend-dot" style="background:var(--amber)"></div> Paused</div>
          <div class="topo-legend-item"><div class="topo-legend-rect" style="background:var(--bg-card);border:1px solid var(--border-focus)"></div> Node</div>
          <div class="topo-legend-item"><div class="topo-legend-rect" style="background:var(--bg-elevated);border:1px solid var(--border)"></div> Storage</div>
        </div>
      </div>
    </div>

    <!-- Tab: Active Plan -->
    <div class="tab-panel" id="tab-plan">
      <div class="card">
        <div id="planContent">
          <div class="empty-state">
            <div class="icon">&#9675;</div>
            <div>No active plan. The agent is idle.</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab: Resources (VMs + Containers) -->
    <div class="tab-panel" id="tab-resources">

      <!-- Predictive Forecasting -->
      <div class="card">
        <div class="card-head">
          <span class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;opacity:0.6"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            Predictive Forecasting
          </span>
          <span class="card-badge" style="background:var(--teal-muted);color:var(--teal);font-size:0.65rem">BETA</span>
        </div>
        <div class="card-body">
          <div class="predictions-grid" id="predictionsGrid">
            <div class="predictions-empty">Loading predictions...</div>
          </div>
        </div>
      </div>

      <!-- Right-sizing Recommendations -->
      <div class="card">
        <div class="card-head">
          <span class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;opacity:0.6"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="7.5 4.21 12 6.81 16.5 4.21"/><polyline points="7.5 19.79 7.5 14.6 3 12"/><polyline points="21 12 16.5 14.6 16.5 19.79"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
            VM Right-Sizing
          </span>
          <span class="card-badge" id="rightsizingBadge" style="background:var(--teal-muted);color:var(--teal);font-size:0.65rem">BETA</span>
        </div>
        <div class="card-body">
          <div id="rightsizingSummary" class="rightsizing-summary" style="display:none"></div>
          <div class="rightsizing-grid" id="rightsizingGrid">
            <div class="rightsizing-empty">Loading right-sizing analysis...</div>
          </div>
        </div>
      </div>

      <!-- Resource Gauges -->
      <div class="card">
        <div class="card-head">
          <span class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Cluster Resources
          </span>
          <span class="card-badge" id="resourceLastUpdate" style="background:rgba(255,255,255,0.06);color:var(--text-tertiary)">--</span>
        </div>

        <!-- SVG gradient definition for sparklines -->
        <svg style="position:absolute;width:0;height:0">
          <defs>
            <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--teal)" stop-opacity="0.4"/>
              <stop offset="100%" stop-color="var(--teal)" stop-opacity="0"/>
            </linearGradient>
          </defs>
        </svg>

        <div class="resource-gauges">
          <!-- CPU Gauge -->
          <div class="gauge-card">
            <div class="gauge-svg">
              <svg viewBox="0 0 100 100">
                <circle class="gauge-track" cx="50" cy="50" r="42"/>
                <circle class="gauge-fill" id="gaugeCpuFill" cx="50" cy="50" r="42"
                  stroke="var(--teal)"
                  stroke-dasharray="0 264"
                />
              </svg>
              <div class="gauge-pct"><span id="gaugeCpuPct">--</span><span class="gauge-pct-unit">%</span></div>
            </div>
            <div class="gauge-label">CPU</div>
            <div class="gauge-detail" id="gaugeCpuDetail">-- cores</div>
          </div>
          <!-- RAM Gauge -->
          <div class="gauge-card">
            <div class="gauge-svg">
              <svg viewBox="0 0 100 100">
                <circle class="gauge-track" cx="50" cy="50" r="42"/>
                <circle class="gauge-fill" id="gaugeRamFill" cx="50" cy="50" r="42"
                  stroke="var(--teal)"
                  stroke-dasharray="0 264"
                />
              </svg>
              <div class="gauge-pct"><span id="gaugeRamPct">--</span><span class="gauge-pct-unit">%</span></div>
            </div>
            <div class="gauge-label">RAM</div>
            <div class="gauge-detail" id="gaugeRamDetail">-- GB used / -- GB</div>
          </div>
          <!-- Disk Gauge -->
          <div class="gauge-card">
            <div class="gauge-svg">
              <svg viewBox="0 0 100 100">
                <circle class="gauge-track" cx="50" cy="50" r="42"/>
                <circle class="gauge-fill" id="gaugeDiskFill" cx="50" cy="50" r="42"
                  stroke="var(--teal)"
                  stroke-dasharray="0 264"
                />
              </svg>
              <div class="gauge-pct"><span id="gaugeDiskPct">--</span><span class="gauge-pct-unit">%</span></div>
            </div>
            <div class="gauge-label">Disk</div>
            <div class="gauge-detail" id="gaugeDiskDetail">-- GB used / -- GB</div>
          </div>
        </div>

        <!-- Sparklines -->
        <div class="sparklines-section">
          <div class="sparkline-card">
            <div class="sparkline-header">
              <span class="sparkline-title">CPU History</span>
              <span class="sparkline-value" id="sparkCpuVal">--%</span>
            </div>
            <svg class="sparkline-svg" id="sparkCpuSvg" viewBox="0 0 200 40" preserveAspectRatio="none">
              <path class="sparkline-area" d=""/>
              <polyline class="sparkline-line" points=""/>
            </svg>
          </div>
          <div class="sparkline-card">
            <div class="sparkline-header">
              <span class="sparkline-title">RAM History</span>
              <span class="sparkline-value" id="sparkRamVal">--%</span>
            </div>
            <svg class="sparkline-svg" id="sparkRamSvg" viewBox="0 0 200 40" preserveAspectRatio="none">
              <path class="sparkline-area" d=""/>
              <polyline class="sparkline-line" points=""/>
            </svg>
          </div>
          <div class="sparkline-card">
            <div class="sparkline-header">
              <span class="sparkline-title">Disk History</span>
              <span class="sparkline-value" id="sparkDiskVal">--%</span>
            </div>
            <svg class="sparkline-svg" id="sparkDiskSvg" viewBox="0 0 200 40" preserveAspectRatio="none">
              <path class="sparkline-area" d=""/>
              <polyline class="sparkline-line" points=""/>
            </svg>
          </div>
        </div>

        <!-- Per-node breakdown (populated dynamically) -->
        <div class="node-breakdown" id="nodeBreakdown" style="display:none">
          <div class="node-breakdown-title">Per-Node Breakdown</div>
          <div class="node-breakdown-grid" id="nodeBreakdownGrid"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="card-title">Virtual Machines</span>
          <span class="card-badge" id="vmCount" style="background:var(--blue-muted);color:var(--blue)">0</span>
        </div>
        <div class="card-body flush">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Node</th>
                  <th>CPU</th>
                  <th>RAM</th>
                </tr>
              </thead>
              <tbody id="vmTable">
                <tr><td colspan="6" style="text-align:center;color:var(--text-tertiary);padding:24px">Loading...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="card-title">Containers</span>
          <span class="card-badge" id="ctCount" style="background:var(--purple-muted);color:var(--purple)">0</span>
        </div>
        <div class="card-body flush">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Node</th>
                  <th>CPU</th>
                  <th>RAM</th>
                </tr>
              </thead>
              <tbody id="ctTable">
                <tr><td colspan="6" style="text-align:center;color:var(--text-tertiary);padding:24px">Loading...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab: Nodes -->
    <div class="tab-panel" id="tab-nodes">
      <div class="card">
        <div class="card-body">
          <div class="nodes-grid" id="nodesGrid">
            <div style="color:var(--text-tertiary);font-size:0.78rem">Loading node data...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab: Incidents -->
    <div class="tab-panel" id="tab-incidents">
      <div id="healingBanners"></div>
      <div class="incidents-section">
        <div class="incidents-section-title">Active Incidents</div>
        <div id="activeIncidents">
          <div class="incidents-empty">
            <div class="empty-icon">&#9711;</div>
            No active incidents — all clear
          </div>
        </div>
      </div>
      <div class="incidents-section" style="border-top:1px solid var(--border)">
        <div class="incidents-section-title">Recent Incidents</div>
        <div id="recentIncidents">
          <div class="incidents-empty">
            <div class="empty-icon">&#9711;</div>
            No recent incidents
          </div>
        </div>
      </div>
    </div>

    <!-- Tab: Governance -->
    <div class="tab-panel" id="tab-governance">
      <div class="card">
        <div class="card-head">
          <span class="card-title">Governance &amp; Safety</span>
        </div>
        <div class="card-body">
          <div class="gov-grid" id="govGrid">
            <div class="gov-item">
              <div class="gov-label">Circuit Breaker</div>
              <div class="gov-value ok" id="govCircuit">Closed</div>
            </div>
            <div class="gov-item">
              <div class="gov-label">Total Actions</div>
              <div class="gov-value neutral" id="govTotal">0</div>
            </div>
            <div class="gov-item">
              <div class="gov-label">Failures</div>
              <div class="gov-value neutral" id="govFail">0</div>
            </div>
            <div class="gov-item">
              <div class="gov-label">Approvals Pending</div>
              <div class="gov-value neutral" id="govPending">0</div>
            </div>
            <div class="gov-item">
              <div class="gov-label">Replans</div>
              <div class="gov-value neutral" id="govReplans">0</div>
            </div>
            <div class="gov-item">
              <div class="gov-label">Uptime</div>
              <div class="gov-value neutral" id="govUptime">-</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="card-title">Audit Trail</span>
          <span class="card-badge" id="auditCount" style="background:rgba(255,255,255,0.06);color:var(--text-secondary)">0</span>
        </div>
        <div class="card-body flush">
          <div class="audit-list" id="auditList">
            <div style="text-align:center;color:var(--text-tertiary);padding:24px;font-size:0.78rem">No audit entries</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab: Chaos Engineering -->
    <div class="tab-panel" id="tab-chaos">
      <div class="card">
        <div class="card-head">
          <span class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;opacity:0.6"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            Chaos Engineering
          </span>
          <span class="card-badge" style="background:var(--red-muted);color:var(--red);font-size:0.65rem">DESTRUCTIVE</span>
        </div>
        <div class="card-body">
          <!-- Scenario selector -->
          <div class="chaos-controls">
            <div class="chaos-field">
              <label>Scenario</label>
              <select id="chaosScenarioSelect"><option value="">Loading...</option></select>
            </div>
            <div class="chaos-field">
              <label>Target VM</label>
              <select id="chaosTargetSelect"><option value="">Select target...</option></select>
            </div>
            <div class="chaos-actions">
              <button class="btn-simulate" id="chaosSimulateBtn" onclick="chaosSimulate()" disabled>Simulate</button>
              <button class="btn-execute-chaos" id="chaosExecuteBtn" onclick="chaosExecute()" disabled>Execute</button>
            </div>
          </div>

          <!-- Simulation results -->
          <div class="chaos-sim-results" id="chaosSimResults">
            <div class="chaos-sim-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              Blast Radius Simulation
            </div>
            <div class="chaos-blast-list" id="chaosBlastList"></div>
            <div class="chaos-sim-stats" id="chaosSimStats"></div>
            <div class="chaos-sim-recommendation" id="chaosSimRec"></div>
          </div>

          <!-- Live execution view -->
          <div class="chaos-execution" id="chaosExecution">
            <div class="chaos-exec-header">
              <span class="chaos-exec-status-badge executing" id="chaosExecBadge">Executing</span>
              <span class="chaos-exec-timer" id="chaosExecTimer">00:00</span>
            </div>
            <div class="chaos-exec-phases" id="chaosExecPhases">
              <div class="chaos-phase" data-phase="executing"></div>
              <div class="chaos-phase" data-phase="recovering"></div>
              <div class="chaos-phase" data-phase="verifying"></div>
              <div class="chaos-phase" data-phase="completed"></div>
            </div>
            <div class="chaos-exec-log" id="chaosExecLog"></div>
          </div>

          <!-- Results comparison -->
          <div class="chaos-results" id="chaosResults">
            <div class="chaos-verdict" id="chaosVerdict">
              <div class="chaos-verdict-label">Verdict</div>
              <div class="chaos-verdict-value pass" id="chaosVerdictValue">PASS</div>
            </div>
            <div class="chaos-resilience-score">
              <div class="chaos-resilience-number" id="chaosResilienceScore">--</div>
              <div class="chaos-resilience-label">Resilience Score</div>
            </div>
            <div class="chaos-comparison" id="chaosComparison"></div>
            <div style="font-size:0.78rem;font-weight:600;color:var(--text-secondary);margin-bottom:8px">What happened</div>
            <div class="chaos-event-log" id="chaosEventLog"></div>
          </div>
        </div>
      </div>

      <!-- Chaos history -->
      <div class="card">
        <div class="card-head">
          <span class="card-title">Past Chaos Runs</span>
          <span class="card-badge" id="chaosHistoryCount" style="background:rgba(255,255,255,0.06);color:var(--text-secondary)">0</span>
        </div>
        <div class="card-body flush">
          <div id="chaosHistoryList">
            <div style="text-align:center;color:var(--text-tertiary);padding:24px;font-size:0.78rem">No past chaos runs</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Right Column: Event Stream -->
  <div class="col-right">
    <div class="card" style="border-bottom:none;height:100%;display:flex;flex-direction:column">
      <div class="card-head">
        <span class="card-title">Event Stream</span>
        <span class="card-badge" id="eventCount" style="background:rgba(255,255,255,0.06);color:var(--text-secondary)">0</span>
      </div>
      <div class="event-log" id="eventLog">
        <div class="event-log-empty" id="eventEmpty"><div class="empty-pulse"></div>Waiting for events...</div>
      </div>
    </div>
  </div>
</div>

<script>
// ── State ──────────────────────────────────────────────
const state = {
  connected: false,
  mode: 'watch',
  events: [],
  plan: null,        // current plan data (goal, reasoning, steps, etc.)
  planSteps: {},     // step_id -> { status, duration_ms, error }
  planCompleted: 0,  // count of completed steps
  planFailed: 0,     // count of failed steps
  planGoals: {},     // plan_id -> goal text (for audit grouping)
  cluster: null,
  startTime: Date.now(),
  replans: 0,
  failures: 0,
  totalActions: 0,
  currentPlanId: null,
  incidents: {
    active: [],   // open or healing incidents
    recent: [],   // resolved or failed incidents (last 20)
    patterns: [], // learned patterns
    expanded: {}, // id -> true if timeline is expanded
    timelines: {}, // id -> timeline entries (cached)
  },
  healingBanners: [], // { type: 'paused'|'escalated', message, id }
  healthHistory: [],  // last 30 ClusterHealthSummary objects for sparklines
  lastHealth: null,   // most recent health_check data
  approvals: {
    // plan_id -> PendingApprovalEntry (full row as returned by the server)
    pending: {},
    // plan_id -> { decision, operator, timestamp } once resolved (used to
    // briefly show a state pill in place of buttons before the card fades).
    decisions: {},
    // plan_id -> 'approve'|'reject' while a POST is in flight (suppresses
    // re-clicks and surfaces a spinner).
    inFlight: {},
    // plan_id -> error string from the last failed POST.
    errors: {},
  },
  remediate: {
    // incident_id -> 'pending'|'done' (drives Remediate button state).
    state: {},
  },
};

// ── SSE Connection ─────────────────────────────────────
let evtSource = null;
let reconnectTimer = null;

function parseSsePayload(eventType, e) {
  if (!e || typeof e.data !== 'string') return null;
  try {
    return JSON.parse(e.data);
  } catch (err) {
    console.warn('[dashboard] Ignoring malformed SSE payload for ' + eventType, err);
    return null;
  }
}

function bindParsedEvent(eventType, handler) {
  evtSource.addEventListener(eventType, (e) => {
    const parsed = parseSsePayload(eventType, e);
    if (parsed === null) return;
    handler(parsed);
  });
}

function connect() {
  if (evtSource) { try { evtSource.close(); } catch {} }

  evtSource = new EventSource('/api/agent/events');

  evtSource.addEventListener('connected', (e) => {
    state.connected = true;
    updateConnStatus();
  });

  const planAndIncidentEvents = [
    'plan_created',
    'plan_approved',
    'plan_rejected',
    'step_started',
    'step_completed',
    'step_failed',
    'replan',
    'approval_requested',
    'circuit_breaker_tripped',
    'investigation_started',
    'investigation_complete',
    'incident_opened',
    'incident_action',
    'incident_resolved',
    'incident_failed',
    'incident_rca',
    'healing_started',
    'healing_completed',
    'healing_failed',
    'healing_paused',
    'healing_escalated',
  ];

  for (const eventType of planAndIncidentEvents) {
    bindParsedEvent(eventType, handleEvent);
  }

  // Pending-approval lifecycle: push new pending plans into the panel and
  // remove/transition cards when a decision lands. The PlanApproved /
  // PlanRejected events are already in planAndIncidentEvents so they
  // flow through handleEvent for the audit/event-log path; the extra
  // listeners below mutate the approvals panel directly.
  bindParsedEvent('awaiting_approval', (evt) => {
    const entry = (evt && evt.data) ? evt.data : evt;
    handleAwaitingApproval(entry);
  });
  bindParsedEvent('plan_approved', (evt) => {
    const d = evt.data || evt;
    handlePlanDecisionBroadcast(d, 'approve');
  });
  bindParsedEvent('plan_rejected', (evt) => {
    const d = evt.data || evt;
    handlePlanDecisionBroadcast(d, 'reject');
  });

  const chaosEvents = [
    'chaos_simulated',
    'chaos_started',
    'chaos_recovery_detected',
    'chaos_completed',
    'chaos_failed',
  ];
  for (const eventType of chaosEvents) {
    bindParsedEvent(eventType, (payload) => handleChaosEvent(eventType, payload));
  }

  // Health check events — update gauges, sparklines, stat cards
  bindParsedEvent('health_check', (evt) => {
    const d = evt.data || evt;
    handleHealthCheck(d);
  });

  evtSource.onerror = () => {
    state.connected = false;
    updateConnStatus();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };
}

function handleEvent(event) {
  state.events.push(event);
  state.totalActions++;
  const d = event.data || {};

  switch (event.type) {
    case 'plan_created':
    case 'replan':
      state.plan = d;
      state.currentPlanId = d.plan_id || d.new_plan_id;
      state.planSteps = {};
      state.planCompleted = 0;
      state.planFailed = 0;
      if (d.goal) state.planGoals[d.plan_id || d.new_plan_id] = d.goal;
      if (d.steps) {
        d.steps.forEach(s => { state.planSteps[s.id] = { status: 'pending' }; });
      }
      if (event.type === 'replan') state.replans++;
      if (d.mode) { state.mode = d.mode; updateMode(); }
      break;

    case 'step_started':
      if (state.planSteps[d.step_id]) {
        state.planSteps[d.step_id].status = 'running';
      } else {
        state.planSteps[d.step_id] = { status: 'running' };
      }
      break;

    case 'step_completed':
      if (state.planSteps[d.step_id]) {
        state.planSteps[d.step_id].status = 'success';
        state.planSteps[d.step_id].duration_ms = d.duration_ms;
        if (d.output !== undefined) state.planSteps[d.step_id].output = d.output;
      }
      state.planCompleted++;
      break;

    case 'step_failed':
      if (state.planSteps[d.step_id]) {
        state.planSteps[d.step_id].status = 'failed';
        state.planSteps[d.step_id].error = d.error;
        state.planSteps[d.step_id].duration_ms = d.duration_ms;
      }
      state.planFailed++;
      state.failures++;
      break;

    case 'circuit_breaker_tripped':
      // Mark remaining pending steps as skipped
      Object.values(state.planSteps).forEach(s => {
        if (s.status === 'pending') s.status = 'skipped';
      });
      break;

    case 'incident_opened':
      handleIncidentOpened(d);
      break;

    case 'incident_action':
      handleIncidentAction(d);
      break;

    case 'incident_resolved':
      handleIncidentResolved(d);
      break;

    case 'incident_failed':
      handleIncidentFailed(d);
      break;

    case 'incident_rca':
      handleIncidentRca(d);
      break;

    case 'healing_started':
      handleHealingStarted(d);
      break;

    case 'healing_completed':
      handleHealingCompleted(d);
      break;

    case 'healing_failed':
      handleHealingFailed(d);
      break;

    case 'healing_paused':
      handleHealingPaused(d);
      break;

    case 'healing_escalated':
      handleHealingEscalated(d);
      break;
  }

  renderEvent(event);
  renderPlan();
  updateGov();

  const el = document.getElementById('eventCount');
  if (el) el.textContent = state.events.length;
}

// ── Rendering ──────────────────────────────────────────

function updateConnStatus() {
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');
  if (state.connected) {
    dot.className = 'conn-dot live';
    label.textContent = 'Live';
  } else {
    dot.className = 'conn-dot dead';
    label.textContent = 'Reconnecting...';
  }
}

function updateMode() {
  const pill = document.getElementById('modePill');
  pill.textContent = state.mode.toUpperCase();
  pill.className = 'mode-pill ' + state.mode;
}

// Track current event group
let currentGroupId = null;
let currentGroupEl = null;
let eventGroups = {}; // planId -> { el, goal, steps, completed, failed, total }

function ensureEventGroup(planId, goal, stepCount) {
  const log = document.getElementById('eventLog');
  const empty = document.getElementById('eventEmpty');
  if (empty) empty.remove();

  if (eventGroups[planId]) {
    currentGroupId = planId;
    currentGroupEl = eventGroups[planId].el;
    return;
  }

  const group = document.createElement('div');
  group.className = 'event-group';
  group.id = 'evg-' + planId;

  const chevron = '<svg class="event-group-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 4l4 4-4 4"/></svg>';

  const header = document.createElement('div');
  header.className = 'event-group-header';
  header.innerHTML =
    chevron +
    '<span class="event-group-goal">' + escapeHtml(goal || 'Plan ' + (planId || '').slice(0, 8)) + '</span>' +
    '<div class="event-group-summary" id="evg-sum-' + planId + '">' +
      '<span class="event-group-stat steps">' + (stepCount || '?') + ' steps</span>' +
      '<span class="event-group-result running"></span>' +
    '</div>';
  header.onclick = function() { group.classList.toggle('collapsed'); };

  const items = document.createElement('div');
  items.className = 'event-group-items';

  group.appendChild(header);
  group.appendChild(items);
  log.appendChild(group);

  eventGroups[planId] = { el: group, itemsEl: items, goal: goal, total: stepCount || 0, completed: 0, failed: 0 };
  currentGroupId = planId;
  currentGroupEl = eventGroups[planId].el;
}

function updateGroupSummary(planId) {
  const g = eventGroups[planId];
  if (!g) return;

  const total = g.total;
  const done = g.completed;
  const fail = g.failed;
  const isComplete = total > 0 && (done + fail) >= total;
  const allSuccess = isComplete && fail === 0;

  let resultClass = 'running';
  if (isComplete) resultClass = allSuccess ? 'success' : 'failed';

  let html = '<span class="event-group-stat steps">' + total + ' steps</span>';
  if (done > 0) html += '<span class="event-group-stat ok">' + done + ' ok</span>';
  if (fail > 0) html += '<span class="event-group-stat fail">' + fail + ' err</span>';
  html += '<span class="event-group-result ' + resultClass + '"></span>';

  const sumEl = document.getElementById('evg-sum-' + planId);
  if (sumEl) sumEl.innerHTML = html;

  // Collapse when done
  if (isComplete) {
    g.el.classList.add('collapsed');
  }
}

function renderEvent(event) {
  const d = event.data || {};
  const ts = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const ev = formatEvent(event);
  if (!ev) return; // suppressed event

  // Determine which group this belongs to
  if (event.type === 'plan_created') {
    ensureEventGroup(d.plan_id, d.goal, d.step_count);
  } else if (event.type === 'replan') {
    // Collapse old group, start new one
    if (eventGroups[d.old_plan_id]) {
      eventGroups[d.old_plan_id].el.classList.add('collapsed');
    }
    ensureEventGroup(d.new_plan_id, eventGroups[d.old_plan_id]?.goal || d.goal, d.step_count);
  }

  // Track step completion in group
  const groupPlanId = currentGroupId;
  if (groupPlanId && eventGroups[groupPlanId]) {
    if (event.type === 'step_completed') {
      eventGroups[groupPlanId].completed++;
      updateGroupSummary(groupPlanId);
    } else if (event.type === 'step_failed') {
      eventGroups[groupPlanId].failed++;
      updateGroupSummary(groupPlanId);
    } else if (event.type === 'replan' && eventGroups[d.new_plan_id]) {
      eventGroups[d.new_plan_id].total = d.step_count || 0;
      updateGroupSummary(d.new_plan_id);
    }
  }

  // Build event item
  const item = document.createElement('div');
  item.className = 'event-item';

  let detailHtml = '';
  if (ev.detail) {
    detailHtml = '<div class="event-detail' + (ev.isError ? ' error-detail' : '') + '">' + escapeHtml(ev.detail) + '</div>';
  }

  let durationHtml = '';
  if (d.duration_ms !== undefined) {
    durationHtml = '<span class="event-duration">' + d.duration_ms + 'ms</span>';
  }

  item.innerHTML =
    '<div class="event-item-row">' +
      '<div class="event-icon ' + ev.iconClass + '">' + ev.icon + '</div>' +
      '<div class="event-body">' +
        '<div class="event-title">' + ev.title + durationHtml + '</div>' +
        detailHtml +
      '</div>' +
      '<span class="event-ts">' + ts + '</span>' +
    '</div>';

  // Append to group or directly to log
  if (groupPlanId && eventGroups[groupPlanId]) {
    eventGroups[groupPlanId].itemsEl.appendChild(item);
  } else {
    const log = document.getElementById('eventLog');
    const empty = document.getElementById('eventEmpty');
    if (empty) empty.remove();
    log.appendChild(item);
  }

  // Scroll to bottom
  const log = document.getElementById('eventLog');
  log.scrollTop = log.scrollHeight;
}

function formatEvent(event) {
  const d = event.data || {};
  switch (event.type) {
    case 'plan_created':
      return {
        iconClass: 'plan', icon: '&#9656;',
        title: 'Plan created <span class="event-action">' + (d.step_count || 0) + ' steps</span>',
        detail: d.goal || null,
      };
    case 'plan_approved':
      return {
        iconClass: 'ok', icon: '&#10003;',
        title: 'Plan approved',
      };
    case 'plan_rejected':
      return {
        iconClass: 'err', icon: '&#10007;',
        title: 'Plan rejected',
        detail: d.operator ? 'by ' + escapeHtml(d.operator) : null,
      };
    case 'step_started':
      return {
        iconClass: 'step', icon: '&#9654;',
        title: 'Executing <span class="event-action">' + escapeHtml(d.action || '') + '</span>',
        detail: d.description || null,
      };
    case 'step_completed':
      return {
        iconClass: 'ok', icon: '&#10003;',
        title: 'Completed <span class="event-action">' + escapeHtml(d.action || '') + '</span>',
      };
    case 'step_failed':
      return {
        iconClass: 'err', icon: '&#10007;',
        title: 'Failed <span class="event-action">' + escapeHtml(d.action || '') + '</span>',
        detail: d.error ? (d.error.length > 150 ? d.error.slice(0, 150) + '...' : d.error) : null,
        isError: true,
      };
    case 'replan':
      return {
        iconClass: 'warn', icon: '&#8635;',
        title: 'Replanning <span class="event-action">' + (d.step_count || '?') + ' new steps</span>',
        detail: d.reasoning ? d.reasoning.slice(0, 120) : null,
      };
    case 'approval_requested':
      return {
        iconClass: 'warn', icon: '&#9888;',
        title: d.action ? 'Approval required for <span class="event-action">' + escapeHtml(d.action) + '</span>' : 'Approval required',
        detail: d.tier ? 'Tier: ' + d.tier + (d.mode ? ' | Mode: ' + d.mode : '') : null,
      };
    case 'circuit_breaker_tripped':
      return {
        iconClass: 'err', icon: '&#9889;',
        title: 'Circuit breaker tripped',
        detail: 'Execution halted — too many consecutive failures',
        isError: true,
      };
    case 'investigation_started':
      return {
        iconClass: 'info', icon: '&#128269;',
        title: 'Investigation started',
        detail: d.trigger || null,
      };
    case 'investigation_complete':
      return {
        iconClass: 'ok', icon: '&#128270;',
        title: 'Investigation complete <span class="event-action">' + (d.findings_count || 0) + ' findings</span>',
        detail: d.root_cause ? 'Root cause: ' + d.root_cause.slice(0, 120) : null,
      };
    // ── Incident Events ──
    case 'incident_opened':
      return {
        iconClass: 'warn', icon: '&#9888;',
        title: 'Incident opened',
        detail: (d.anomaly_message || d.message || 'Anomaly detected') + (d.severity ? ' — ' + d.severity : ''),
      };
    case 'incident_action':
      return {
        iconClass: d.success ? 'ok' : 'err', icon: d.success ? '&#10003;' : '&#10007;',
        title: d.success ? 'Healing action succeeded' : 'Healing action failed',
        detail: d.action || d.detail || null,
        isError: !d.success,
      };
    case 'incident_resolved':
      return {
        iconClass: 'ok', icon: '&#10003;',
        title: 'Incident resolved',
        detail: d.resolution || d.message || 'All actions completed successfully',
      };
    case 'incident_failed':
      return {
        iconClass: 'err', icon: '&#10007;',
        title: 'Incident failed',
        detail: d.error || d.message || 'Healing was unsuccessful',
        isError: true,
      };
    case 'incident_rca':
      return {
        iconClass: 'info', icon: '&#128269;',
        title: 'AI Root Cause Analysis <span class="event-action">' + escapeHtml(d.confidence || '') + ' confidence</span>',
        detail: d.root_cause ? escapeHtml(d.root_cause.slice(0, 200)) + (d.recommended_action ? ' — Recommendation: ' + escapeHtml(d.recommended_action.slice(0, 150)) : '') : null,
      };

    // ── Healing Events ──
    case 'healing_started':
      return {
        iconClass: 'step', icon: '&#9889;',
        title: 'Healing started',
        detail: d.playbook_name ? 'Playbook: ' + d.playbook_name : (d.playbook_id || null),
      };
    case 'healing_completed':
      return {
        iconClass: 'ok', icon: '&#10003;',
        title: 'Healing completed',
        detail: d.playbook_name || d.message || null,
      };
    case 'healing_failed':
      return {
        iconClass: 'err', icon: '&#10007;',
        title: 'Healing failed',
        detail: d.error || d.message || null,
        isError: true,
      };
    case 'healing_escalated':
      return {
        iconClass: 'err', icon: '&#9888;',
        title: 'Healing escalated — manual intervention needed',
        detail: d.reason || null,
        isError: true,
      };
    case 'healing_paused':
      return {
        iconClass: 'warn', icon: '&#9724;',
        title: 'Healing paused — circuit breaker triggered',
        detail: d.reason || 'Too many consecutive failures',
      };
    case 'playbook_matched':
      return {
        iconClass: 'info', icon: '&#128214;',
        title: 'Playbook matched: <span class="event-action">' + escapeHtml((d.playbook_names || [])[0] || d.playbook_id || '?') + '</span>',
        detail: d.anomaly_metric ? d.anomaly_metric + ' — ' + (d.anomaly_severity || '') : null,
      };
    case 'playbook_executed':
      return {
        iconClass: d.success ? 'ok' : 'err', icon: d.success ? '&#10003;' : '&#10007;',
        title: (d.success ? 'Playbook succeeded' : 'Playbook failed'),
        detail: d.playbook_id || null,
        isError: !d.success,
      };
    case 'playbook_cooldown':
      return {
        iconClass: 'info', icon: '&#9202;',
        title: 'Playbook on cooldown',
        detail: (d.playbook_name || d.playbook_id) + ' — skipped (too recent)',
      };

    // ── Chaos Events ──
    case 'chaos_simulated':
      return {
        iconClass: 'info', icon: '&#127922;',
        title: 'Chaos simulated — <span class="event-action">' + (d.total_affected || 0) + ' VM(s) affected</span>',
        detail: 'Risk: ' + (d.risk_score || 0) + '/100 · Recovery: ~' + (d.predicted_recovery_s || '?') + 's',
      };
    case 'chaos_started':
      return {
        iconClass: 'warn', icon: '&#9889;',
        title: 'Chaos started: <span class="event-action">' + escapeHtml(d.scenario_name || d.scenario_id || '') + '</span>',
        detail: 'Severity: ' + (d.severity || 'medium'),
      };
    case 'chaos_recovery_detected':
      return {
        iconClass: 'info', icon: '&#128260;',
        title: 'Recovery in progress',
        detail: d.message || 'Failures injected, waiting for healing',
      };
    case 'chaos_completed':
      return {
        iconClass: d.verdict === 'pass' ? 'ok' : (d.verdict === 'partial' ? 'warn' : 'err'),
        icon: d.verdict === 'pass' ? '&#10003;' : (d.verdict === 'partial' ? '&#9888;' : '&#10007;'),
        title: 'Chaos completed — <span class="event-action">' + ((d.verdict || 'unknown').toUpperCase()) + '</span>',
        detail: 'Resilience: ' + (d.resilience_pct || 0) + '% · Actual recovery: ' + (d.actual_recovery_s || '?') + 's vs predicted ' + (d.predicted_recovery_s || '?') + 's',
      };
    case 'chaos_failed':
      return {
        iconClass: 'err', icon: '&#10007;',
        title: 'Chaos failed',
        detail: d.error || 'Scenario execution encountered an error',
        isError: true,
      };

    // ── Health Events ──
    case 'health_check':
      return {
        iconClass: 'info', icon: '&#9829;',
        title: (d.nodes ? d.nodes.online + '/' + d.nodes.total + ' nodes' : '') + ' · ' + (d.vms ? d.vms.running + ' running VMs' : ''),
        detail: d.resources ? 'CPU ' + (d.resources.cpu_usage_pct || 0).toFixed(1) + '% · RAM ' + (d.resources.ram_usage_pct || 0).toFixed(1) + '%' : null,
      };
    case 'healing_tick':
      return null; // suppress noisy tick events
    case 'metric_recorded':
      return null; // suppress metric batch events

    default:
      return {
        iconClass: 'info', icon: '&#8226;',
        title: event.type.replace(/_/g, ' '),
        detail: null,
      };
  }
}

function renderPlan() {
  const el = document.getElementById('planContent');
  if (!state.plan) {
    el.innerHTML = '<div class="empty-state"><div class="icon">&#9675;</div><div>No active plan. The agent is idle.</div></div>';
    return;
  }

  const p = state.plan;
  const steps = p.steps || [];
  const total = steps.length || p.step_count || 0;
  const done = state.planCompleted;
  const failed = state.planFailed;
  const progressPct = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;
  const isComplete = total > 0 && (done + failed) >= total;
  const allSuccess = isComplete && failed === 0;

  // Mode icon
  const modeIcons = { build: '&#9881;', watch: '&#9673;', investigate: '&#128269;', heal: '&#9889;' };
  const mode = p.mode || state.mode || 'build';
  const modeIcon = modeIcons[mode] || '&#9881;';

  let html = '';

  // Completion banner
  if (isComplete) {
    if (allSuccess) {
      html += '<div class="plan-complete-banner success">&#10003; Plan completed successfully &mdash; ' + done + '/' + total + ' steps</div>';
    } else {
      html += '<div class="plan-complete-banner partial">&#9888; Plan finished with ' + failed + ' failure' + (failed > 1 ? 's' : '') + ' &mdash; ' + done + ' succeeded, ' + failed + ' failed</div>';
    }
  }

  // Replan indicator
  if (state.replans > 0) {
    html += '<div class="plan-replan-banner"><span class="replan-icon">&#8635;</span> Replanned ' + state.replans + ' time' + (state.replans > 1 ? 's' : '') + '</div>';
  }

  // Header
  html += '<div class="plan-header">';
  html += '<div class="plan-goal-row">';
  html += '<div class="plan-mode-icon ' + mode + '">' + modeIcon + '</div>';
  html += '<div class="plan-goal-text">';
  html += '<div class="plan-goal">' + escapeHtml(p.goal || 'Unnamed goal') + '</div>';
  if (p.reasoning) {
    html += '<div class="plan-reasoning">' + escapeHtml(p.reasoning) + '</div>';
  }
  html += '</div>';
  html += '</div>';

  // Meta row with progress
  html += '<div class="plan-meta">';
  html += '<span class="plan-meta-item"><span class="meta-dot" style="background:var(--blue)"></span> ' + total + ' steps</span>';
  html += '<span class="plan-meta-item"><span class="meta-dot" style="background:var(--green)"></span> ' + done + ' done</span>';
  if (failed > 0) {
    html += '<span class="plan-meta-item"><span class="meta-dot" style="background:var(--red)"></span> ' + failed + ' failed</span>';
  }
  html += '<div class="plan-progress-bar"><div class="plan-progress-fill' + (failed > 0 ? ' has-failures' : '') + '" style="width:' + progressPct + '%"></div></div>';
  html += '<span style="font-family:var(--font-mono);font-size:0.68rem">' + progressPct + '%</span>';
  html += '</div>';
  html += '</div>';

  // Pipeline steps
  if (steps.length > 0) {
    html += '<div class="pipeline">';
    steps.forEach((step, i) => {
      const stepState = state.planSteps[step.id] || { status: 'pending' };
      const status = stepState.status;
      const tierClass = (step.tier || 'read').replace(' ', '_');

      // Step number icon
      let numContent = '' + (i + 1);
      if (status === 'success') numContent = '&#10003;';
      if (status === 'failed') numContent = '&#10007;';
      if (status === 'running') numContent = '<span class="spinner" style="width:12px;height:12px;border-width:1.5px"></span>';

      html += '<div class="pipe-step ' + status + '">';
      html += '<div class="pipe-step-gutter">';
      html += '<div class="pipe-step-number">' + numContent + '</div>';
      html += '<div class="pipe-step-line"></div>';
      html += '</div>';
      html += '<div class="pipe-step-content">';
      html += '<div class="pipe-step-action">' + escapeHtml(step.action || 'Unknown') + '</div>';
      if (step.description) {
        html += '<div class="pipe-step-desc">' + escapeHtml(step.description) + '</div>';
      }
      html += '<div class="pipe-step-meta">';
      html += '<span class="pipe-step-tier ' + tierClass + '">' + escapeHtml(step.tier || 'read') + '</span>';
      if (stepState.duration_ms !== undefined) {
        html += '<span class="pipe-step-duration">' + stepState.duration_ms + 'ms</span>';
      }
      html += '</div>';
      if (stepState.error) {
        html += '<div class="pipe-step-error">' + escapeHtml(stepState.error.length > 200 ? stepState.error.slice(0, 200) + '...' : stepState.error) + '</div>';
      }
      if (stepState.output !== undefined && stepState.status === 'success') {
        const outId = 'step-out-' + step.id.replace(/[^a-zA-Z0-9]/g, '');
        const chevSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 4l4 4-4 4"/></svg>';
        html += '<button class="step-output-toggle" onclick="toggleStepOutput(this, \\'' + outId + '\\')">' + chevSvg + ' View output</button>';
        html += '<div class="step-output" id="' + outId + '" style="display:none">' + formatStepOutput(stepState.output) + '</div>';
      }
      html += '</div>';
      html += '</div>';
    });
    html += '</div>';
  }

  el.innerHTML = html;
}

function renderCluster(data) {
  if (!data) return;
  state.cluster = data;

  // Stats
  const vms = data.vms || [];
  const cts = data.containers || [];
  const nodes = data.nodes || [];
  const running = vms.filter(v => v.status === 'running').length + cts.filter(c => c.status === 'running').length;

  setText('statNodes', nodes.length);
  setText('statVMs', vms.length);
  setText('statCTs', cts.length);
  setText('statRunning', running);

  // CPU / RAM averages (fields: cpu_usage_pct, ram_total_mb, ram_used_mb)
  if (nodes.length > 0) {
    const avgCpu = nodes.reduce((s, n) => s + (n.cpu_usage_pct || 0), 0) / nodes.length;
    const avgRam = nodes.reduce((s, n) => {
      if (n.ram_total_mb && n.ram_used_mb) return s + (n.ram_used_mb / n.ram_total_mb * 100);
      return s;
    }, 0) / nodes.length;
    document.getElementById('statCPU').innerHTML = avgCpu.toFixed(1) + '<span class="unit">%</span>';
    document.getElementById('statRAM').innerHTML = avgRam.toFixed(1) + '<span class="unit">%</span>';
  }

  // VM table
  setText('vmCount', vms.length);
  const vmTbody = document.getElementById('vmTable');
  if (vms.length === 0) {
    vmTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-tertiary);padding:24px">No VMs found</td></tr>';
  } else {
    vmTbody.innerHTML = vms.map(vm => {
      const ramMB = vm.ram_mb || 0;
      const cpuCores = vm.cpu_cores || 0;
      const diskGB = vm.disk_gb || 0;
      return '<tr>' +
        '<td style="font-family:var(--font-mono)">' + vm.id + '</td>' +
        '<td style="font-weight:500">' + escapeHtml(vm.name || '-') + '</td>' +
        '<td><span class="status-tag ' + (vm.status || '') + '">' + (vm.status || '-') + '</span></td>' +
        '<td style="color:var(--text-secondary)">' + escapeHtml(vm.node || '-') + '</td>' +
        '<td style="font-family:var(--font-mono)">' + cpuCores + ' cores</td>' +
        '<td style="font-family:var(--font-mono)">' + (ramMB >= 1024 ? (ramMB / 1024).toFixed(1) + ' GB' : ramMB + ' MB') + '</td>' +
        '</tr>';
    }).join('');
  }

  // Container table
  setText('ctCount', cts.length);
  const ctTbody = document.getElementById('ctTable');
  if (cts.length === 0) {
    ctTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-tertiary);padding:24px">No containers found</td></tr>';
  } else {
    ctTbody.innerHTML = cts.map(ct => {
      const ramMB = ct.ram_mb || 0;
      const cpuCores = ct.cpu_cores || 0;
      return '<tr>' +
        '<td style="font-family:var(--font-mono)">' + ct.id + '</td>' +
        '<td style="font-weight:500">' + escapeHtml(ct.name || '-') + '</td>' +
        '<td><span class="status-tag ' + (ct.status || '') + '">' + (ct.status || '-') + '</span></td>' +
        '<td style="color:var(--text-secondary)">' + escapeHtml(ct.node || '-') + '</td>' +
        '<td style="font-family:var(--font-mono)">' + cpuCores + ' cores</td>' +
        '<td style="font-family:var(--font-mono)">' + (ramMB >= 1024 ? (ramMB / 1024).toFixed(1) + ' GB' : ramMB + ' MB') + '</td>' +
        '</tr>';
    }).join('');
  }

  // Nodes grid
  const grid = document.getElementById('nodesGrid');
  if (nodes.length === 0) {
    grid.innerHTML = '<div style="color:var(--text-tertiary);font-size:0.78rem">No nodes found</div>';
  } else {
    grid.innerHTML = nodes.map(n => {
      const online = n.status === 'online';
      const cpu = typeof n.cpu_usage_pct === 'number' ? n.cpu_usage_pct.toFixed(1) + '%' : '-';
      const ramPct = n.ram_total_mb && n.ram_used_mb ? (n.ram_used_mb / n.ram_total_mb * 100).toFixed(1) + '%' : '-';
      const ramGB = n.ram_total_mb ? (n.ram_total_mb / 1024).toFixed(1) + ' GB' : '-';
      return '<div class="node-card">' +
        '<div class="node-name"><span class="dot ' + (online ? 'online' : 'offline') + '"></span>' + escapeHtml(n.name || '-') + '</div>' +
        '<div class="node-stat"><span>CPU</span><span>' + (n.cpu_cores || '-') + ' cores / ' + cpu + '</span></div>' +
        '<div class="node-stat"><span>RAM</span><span>' + ramPct + ' / ' + ramGB + '</span></div>' +
        '<div class="node-stat"><span>Uptime</span><span>' + formatUptime(n.uptime_s) + '</span></div>' +
        '</div>';
    }).join('');
  }
}

function resourceBar(pct) {
  const level = pct > 80 ? 'high' : pct > 50 ? 'medium' : 'low';
  return '<div class="resource-bar"><div class="resource-bar-fill ' + level + '" style="width:' + Math.min(pct, 100) + '%"></div></div>';
}

function updateGov() {
  setText('govTotal', state.totalActions);
  setText('govFail', state.failures);
  setText('govReplans', state.replans);

  const elapsed = Date.now() - state.startTime;
  setText('govUptime', formatDuration(elapsed));
}

// ── Audit ──────────────────────────────────────────────
async function loadAudit() {
  try {
    const [entries, stats] = await Promise.all([
      fetch('/api/audit?limit=100').then(r => r.json()),
      fetch('/api/audit/stats').then(r => r.json()),
    ]);

    const list = document.getElementById('auditList');
    setText('auditCount', Array.isArray(entries) ? entries.length : 0);

    if (stats) {
      if (stats.total !== undefined) setText('govTotal', stats.total);
      if (stats.failed !== undefined) setText('govFail', stats.failed);
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);padding:24px;font-size:0.78rem">No audit entries yet</div>';
      return;
    }

    // Group entries by plan_id
    const planGroups = [];
    const planMap = {};
    const ungrouped = [];

    entries.forEach(e => {
      if (e.plan_id) {
        if (!planMap[e.plan_id]) {
          planMap[e.plan_id] = { plan_id: e.plan_id, entries: [], firstTime: e.timestamp };
          planGroups.push(planMap[e.plan_id]);
        }
        planMap[e.plan_id].entries.push(e);
      } else {
        ungrouped.push(e);
      }
    });

    let html = '';

    // Render grouped plans
    planGroups.forEach((group, gi) => {
      const entries = group.entries;
      const successCount = entries.filter(e => e.result === 'success').length;
      const failCount = entries.filter(e => e.result === 'failed').length;
      const allSuccess = failCount === 0;
      const resultClass = allSuccess ? 'success' : (successCount === 0 ? 'failed' : 'mixed');

      // Use goal from SSE events, or derive from first entry
      const firstEntry = entries[0];
      const goalLabel = state.planGoals[group.plan_id] || firstEntry.reasoning || firstEntry.action || 'Plan ' + group.plan_id.slice(0, 8);
      const planTime = new Date(group.firstTime).toLocaleTimeString('en-US', { hour12: false });
      const totalDuration = entries.reduce((s, e) => s + (e.duration_ms || 0), 0);

      const chevSvg = '<svg class="audit-plan-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 4l4 4-4 4"/></svg>';

      html += '<div class="audit-plan-group" data-plan="' + group.plan_id + '">';
      html += '<div class="audit-plan-header" onclick="toggleAuditPlan(this)">';
      html += chevSvg;
      html += '<span style="font-family:var(--font-mono);font-size:0.64rem;color:var(--text-tertiary);flex-shrink:0">' + planTime + '</span>';
      html += '<span class="audit-plan-goal">' + escapeHtml(goalLabel.length > 80 ? goalLabel.slice(0, 77) + '...' : goalLabel) + '</span>';
      html += '<div class="audit-plan-summary">';
      html += '<span class="audit-plan-stat count">' + entries.length + '</span>';
      if (successCount > 0) html += '<span class="audit-plan-stat ok">' + successCount + '</span>';
      if (failCount > 0) html += '<span class="audit-plan-stat fail">' + failCount + '</span>';
      if (totalDuration > 0) html += '<span style="font-family:var(--font-mono);font-size:0.60rem;color:var(--text-tertiary)">' + totalDuration + 'ms</span>';
      html += '<span class="audit-plan-result ' + resultClass + '"></span>';
      html += '</div>';
      html += '</div>';

      // Steps within this plan
      html += '<div class="audit-plan-steps">';
      entries.forEach((e, i) => {
        html += renderAuditEntry(e, gi + '-' + i);
      });
      html += '</div>';
      html += '</div>';
    });

    // Render ungrouped entries (no plan_id)
    ungrouped.forEach((e, i) => {
      html += renderAuditEntry(e, 'u-' + i);
    });

    list.innerHTML = html;
  } catch (err) {
    console.error('Failed to load audit:', err);
  }
}

function renderAuditEntry(e, idx) {
  const time = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const tierClass = (e.tier || 'read').replace(' ', '_');
  const durationStr = e.duration_ms ? e.duration_ms + 'ms' : '-';

  let detailHtml = '<div class="audit-detail-grid">';
  detailHtml += '<div class="audit-detail-item"><span class="label">Result</span><span class="value ' + (e.result === 'success' ? 'ok' : 'err') + '">' + (e.result || '-') + '</span></div>';
  detailHtml += '<div class="audit-detail-item"><span class="label">Duration</span><span class="value">' + durationStr + '</span></div>';
  detailHtml += '<div class="audit-detail-item"><span class="label">Tier</span><span class="value">' + (e.tier || '-') + '</span></div>';

  if (e.approval) {
    const appr = e.approval;
    const icon = appr.approved ? '&#10003;' : '&#10007;';
    const apprColor = appr.approved ? 'background:var(--green-muted);color:var(--green)' : 'background:var(--red-muted);color:var(--red)';
    detailHtml += '<div class="audit-detail-item"><span class="label">Approval</span><span class="audit-approval" style="' + apprColor + '">' + icon + ' ' + (appr.approved ? 'Approved' : 'Denied') + ' via ' + (appr.method || '?') + '</span></div>';
  }
  detailHtml += '</div>';

  if (e.reasoning) {
    detailHtml += '<div class="audit-reasoning">' + escapeHtml(e.reasoning) + '</div>';
  }
  if (e.params && Object.keys(e.params).length > 0) {
    detailHtml += '<div style="margin-bottom:4px"><span style="font-size:0.64rem;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.04em">Parameters</span></div>';
    detailHtml += '<div class="audit-params">' + escapeHtml(JSON.stringify(e.params, null, 2)) + '</div>';
  }
  if (e.error) {
    detailHtml += '<div class="audit-error">' + escapeHtml(e.error) + '</div>';
  }

  const chevronSvg = '<svg class="audit-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 4l4 4-4 4"/></svg>';

  return '<div class="audit-row" data-idx="' + idx + '">' +
    '<div class="audit-header" onclick="toggleAudit(this)">' +
      chevronSvg +
      '<span class="audit-time">' + time + '</span>' +
      '<span class="audit-action">' + escapeHtml(e.action || '-') + '</span>' +
      '<span class="audit-tier ' + tierClass + '">' + (e.tier || '-') + '</span>' +
      '<span class="audit-result-dot ' + (e.result || '') + '"></span>' +
    '</div>' +
    '<div class="audit-detail">' + detailHtml + '</div>' +
  '</div>';
}

function toggleAuditPlan(header) {
  header.parentElement.classList.toggle('open');
}

function toggleAudit(header) {
  header.parentElement.classList.toggle('open');
}

// ── Tabs ───────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');

    // Lazy load
    if (tab.dataset.tab === 'topology') refreshTopology();
    if (tab.dataset.tab === 'governance') loadAudit();
    if (tab.dataset.tab === 'incidents') loadIncidents();
    if (tab.dataset.tab === 'chaos') loadChaosPanel();
    if (tab.dataset.tab === 'resources') loadRightsizing();
  });
});

// ── Helpers ────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(val);
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toggleStepOutput(btn, id) {
  const el = document.getElementById(id);
  if (!el) return;
  const visible = el.style.display !== 'none';
  el.style.display = visible ? 'none' : 'block';
  btn.classList.toggle('open', !visible);
}

// Fields to hide from output (internal / noisy)
const HIDDEN_FIELDS = new Set(['ssl_fingerprint', 'digest', 'ha', 'serial', 'lock', 'tags', 'pool', 'template', 'agent', 'protection', 'keyboard', 'tablet', 'kvm', 'args', 'vmgenid', 'hookscript', 'hotplug', 'bios']);

// Fields that contain byte values
const BYTE_FIELDS = new Set(['maxdisk', 'maxmem', 'mem', 'disk', 'total', 'used', 'free', 'available', 'avail', 'ram_mb', 'ram_total_mb', 'ram_used_mb', 'disk_gb', 'ballooninfo']);

// Fields that contain seconds
const UPTIME_FIELDS = new Set(['uptime', 'uptime_s']);

function prettyHeader(key) {
  // Special known mappings
  const map = {
    'maxdisk': 'Disk', 'maxmem': 'RAM', 'mem': 'RAM Used', 'vmid': 'VMID',
    'cpu': 'CPU %', 'cpus': 'Cores', 'netin': 'Net In', 'netout': 'Net Out',
    'pid': 'PID', 'id': 'ID', 'name': 'Name', 'status': 'Status', 'node': 'Node',
    'type': 'Type', 'level': 'Level', 'pveversion': 'PVE Version',
    'cpu_cores': 'Cores', 'cpu_usage_pct': 'CPU %', 'ram_mb': 'RAM',
    'ram_total_mb': 'Total RAM', 'ram_used_mb': 'Used RAM', 'disk_gb': 'Disk',
    'uptime_s': 'Uptime', 'uptime': 'Uptime', 'loadavg': 'Load Avg',
    'cpuinfo': 'CPU Info', 'memory': 'Memory', 'swap': 'Swap',
    'current-kernel': 'Kernel', 'ksm': 'KSM', 'rootfs': 'Root FS',
    'content': 'Content', 'storage': 'Storage', 'shared': 'Shared',
    'enabled': 'Enabled', 'active': 'Active', 'total': 'Total',
    'used': 'Used', 'avail': 'Available', 'used_fraction': 'Usage %',
  };
  if (map[key]) return map[key];
  // snake_case / kebab-case → Title Case
  return key.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  const idx = Math.min(i, units.length - 1);
  return (bytes / Math.pow(1024, idx)).toFixed(idx > 1 ? 1 : 0) + ' ' + units[idx];
}

function formatOutputVal(key, val) {
  if (val === null || val === undefined) return '-';

  const lk = key.toLowerCase();

  // Byte values
  if (BYTE_FIELDS.has(lk) && typeof val === 'number' && val > 1024) {
    return formatBytes(val);
  }

  // Uptime
  if (UPTIME_FIELDS.has(lk) && typeof val === 'number') {
    return formatUptime(val);
  }

  // CPU percentage (0-1 float)
  if (lk === 'cpu' && typeof val === 'number' && val <= 1) {
    return (val * 100).toFixed(1) + '%';
  }

  // Network bytes
  if ((lk === 'netin' || lk === 'netout') && typeof val === 'number') {
    return formatBytes(val);
  }

  // used_fraction as percentage
  if (lk === 'used_fraction' && typeof val === 'number') {
    return (val * 100).toFixed(1) + '%';
  }

  // Nested objects — format nicely
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const parts = [];
    Object.entries(val).forEach(function(pair) {
      const sv = BYTE_FIELDS.has(pair[0]) && typeof pair[1] === 'number' && pair[1] > 1024
        ? formatBytes(pair[1]) : String(pair[1]);
      parts.push(prettyHeader(pair[0]) + ': ' + sv);
    });
    return parts.join(', ');
  }

  // Arrays
  if (Array.isArray(val)) {
    if (val.length <= 5) return val.join(', ');
    return val.slice(0, 5).join(', ') + ' (+' + (val.length - 5) + ')';
  }

  // Long strings
  const s = String(val);
  if (s.length > 80) return s.slice(0, 77) + '...';
  return s;
}

function formatStepOutput(data) {
  if (data === null || data === undefined) return '<pre>No output</pre>';

  // Arrays of objects → smart table
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
    const allKeys = Object.keys(data[0]);
    const cols = allKeys.filter(k => !HIDDEN_FIELDS.has(k.toLowerCase()) && !k.startsWith('_'));
    // Prioritize important columns first
    const priority = ['id', 'vmid', 'name', 'status', 'node', 'type', 'cpu', 'cpus', 'maxmem', 'maxdisk', 'uptime', 'storage', 'total', 'used', 'avail', 'content'];
    const sorted = cols.sort(function(a, b) {
      const ai = priority.indexOf(a.toLowerCase());
      const bi = priority.indexOf(b.toLowerCase());
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return 0;
    }).slice(0, 8);

    let html = '<table><thead><tr>';
    sorted.forEach(k => { html += '<th>' + escapeHtml(prettyHeader(k)) + '</th>'; });
    html += '</tr></thead><tbody>';
    data.slice(0, 50).forEach(row => {
      html += '<tr>';
      sorted.forEach(k => {
        const formatted = formatOutputVal(k, row[k]);
        // Status badge
        if (k.toLowerCase() === 'status') {
          const sc = String(row[k]).toLowerCase();
          html += '<td><span class="status-tag ' + sc + '">' + escapeHtml(formatted) + '</span></td>';
        } else {
          html += '<td>' + escapeHtml(formatted) + '</td>';
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    if (data.length > 50) html += '<div style="color:var(--text-tertiary);font-size:0.64rem;padding:4px 10px">...and ' + (data.length - 50) + ' more</div>';
    return html;
  }

  // Single object → clean key-value
  if (typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data).filter(k => !HIDDEN_FIELDS.has(k.toLowerCase()) && !k.startsWith('_'));
    if (keys.length === 0) return '<pre>Empty result</pre>';
    let html = '<table><tbody>';
    keys.forEach(k => {
      const formatted = formatOutputVal(k, data[k]);
      html += '<tr><td style="color:var(--text-tertiary);font-weight:500;white-space:nowrap;padding-right:16px">' + escapeHtml(prettyHeader(k)) + '</td><td>' + escapeHtml(formatted) + '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  // Primitive or string
  return '<pre>' + escapeHtml(String(data)) + '</pre>';
}

function formatUptime(seconds) {
  if (!seconds || typeof seconds !== 'number') return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

// ── Toast (transient error surface) ─────────────────────
function showToast(msg) {
  // Replace any existing toast so consecutive failures don't stack.
  const existing = document.getElementById('rhodesToast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'rhodes-toast';
  el.id = 'rhodesToast';
  el.textContent = String(msg);
  document.body.appendChild(el);
  setTimeout(() => { try { el.remove(); } catch {} }, 4500);
}

// ── Pending Approvals ───────────────────────────────────

async function loadPendingApprovals() {
  try {
    const data = await fetch('/api/agent/pending-approvals').then(r => r.json());
    if (!Array.isArray(data)) return;
    // Replace the pending map with the server's truth — but keep any
    // in-flight POSTs or sticky decision pills, because those represent
    // local UI state that the server snapshot won't reflect.
    const next = {};
    for (const entry of data) {
      if (entry && typeof entry.plan_id === 'string') {
        next[entry.plan_id] = entry;
      }
    }
    state.approvals.pending = next;
    renderPendingApprovals();
  } catch (err) {
    console.warn('[dashboard] loadPendingApprovals failed', err);
  }
}

function handleAwaitingApproval(entry) {
  if (!entry || typeof entry.plan_id !== 'string') return;
  state.approvals.pending[entry.plan_id] = entry;
  // A new approval landing clears any stale decision/error display.
  delete state.approvals.decisions[entry.plan_id];
  delete state.approvals.errors[entry.plan_id];
  delete state.approvals.inFlight[entry.plan_id];
  renderPendingApprovals();
}

function handlePlanDecisionBroadcast(payload, decisionFallback) {
  if (!payload || typeof payload.plan_id !== 'string') return;
  const planId = payload.plan_id;
  const decision = payload.decision || decisionFallback;
  // Record the decision so the card briefly shows a state pill instead of
  // popping out of existence; renderPendingApprovals removes resolved
  // entries after a short grace window.
  state.approvals.decisions[planId] = {
    decision,
    operator: payload.operator || 'api_operator',
    timestamp: payload.timestamp || new Date().toISOString(),
  };
  delete state.approvals.inFlight[planId];
  delete state.approvals.errors[planId];
  renderPendingApprovals();
  // Fade resolved cards out of the queue after a short window so the
  // operator sees what just happened. Re-fetch from the source of truth
  // afterwards so we converge with the server's view (covers cross-tab
  // approvals, etc.).
  setTimeout(() => {
    delete state.approvals.pending[planId];
    delete state.approvals.decisions[planId];
    renderPendingApprovals();
    loadPendingApprovals();
  }, 4000);
}

function renderPendingApprovals() {
  const section = document.getElementById('approvalsSection');
  const list = document.getElementById('approvalsList');
  const badge = document.getElementById('approvalsCountBadge');
  if (!section || !list || !badge) return;

  const plans = Object.values(state.approvals.pending);
  // Sort newest-first so the most recent gate sits on top.
  plans.sort((a, b) => {
    const ta = a && a.requested_at ? new Date(a.requested_at).getTime() : 0;
    const tb = b && b.requested_at ? new Date(b.requested_at).getTime() : 0;
    return tb - ta;
  });

  if (plans.length === 0) {
    section.style.display = 'none';
    list.innerHTML = '';
    badge.textContent = '0';
    return;
  }

  section.style.display = '';
  badge.textContent = String(plans.length);
  list.innerHTML = plans.map(renderApprovalCard).join('');
  // Apply any pending Telegram deep-link target now that the cards
  // have re-rendered (the operator may have clicked the link before
  // the SSE delivered the awaiting_approval entry, so this gets a
  // second chance on every render).
  try { applyApprovalDeepLink(); } catch (err) { console.warn('[dashboard] deep-link', err); }
}

// ── Telegram deep-link (?plan=<id>) ───────────────────────
// When RHODES sends an approval-pending alert via Supra/Telegram, the
// message includes an "Approve at: <dashboard>/?plan=<id>" deep link.
// On page load and on each Pending Approvals re-render we look for the
// matching card and scroll/highlight it. If the plan is no longer in
// the pending set we fall back to /api/audit to surface what happened.

// Read the deep-link target once and remember it across renders so the
// highlight pulse fires even if the SSE event for the plan arrives a
// moment after the operator opened the dashboard. Cleared after the
// pulse fires (or after we resolve the plan as already-decided) so it
// doesn't keep re-applying on every subsequent re-render.
let deepLinkPlanId = (function readDeepLinkPlanId() {
  try {
    return new URLSearchParams(window.location.search).get('plan');
  } catch { return null; }
})();
let deepLinkResolved = false;

function applyApprovalDeepLink() {
  if (!deepLinkPlanId || deepLinkResolved) return;
  const list = document.getElementById('approvalsList');
  if (!list) return;
  const escaped = (typeof CSS !== 'undefined' && CSS.escape)
    ? CSS.escape(deepLinkPlanId)
    : String(deepLinkPlanId).replace(/[^a-zA-Z0-9_-]/g, '');
  const card = list.querySelector('[data-plan-id="' + escaped + '"]');
  if (card) {
    deepLinkResolved = true;
    try {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {
      card.scrollIntoView();
    }
    // Restart the animation by re-toggling the class.
    card.classList.remove('deep-link-highlight');
    void card.offsetWidth;
    card.classList.add('deep-link-highlight');
    setTimeout(() => { card.classList.remove('deep-link-highlight'); }, 2200);
    return;
  }
  // Card not found — could be (a) SSE hasn't delivered the awaiting_approval
  // entry yet, or (b) the plan was already decided before the operator
  // tapped the link. Distinguish by asking the audit log; only show a toast
  // and stop retrying once we have a definitive resolved state.
  resolveDeepLinkAgainstAudit();
}

let deepLinkAuditInFlight = false;
async function resolveDeepLinkAgainstAudit() {
  if (deepLinkAuditInFlight || !deepLinkPlanId || deepLinkResolved) return;
  deepLinkAuditInFlight = true;
  try {
    // Pending — if the entry shows up here we just wait for renderPendingApprovals
    // to call us again; don't toast and don't mark resolved.
    const pending = await fetch('/api/agent/pending-approvals').then(r => r.ok ? r.json() : []);
    if (Array.isArray(pending) && pending.some(p => p && p.plan_id === deepLinkPlanId)) return;
    // Not pending — look for a terminal entry in the audit log.
    const auditUrl = '/api/audit?limit=200';
    const entries = await fetch(auditUrl).then(r => r.ok ? r.json() : []);
    const decided = Array.isArray(entries)
      ? entries.find(e => e && e.plan_id === deepLinkPlanId && (e.approval || e.result === 'blocked' || e.result === 'failed' || e.result === 'success' || e.result === 'rolled_back'))
      : null;
    if (decided) {
      let state = 'resolved';
      if (decided.approval && typeof decided.approval.approved === 'boolean') {
        state = decided.approval.approved ? 'approved' : 'rejected';
      } else if (decided.result === 'blocked') {
        state = 'rejected';
      } else if (decided.result === 'success') {
        state = 'approved';
      } else if (decided.result === 'rolled_back' || decided.result === 'failed') {
        state = decided.result.replace('_', ' ');
      }
      showToast('Plan ' + deepLinkPlanId + ' has been ' + state + '.');
      deepLinkResolved = true;
    }
    // If not found anywhere yet, leave deepLinkResolved=false and let the
    // next render re-attempt (covers the late-SSE case).
  } catch (err) {
    console.warn('[dashboard] audit lookup failed for deep-link', err);
  } finally {
    deepLinkAuditInFlight = false;
  }
}

// Initial pass on page load, in case the pending-approvals panel has
// already rendered (or never will, because the plan is already decided).
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    try { applyApprovalDeepLink(); } catch (err) { console.warn('[dashboard] deep-link', err); }
  });
}

// Recognises the rhodes-safety pre-remediation snapshot pattern from v0.4.3.
// These should look distinctly non-destructive even though they are
// "qm snapshot" calls; the snap name is conventionally rhodes-safety-*.
function isSafetySnapshot(entry) {
  if (!entry || entry.scope !== 'step') return false;
  const action = String(entry.action || '');
  if (!/(^|\\b)qm\\s+snapshot\\b/.test(action)) return false;
  const params = entry.params || {};
  const candidates = [
    params.snapname,
    params.snap_name,
    params.snapshot_name,
    params.name,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^rhodes-safety-/i.test(c)) return true;
  }
  // Also catch the snap name appearing inline in the action string
  // (e.g. "qm snapshot 200 rhodes-safety-2026-05-13T...").
  if (/rhodes-safety-/i.test(action)) return true;
  return false;
}

function renderApprovalCard(entry) {
  const planId = entry.plan_id;
  const tier = entry.tier || 'read';
  const action = entry.action || 'unknown action';
  const safety = isSafetySnapshot(entry);
  const reasoning = entry.reasoning || '';
  const decision = state.approvals.decisions[planId];
  const inFlight = state.approvals.inFlight[planId];
  const err = state.approvals.errors[planId];

  // Compact key:value table for params/scope. We deliberately render
  // arbitrary params here (not the giant nested plan steps array that
  // ApprovalGate.requestPlanApproval bundles into params.steps) — keep
  // the panel scannable.
  let paramsHtml = '';
  const params = entry.params && typeof entry.params === 'object' ? entry.params : {};
  const keys = Object.keys(params).filter(k => k !== 'steps');
  if (keys.length > 0) {
    let rows = '';
    for (const k of keys) {
      const v = params[k];
      const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
      rows += '<span class="pk">' + escapeHtml(k) + '</span><span class="pv">' + escapeHtml(display) + '</span>';
    }
    paramsHtml = '<div class="approval-params">' + rows + '</div>';
  } else if (entry.scope === 'plan' && Array.isArray(params.steps)) {
    paramsHtml = '<div class="approval-params"><span class="pk">steps</span><span class="pv">' + params.steps.length + ' planned</span></div>';
  }

  let footerHtml = '';
  if (decision) {
    const cls = decision.decision === 'approve' ? 'approved' : 'rejected';
    const ts = decision.timestamp ? new Date(decision.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '';
    const label = decision.decision === 'approve'
      ? 'Approved by ' + escapeHtml(decision.operator) + (ts ? ' at ' + ts : '')
      : 'Rejected' + (decision.operator ? ' by ' + escapeHtml(decision.operator) : '') + (ts ? ' at ' + ts : '');
    footerHtml = '<div class="approval-state-pill ' + cls + '">' + label + '</div>';
  } else {
    const disabledAttr = inFlight ? 'disabled' : '';
    const approveLabel = inFlight === 'approve'
      ? '<span class="spinner"></span> Approving…'
      : 'Approve';
    const rejectLabel = inFlight === 'reject'
      ? '<span class="spinner"></span> Rejecting…'
      : 'Reject';
    footerHtml =
      '<button class="approval-btn approve" ' + disabledAttr + ' onclick="submitApproval(\\'' + escapeJsString(planId) + '\\', \\'approve\\')">' + approveLabel + '</button>' +
      '<button class="approval-btn reject" ' + disabledAttr + ' onclick="submitApproval(\\'' + escapeJsString(planId) + '\\', \\'reject\\')">' + rejectLabel + '</button>';
    if (err) footerHtml += '<span class="approval-error">' + escapeHtml(err) + '</span>';
  }

  const tierClass = String(tier).replace(/[^a-z_]/gi, '');
  const safetyBadge = safety
    ? '<span class="approval-safety-badge" title="Pre-remediation snapshot — non-destructive">&#x1F6E1; Safety Snapshot</span>'
    : '';
  const ago = entry.requested_at ? 'requested ' + timeAgo(entry.requested_at) : '';

  return '<div class="approval-card ' + (safety ? 'safety' : '') + '" data-plan-id="' + escapeHtml(planId) + '">' +
    '<div class="approval-card-header">' +
      '<span class="approval-action">' + escapeHtml(action) + '</span>' +
      '<span class="approval-tier ' + tierClass + '">' + escapeHtml(String(tier)) + '</span>' +
      safetyBadge +
      (ago ? '<span class="approval-time">' + ago + '</span>' : '') +
    '</div>' +
    (reasoning ? '<div class="approval-reasoning">' + escapeHtml(reasoning) + '</div>' : '') +
    paramsHtml +
    '<div class="approval-card-footer">' + footerHtml + '</div>' +
  '</div>';
}

function escapeJsString(s) {
  return String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
}

async function submitApproval(planId, decision) {
  if (!planId || (decision !== 'approve' && decision !== 'reject')) return;
  if (state.approvals.inFlight[planId]) return;
  state.approvals.inFlight[planId] = decision;
  delete state.approvals.errors[planId];
  renderPendingApprovals();

  try {
    const res = await fetch('/api/agent/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: planId, decision }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (payload && payload.error) ? payload.error : 'Approval request failed (' + res.status + ')';
      throw new Error(msg);
    }
    // Optimistically record the decision; the SSE broadcast will land
    // shortly and may overwrite with the server's canonical timestamp.
    state.approvals.decisions[planId] = {
      decision: payload.decision || decision,
      operator: payload.operator || 'api_operator',
      timestamp: payload.timestamp || new Date().toISOString(),
    };
    delete state.approvals.inFlight[planId];
    renderPendingApprovals();
  } catch (err) {
    delete state.approvals.inFlight[planId];
    const msg = err && err.message ? err.message : 'Approval request failed';
    state.approvals.errors[planId] = msg;
    renderPendingApprovals();
    showToast(msg);
  }
}

// ── Remediate (incident → agent prompt) ─────────────────

function buildRemediatePrompt(inc) {
  if (!inc) return '';
  const labels = inc.labels || {};
  const metric = inc.metric || '';
  const name = labels.name || labels.vmid || '';
  const vmid = labels.vmid !== undefined ? labels.vmid : '';
  const node = labels.node || 'unknown node';

  if (metric === 'vm_status' && labels.reason === 'paused_io_error') {
    return 'Investigate VM ' + name + ' (vmid ' + vmid + ') on ' + node +
      ' — currently in paused (io-error). Run the proxmox-storage-pause playbook to diagnose snapshot bloat, propose a remediation plan, and wait for approval before executing.';
  }
  if (metric === 'vm_status') {
    return 'Investigate VM ' + name + ' on ' + node + ' — anomaly: ' + (labels.reason || metric) + '. Propose a remediation plan and wait for approval.';
  }
  if (metric === 'service_http_status') {
    return 'Investigate service ' + (labels.service_name || '(unnamed)') + ' — HTTP probe failing. Run the in-VM diagnostic playbook against the target VM. Propose remediation and wait for approval.';
  }
  return 'Investigate the anomaly: ' + (inc.anomaly_type || 'unknown') + ' on ' + metric +
    ' with labels ' + JSON.stringify(labels) + '. Diagnose and propose a remediation plan.';
}

async function triggerRemediate(incidentId) {
  const inc = state.incidents.active.find(i => i.id === incidentId);
  if (!inc) return;
  if (state.remediate.state[incidentId] === 'pending') return;
  state.remediate.state[incidentId] = 'pending';
  renderActiveIncidents();

  const prompt = buildRemediatePrompt(inc);
  try {
    const res = await fetch('/api/agent/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: prompt }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const msg = (payload && payload.error) ? payload.error : 'Remediation request failed (' + res.status + ')';
      throw new Error(msg);
    }
    state.remediate.state[incidentId] = 'done';
    renderActiveIncidents();
    // Pull any new pending approvals the agent just queued.
    loadPendingApprovals();
  } catch (err) {
    delete state.remediate.state[incidentId];
    const msg = err && err.message ? err.message : 'Remediation request failed';
    showToast(msg);
    renderActiveIncidents();
  }
}

// ── Incidents ──────────────────────────────────────────

async function loadIncidents() {
  try {
    const data = await fetch('/api/incidents').then(r => r.json());
    if (data.error) return;
    state.incidents.active = (data.open || []).filter(i => i.status === 'open' || i.status === 'healing');
    // Recent = resolved/failed from the full list, excluding active
    const activeIds = new Set(state.incidents.active.map(i => i.id));
    state.incidents.recent = (data.recent || []).filter(i => !activeIds.has(i.id)).slice(0, 20);
    state.incidents.patterns = data.patterns || [];
    renderIncidents();
    updateIncidentBadge();
  } catch {}
}

function handleIncidentOpened(d) {
  const incident = {
    id: d.incident_id,
    anomaly_type: d.anomaly_type,
    severity: d.severity,
    metric: d.metric,
    labels: d.labels || {},
    trigger_value: d.trigger_value,
    description: d.description,
    playbook_id: d.playbook_id,
    status: d.playbook_id ? 'healing' : 'open',
    detected_at: new Date().toISOString(),
    actions_taken: [],
  };
  // Remove if already present
  state.incidents.active = state.incidents.active.filter(i => i.id !== incident.id);
  state.incidents.active.unshift(incident);
  renderIncidents();
  updateIncidentBadge();
}

function handleIncidentAction(d) {
  const inc = state.incidents.active.find(i => i.id === d.incident_id);
  if (inc) {
    inc.status = 'healing';
    if (!inc.actions_taken) inc.actions_taken = [];
    inc.actions_taken.push({ action: d.action, timestamp: new Date().toISOString(), success: d.success, details: d.details });
    // Invalidate cached timeline
    delete state.incidents.timelines[d.incident_id];
    renderIncidents();
  }
}

function handleIncidentResolved(d) {
  const idx = state.incidents.active.findIndex(i => i.id === d.incident_id);
  if (idx !== -1) {
    const inc = state.incidents.active.splice(idx, 1)[0];
    inc.status = 'resolved';
    inc.resolution = d.resolution;
    inc.duration_ms = d.duration_ms;
    inc.resolved_at = new Date().toISOString();
    state.incidents.recent.unshift(inc);
    if (state.incidents.recent.length > 20) state.incidents.recent.pop();
  }
  delete state.incidents.timelines[d.incident_id];
  renderIncidents();
  updateIncidentBadge();
}

function handleIncidentFailed(d) {
  const idx = state.incidents.active.findIndex(i => i.id === d.incident_id);
  if (idx !== -1) {
    const inc = state.incidents.active.splice(idx, 1)[0];
    inc.status = 'failed';
    inc.resolution = d.reason;
    inc.duration_ms = d.duration_ms;
    inc.resolved_at = new Date().toISOString();
    state.incidents.recent.unshift(inc);
    if (state.incidents.recent.length > 20) state.incidents.recent.pop();
  }
  delete state.incidents.timelines[d.incident_id];
  renderIncidents();
  updateIncidentBadge();
}

function handleIncidentRca(d) {
  const inc = state.incidents.active.find(i => i.id === d.incident_id);
  if (inc) {
    if (!inc.rca) inc.rca = {};
    inc.rca.root_cause = d.root_cause;
    inc.rca.confidence = d.confidence;
    inc.rca.contributing_factors = d.contributing_factors;
    inc.rca.recommended_action = d.recommended_action;
    // Also add as an action so it appears in the timeline
    if (!inc.actions_taken) inc.actions_taken = [];
    inc.actions_taken.push({
      action: 'AI Root Cause Analysis',
      timestamp: new Date().toISOString(),
      success: true,
      details: d.root_cause + (d.recommended_action ? ' — Recommendation: ' + d.recommended_action : ''),
    });
    delete state.incidents.timelines[d.incident_id];
    renderIncidents();
  }
}

function handleHealingStarted(d) {
  const inc = state.incidents.active.find(i => i.id === d.incident_id);
  if (inc) {
    inc.status = 'healing';
    inc.playbook_id = d.playbook_id || inc.playbook_id;
    renderIncidents();
  }
}

function handleHealingCompleted(d) {
  // Treat same as resolved
  handleIncidentResolved(d);
}

function handleHealingFailed(d) {
  handleIncidentFailed(d);
}

function handleHealingPaused(d) {
  state.healingBanners = state.healingBanners.filter(b => b.id !== d.incident_id);
  state.healingBanners.push({ type: 'paused', message: d.reason || 'Healing paused', id: d.incident_id });
  renderHealingBanners();
}

function handleHealingEscalated(d) {
  state.healingBanners = state.healingBanners.filter(b => b.id !== d.incident_id);
  state.healingBanners.push({ type: 'escalated', message: d.reason || 'Incident escalated — manual intervention required', id: d.incident_id });
  renderHealingBanners();
}

function updateIncidentBadge() {
  const badge = document.getElementById('incidentTabBadge');
  if (!badge) return;
  const count = state.incidents.active.length;
  badge.textContent = String(count);
  badge.className = 'tab-badge' + (count === 0 ? ' zero' : '');
}

function renderHealingBanners() {
  const el = document.getElementById('healingBanners');
  if (!el) return;
  if (state.healingBanners.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = state.healingBanners.map(b =>
    '<div class="healing-banner ' + b.type + '">' +
      (b.type === 'paused' ? '&#9888;' : '&#9760;') +
      ' <span>' + escapeHtml(b.message) + '</span>' +
    '</div>'
  ).join('');
}

function renderIncidents() {
  renderActiveIncidents();
  renderRecentIncidents();
}

function renderActiveIncidents() {
  const el = document.getElementById('activeIncidents');
  if (!el) return;

  if (state.incidents.active.length === 0) {
    el.innerHTML = '<div class="incidents-empty"><div class="empty-icon">&#9711;</div>No active incidents \\u2014 all clear</div>';
    return;
  }

  el.innerHTML = state.incidents.active.map(inc => {
    const ago = timeAgo(inc.detected_at);
    const expanded = state.incidents.expanded[inc.id];

    let html = '<div class="incident-card" onclick="toggleIncidentTimeline(\\'' + inc.id + '\\')">';
    html += '<div class="incident-card-header">';
    html += '<span class="incident-severity ' + inc.severity + '">' + inc.severity + '</span>';
    html += '<span class="incident-desc">' + escapeHtml(inc.description) + '</span>';
    html += '<span class="incident-status-pill ' + inc.status + '">' + inc.status + '</span>';

    // Remediate button — only on open/healing incidents, not "recent"
    // (resolved or failed). Stop propagation so clicking the button
    // doesn't also toggle the expanded timeline beneath it.
    const remState = state.remediate.state[inc.id];
    html += '<span class="incident-remediate-wrap" onclick="event.stopPropagation()">';
    if (remState === 'done') {
      html += '<span class="incident-remediate-done">Plan requested \\u2014 check Pending Approvals above</span>';
    } else if (remState === 'pending') {
      html += '<button class="incident-remediate-btn" disabled>Planning\\u2026</button>';
    } else {
      html += '<button class="incident-remediate-btn" onclick="triggerRemediate(\\'' + inc.id + '\\')">Remediate</button>';
    }
    html += '</span>';
    html += '</div>';

    html += '<div class="incident-card-meta">';
    html += '<span class="incident-metric-val">' + escapeHtml(inc.metric || '') + ': ' + (inc.trigger_value !== undefined ? inc.trigger_value : '-') + '</span>';

    if (inc.status === 'healing' && inc.playbook_id) {
      html += '<span class="incident-playbook"><span class="spinner"></span> ' + escapeHtml(inc.playbook_id) + '</span>';
    }

    html += '<span class="incident-time-ago">' + ago + '</span>';
    html += '</div>';

    if (expanded) {
      html += renderIncidentTimeline(inc);
    }

    html += '</div>';
    return html;
  }).join('');
}

function renderRecentIncidents() {
  const el = document.getElementById('recentIncidents');
  if (!el) return;

  if (state.incidents.recent.length === 0) {
    el.innerHTML = '<div class="incidents-empty"><div class="empty-icon">&#9711;</div>No recent incidents</div>';
    return;
  }

  el.innerHTML = state.incidents.recent.map(inc => {
    const dur = inc.duration_ms ? formatDuration(inc.duration_ms) : '-';
    const expanded = state.incidents.expanded[inc.id];
    const hasPattern = !!inc.pattern_id;

    let html = '<div>';
    html += '<div class="incident-row" onclick="toggleIncidentTimeline(\\'' + inc.id + '\\')">';
    html += '<span class="incident-sev-dot ' + inc.severity + '"></span>';
    html += '<span class="incident-row-desc">' + escapeHtml(inc.description) + '</span>';
    if (hasPattern) {
      html += '<span class="incident-pattern-tag">Pattern</span>';
    }
    html += '<span class="incident-row-duration">' + dur + '</span>';
    html += '<span class="incident-row-resolution">' + escapeHtml(inc.resolution || '') + '</span>';
    html += '<span class="incident-row-result ' + inc.status + '"></span>';
    html += '</div>';

    if (expanded) {
      html += renderIncidentTimeline(inc);
    }

    html += '</div>';
    return html;
  }).join('');
}

function renderIncidentTimeline(inc) {
  // Build timeline from local data
  const entries = [];

  entries.push({
    timestamp: inc.detected_at,
    event: 'detected',
    detail: inc.description,
  });

  if (inc.actions_taken) {
    inc.actions_taken.forEach(a => {
      const isRca = a.action === 'AI Root Cause Analysis';
      entries.push({
        timestamp: a.timestamp,
        event: isRca ? 'rca' : 'action',
        detail: a.details || a.action,
        success: a.success,
      });
    });
  }

  if (inc.status === 'resolved' && inc.resolved_at) {
    entries.push({
      timestamp: inc.resolved_at,
      event: 'resolved',
      detail: inc.resolution || 'Resolved',
    });
  } else if (inc.status === 'failed' && inc.resolved_at) {
    entries.push({
      timestamp: inc.resolved_at,
      event: 'failed',
      detail: inc.resolution || 'Failed',
    });
  }

  entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (entries.length === 0) return '';

  const firstTime = new Date(entries[0].timestamp).getTime();
  const lastTime = entries.length > 1 ? new Date(entries[entries.length - 1].timestamp).getTime() : firstTime;
  const totalDuration = lastTime - firstTime;

  let html = '<div class="incident-timeline">';
  entries.forEach((entry, idx) => {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const isLast = idx === entries.length - 1;

    let dotClass = 'timeline-dot ' + entry.event;
    let icon = '';
    let label = '';

    switch (entry.event) {
      case 'detected':
        icon = '!';
        label = 'Anomaly Detected';
        break;
      case 'action':
        dotClass += entry.success ? ' success' : (entry.success === false ? ' fail' : '');
        icon = entry.success ? '&#10003;' : (entry.success === false ? '&#10007;' : '&#9889;');
        label = 'Action' + (entry.success === false ? ' (Failed)' : entry.success ? ' (Success)' : '');
        break;
      case 'resolved':
        icon = '&#10003;';
        label = 'Resolved';
        break;
      case 'failed':
        icon = '&#10007;';
        label = 'Failed';
        break;
      case 'rca':
        icon = '&#128269;';
        label = 'AI Root Cause Analysis';
        break;
    }

    html += '<div class="timeline-entry">';
    html += '<div class="timeline-gutter">';
    html += '<div class="' + dotClass + '">' + icon + '</div>';
    if (!isLast) html += '<div class="timeline-line"></div>';
    html += '</div>';
    html += '<div class="timeline-content">';
    html += '<div class="timeline-label">' + label + '</div>';
    html += '<div class="timeline-detail">' + escapeHtml(entry.detail) + '</div>';
    html += '<div class="timeline-time">' + time;
    if (isLast && totalDuration > 0) {
      const badgeClass = entry.event === 'failed' ? ' failed' : '';
      html += '<span class="timeline-duration-badge' + badgeClass + '">Duration: ' + formatDuration(totalDuration) + '</span>';
    }
    html += '</div>';
    html += '</div>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

function toggleIncidentTimeline(id) {
  state.incidents.expanded[id] = !state.incidents.expanded[id];
  renderIncidents();
}

function timeAgo(isoStr) {
  if (!isoStr) return '-';
  const diff = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

// ── Health Check Handler ─────────────────────────────────
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 42; // ~263.89

function handleHealthCheck(d) {
  state.lastHealth = d;

  // Store for sparklines (max 30 points)
  state.healthHistory.push(d);
  if (state.healthHistory.length > 30) state.healthHistory.shift();

  // 1. Update stat cards
  updateStatCardsFromHealth(d);

  // 2. Update gauges
  updateGauges(d);

  // 3. Update sparklines
  updateSparklines();

  // 4. Update per-node breakdown
  updateNodeBreakdown(d);

  // 5. Update last-update badge
  const badge = document.getElementById('resourceLastUpdate');
  if (badge) {
    const t = new Date(d.timestamp);
    badge.textContent = t.toLocaleTimeString();
  }
}

function updateStatCardsFromHealth(d) {
  if (!d) return;
  const n = d.nodes || {};
  const v = d.vms || {};
  const r = d.resources || {};

  setText('statNodes', (n.online || 0) + '/' + (n.total || 0));
  setText('statVMs', v.total || 0);
  setText('statRunning', v.running || 0);

  const cpuEl = document.getElementById('statCPU');
  if (cpuEl) cpuEl.innerHTML = (r.cpu_usage_pct || 0).toFixed(1) + '<span class="unit">%</span>';

  const ramEl = document.getElementById('statRAM');
  if (ramEl) ramEl.innerHTML = (r.ram_usage_pct || 0).toFixed(1) + '<span class="unit">%</span>';
}

function gaugeColor(pct) {
  if (pct > 80) return 'var(--red)';
  if (pct > 60) return 'var(--amber)';
  return 'var(--teal)';
}

function updateGauges(d) {
  if (!d || !d.resources) return;
  const r = d.resources;

  // CPU
  setGauge('gaugeCpuFill', 'gaugeCpuPct', r.cpu_usage_pct || 0);
  const cpuDetail = document.getElementById('gaugeCpuDetail');
  if (cpuDetail) cpuDetail.textContent = (r.cpu_cores_total || 0) + ' cores total';

  // RAM
  setGauge('gaugeRamFill', 'gaugeRamPct', r.ram_usage_pct || 0);
  const ramDetail = document.getElementById('gaugeRamDetail');
  if (ramDetail) {
    const usedGB = (r.ram_used_mb / 1024).toFixed(1);
    const totalGB = (r.ram_total_mb / 1024).toFixed(1);
    ramDetail.textContent = usedGB + ' GB used / ' + totalGB + ' GB';
  }

  // Disk
  setGauge('gaugeDiskFill', 'gaugeDiskPct', r.disk_usage_pct || 0);
  const diskDetail = document.getElementById('gaugeDiskDetail');
  if (diskDetail) {
    diskDetail.textContent = (r.disk_used_gb || 0).toFixed(1) + ' GB used / ' + (r.disk_total_gb || 0).toFixed(1) + ' GB';
  }
}

function setGauge(fillId, pctId, pct) {
  const fill = document.getElementById(fillId);
  const pctEl = document.getElementById(pctId);
  if (!fill || !pctEl) return;

  const clamped = Math.min(Math.max(pct, 0), 100);
  const dashLen = (clamped / 100) * GAUGE_CIRCUMFERENCE;
  fill.setAttribute('stroke-dasharray', dashLen + ' ' + GAUGE_CIRCUMFERENCE);
  fill.setAttribute('stroke', gaugeColor(clamped));
  pctEl.textContent = clamped.toFixed(1);
}

function updateSparklines() {
  const history = state.healthHistory;
  if (history.length < 2) return;

  renderSparkline('sparkCpuSvg', 'sparkCpuVal', history.map(function(h) { return h.resources.cpu_usage_pct || 0; }));
  renderSparkline('sparkRamSvg', 'sparkRamVal', history.map(function(h) { return h.resources.ram_usage_pct || 0; }));
  renderSparkline('sparkDiskSvg', 'sparkDiskVal', history.map(function(h) { return h.resources.disk_usage_pct || 0; }));
}

function renderSparkline(svgId, valId, data) {
  const svg = document.getElementById(svgId);
  const valEl = document.getElementById(valId);
  if (!svg || data.length < 2) return;

  const latest = data[data.length - 1];
  if (valEl) valEl.textContent = latest.toFixed(1) + '%';

  const W = 200;
  const H = 40;
  const pad = 2;
  const maxVal = Math.max(100, Math.max.apply(null, data));
  const n = data.length;

  const pts = data.map(function(v, i) {
    const x = (i / (n - 1)) * W;
    const y = pad + ((1 - v / maxVal) * (H - pad * 2));
    return x.toFixed(1) + ',' + y.toFixed(1);
  });

  const polyline = svg.querySelector('.sparkline-line');
  if (polyline) polyline.setAttribute('points', pts.join(' '));

  const area = svg.querySelector('.sparkline-area');
  if (area) {
    const areaD = 'M' + pts[0] + ' ' + pts.map(function(p) { return 'L' + p; }).join(' ') +
      ' L' + W + ',' + H + ' L0,' + H + ' Z';
    area.setAttribute('d', areaD);
  }
}

function updateNodeBreakdown(d) {
  if (!d || !d.nodes) return;
  const container = document.getElementById('nodeBreakdown');
  const grid = document.getElementById('nodeBreakdownGrid');
  if (!container || !grid) return;

  // Only show if we have cluster data with per-node info
  const cluster = state.cluster;
  if (!cluster || !cluster.nodes || cluster.nodes.length < 1) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  const nodes = cluster.nodes;
  const r = d.resources || {};

  grid.innerHTML = nodes.map(function(n) {
    const online = n.status === 'online';
    const cpu = typeof n.cpu_usage_pct === 'number' ? n.cpu_usage_pct : 0;
    const ramPct = (n.ram_total_mb && n.ram_used_mb) ? (n.ram_used_mb / n.ram_total_mb * 100) : 0;
    // Disk pct not available per-node from cluster API, estimate from summary if single node
    const diskPct = nodes.length === 1 ? (r.disk_usage_pct || 0) : 0;

    return '<div class="node-break-card">' +
      '<div class="node-break-name"><span class="nbdot' + (online ? '' : ' offline') + '"></span>' + escapeHtml(n.name || '-') + '</div>' +
      nodeBreakBar('CPU', cpu) +
      nodeBreakBar('RAM', ramPct) +
      (diskPct > 0 ? nodeBreakBar('Disk', diskPct) : '') +
    '</div>';
  }).join('');
}

function nodeBreakBar(label, pct) {
  var clamped = Math.min(Math.max(pct, 0), 100);
  var color = clamped > 80 ? 'var(--red)' : clamped > 60 ? 'var(--amber)' : 'var(--teal)';
  return '<div class="node-break-bar-row">' +
    '<span class="node-break-bar-label">' + label + '</span>' +
    '<div class="node-break-bar-track"><div class="node-break-bar-fill" style="width:' + clamped.toFixed(1) + '%;background:' + color + '"></div></div>' +
    '<span class="node-break-bar-pct">' + clamped.toFixed(1) + '%</span>' +
  '</div>';
}

// ── Polling ────────────────────────────────────────────
async function pollCluster() {
  try {
    const data = await fetch('/api/cluster').then(r => r.json());
    renderCluster(data);
  } catch {}
}

// ── Predictions ────────────────────────────────────────

const METRIC_LABELS = {
  node_cpu_pct: 'CPU Usage',
  node_mem_pct: 'Memory Usage',
  node_disk_pct: 'Disk Usage',
};

function getTrendArrow(slope) {
  if (slope > 0.1) return { arrow: '\u2191', cls: 'rising' };
  if (slope < -0.1) return { arrow: '\u2193', cls: 'falling' };
  return { arrow: '\u2192', cls: 'stable' };
}

function getValueClass(status) {
  if (status === 'critical') return 'critical';
  if (status === 'warning') return 'warning';
  return 'healthy';
}

function getStatusText(p) {
  var trend = getTrendArrow(p.slope_per_hour);
  if (p.status === 'critical') {
    return 'Critical \u2014 projected critical in ' + (p.hours_to_critical != null ? p.hours_to_critical + 'h' : 'N/A');
  }
  if (p.status === 'warning') {
    return 'Warning \u2014 projected critical in ' + (p.hours_to_critical != null ? p.hours_to_critical + 'h' : 'N/A');
  }
  if (trend.cls === 'falling') return 'Healthy \u2014 declining trend';
  if (trend.cls === 'stable') return 'Healthy \u2014 stable trend';
  return 'Healthy \u2014 slow growth, >48h to threshold';
}

function renderPredictions(predictions) {
  var grid = document.getElementById('predictionsGrid');
  if (!grid) return;

  if (!predictions || predictions.length === 0) {
    grid.innerHTML = '<div class="predictions-empty">No prediction data available yet. Metrics need at least 2 data points.</div>';
    return;
  }

  grid.innerHTML = predictions.map(function(p) {
    var trend = getTrendArrow(p.slope_per_hour);
    var valCls = getValueClass(p.status);
    var currentPct = Math.min(p.current, 100);
    var proj24Pct = Math.min(p.projected_24h, 100);
    var barColor = p.status === 'critical' ? 'var(--red)' : p.status === 'warning' ? 'var(--amber)' : 'var(--teal)';
    var projBarColor = p.status === 'critical' ? 'var(--red)' : p.status === 'warning' ? 'var(--amber)' : 'var(--teal)';
    var label = METRIC_LABELS[p.metric] || p.metric;
    var nodeLabel = p.labels.node || p.labels.host || '';
    var countdownStr = p.hours_to_critical != null ? (p.hours_to_critical < 1 ? '<1h' : Math.round(p.hours_to_critical) + 'h') : '\u221E';

    var html = '<div class="prediction-card status-' + p.status + '">';
    html += '<div class="prediction-header">';
    html += '<span class="prediction-metric">' + escapeHtml(label) + '</span>';
    if (nodeLabel) html += '<span class="prediction-node">' + escapeHtml(nodeLabel) + '</span>';
    html += '</div>';

    html += '<div class="prediction-value-row">';
    html += '<span class="prediction-current ' + valCls + '">' + p.current + '%</span>';
    html += '<span class="prediction-trend ' + trend.cls + '">' + trend.arrow + '</span>';
    html += '<span class="prediction-slope">' + (p.slope_per_hour >= 0 ? '+' : '') + p.slope_per_hour + '%/hr</span>';
    html += '</div>';

    // Projection bar
    html += '<div class="prediction-bar-container">';
    html += '<div class="prediction-bar-current" style="width:' + currentPct + '%;background:' + barColor + '"></div>';
    if (proj24Pct > currentPct) {
      html += '<div class="prediction-bar-projected" style="left:' + currentPct + '%;width:' + (proj24Pct - currentPct) + '%;background:' + projBarColor + '"></div>';
    }
    html += '<div class="prediction-bar-proj-marker" style="left:' + proj24Pct + '%"></div>';
    html += '<div class="prediction-bar-threshold" style="left:90%"></div>';
    html += '</div>';

    // Countdown
    html += '<div class="prediction-countdown">Time to critical: <span class="time-value ' + valCls + '">' + countdownStr + '</span></div>';

    // Status text
    html += '<div class="prediction-status-text ' + p.status + '">' + getStatusText(p) + '</div>';

    html += '</div>';
    return html;
  }).join('');
}

async function loadPredictions() {
  try {
    var data = await fetch('/api/health/predictions').then(function(r) { return r.json(); });
    renderPredictions(data.predictions || []);
  } catch(e) {
    // silently fail
  }
}

// ── Right-sizing Recommendations ──────────────────────

function renderRightsizing(recommendations) {
  var grid = document.getElementById('rightsizingGrid');
  var summaryEl = document.getElementById('rightsizingSummary');
  var badge = document.getElementById('rightsizingBadge');
  if (!grid) return;

  if (!recommendations || recommendations.length === 0) {
    grid.innerHTML = '<div class="rightsizing-empty">All VMs appear right-sized, or not enough metric data yet (need ~2 min of history).</div>';
    if (summaryEl) summaryEl.style.display = 'none';
    if (badge) { badge.textContent = 'ALL OK'; badge.style.background = 'var(--teal-muted)'; badge.style.color = 'var(--teal)'; }
    return;
  }

  // Summary counts
  var highCount = 0, medCount = 0, lowCount = 0;
  recommendations.forEach(function(r) {
    if (r.savings_pct >= 50) highCount++;
    else if (r.savings_pct >= 25) medCount++;
    else lowCount++;
  });

  if (summaryEl) {
    summaryEl.style.display = 'flex';
    var html = '';
    html += '<div class="rightsizing-summary-pill"><span class="pill-count" style="color:var(--red)">' + highCount + '</span> Significantly Over</div>';
    html += '<div class="rightsizing-summary-pill"><span class="pill-count" style="color:var(--amber)">' + medCount + '</span> Slightly Over</div>';
    html += '<div class="rightsizing-summary-pill"><span class="pill-count" style="color:var(--teal)">' + lowCount + '</span> Minor</div>';
    summaryEl.innerHTML = html;
  }

  if (badge) {
    badge.textContent = recommendations.length + ' VM' + (recommendations.length !== 1 ? 's' : '');
    if (highCount > 0) { badge.style.background = 'var(--red-muted)'; badge.style.color = 'var(--red)'; }
    else if (medCount > 0) { badge.style.background = 'var(--amber-muted)'; badge.style.color = 'var(--amber)'; }
    else { badge.style.background = 'var(--teal-muted)'; badge.style.color = 'var(--teal)'; }
  }

  grid.innerHTML = recommendations.map(function(r) {
    var severity = r.savings_pct >= 50 ? 'red' : r.savings_pct >= 25 ? 'amber' : 'green';
    var savingsClass = r.savings_pct >= 50 ? 'high' : r.savings_pct >= 25 ? 'medium' : 'low';

    // CPU bar: avg usage as filled, show where recommended line falls
    var cpuUsedWidth = Math.min(r.cpu_avg_pct, 100);
    var cpuPeakWidth = Math.min(r.cpu_peak_pct, 100);
    var cpuRecPct = r.cpu_allocated > 0 ? Math.min((r.cpu_recommended / r.cpu_allocated) * 100, 100) : 100;
    var cpuBarColor = r.cpu_avg_pct < 20 ? 'var(--red)' : r.cpu_avg_pct < 40 ? 'var(--amber)' : 'var(--teal)';

    // RAM bar
    var ramUsedWidth = Math.min(r.ram_avg_pct, 100);
    var ramPeakWidth = Math.min(r.ram_peak_pct, 100);
    var ramRecPct = r.ram_allocated_mb > 0 ? Math.min((r.ram_recommended_mb / r.ram_allocated_mb) * 100, 100) : 100;
    var ramBarColor = r.ram_avg_pct < 30 ? 'var(--red)' : r.ram_avg_pct < 50 ? 'var(--amber)' : 'var(--teal)';

    var ramAllocStr = r.ram_allocated_mb >= 1024 ? (r.ram_allocated_mb / 1024).toFixed(1) + ' GB' : r.ram_allocated_mb + ' MB';
    var ramRecStr = r.ram_recommended_mb >= 1024 ? (r.ram_recommended_mb / 1024).toFixed(1) + ' GB' : r.ram_recommended_mb + ' MB';

    var html = '<div class="rightsizing-card severity-' + severity + '">';

    // Header
    html += '<div class="rightsizing-header">';
    html += '<div>';
    html += '<div class="rightsizing-vm-name">' + escapeHtml(r.name) + '</div>';
    html += '<div class="rightsizing-vm-meta">VMID ' + r.vmid + ' &middot; ' + escapeHtml(r.node) + '</div>';
    html += '</div>';
    html += '<div class="rightsizing-savings ' + savingsClass + '">' + r.savings_pct + '% savings</div>';
    html += '</div>';

    // CPU bar
    html += '<div class="rightsizing-resource">';
    html += '<div class="rightsizing-resource-label">CPU</div>';
    html += '<div class="rightsizing-bar-container">';
    html += '<div class="rightsizing-bar-used" style="width:' + cpuUsedWidth + '%;background:' + cpuBarColor + ';opacity:0.7"></div>';
    html += '<div class="rightsizing-bar-used" style="width:' + cpuPeakWidth + '%;background:' + cpuBarColor + ';opacity:0.25"></div>';
    html += '<div class="rightsizing-bar-recommended" style="left:' + cpuRecPct + '%"></div>';
    html += '</div>';
    html += '<div class="rightsizing-resource-detail">' + r.cpu_allocated + ' cores &rarr; <span class="rec">' + r.cpu_recommended + '</span></div>';
    html += '</div>';

    // RAM bar
    html += '<div class="rightsizing-resource">';
    html += '<div class="rightsizing-resource-label">RAM</div>';
    html += '<div class="rightsizing-bar-container">';
    html += '<div class="rightsizing-bar-used" style="width:' + ramUsedWidth + '%;background:' + ramBarColor + ';opacity:0.7"></div>';
    html += '<div class="rightsizing-bar-used" style="width:' + ramPeakWidth + '%;background:' + ramBarColor + ';opacity:0.25"></div>';
    html += '<div class="rightsizing-bar-recommended" style="left:' + ramRecPct + '%"></div>';
    html += '</div>';
    html += '<div class="rightsizing-resource-detail">' + ramAllocStr + ' &rarr; <span class="rec">' + ramRecStr + '</span></div>';
    html += '</div>';

    // Stats
    html += '<div class="rightsizing-stats">';
    html += '<div class="rightsizing-stat">CPU avg <span>' + r.cpu_avg_pct + '%</span> peak <span>' + r.cpu_peak_pct + '%</span></div>';
    html += '<div class="rightsizing-stat">RAM avg <span>' + r.ram_avg_pct + '%</span> peak <span>' + r.ram_peak_pct + '%</span></div>';
    html += '</div>';

    html += '</div>';
    return html;
  }).join('');
}

async function loadRightsizing() {
  try {
    var data = await fetch('/api/health/rightsizing').then(function(r) { return r.json(); });
    renderRightsizing(data.recommendations || []);
  } catch(e) {
    // silently fail
  }
}

// ── Chaos Engineering ──────────────────────────────────
var chaosState = {
  scenarios: [],
  simulation: null,
  activeRun: null,
  history: [],
  execStartTime: null,
  execTimerInterval: null,
  execLogEntries: [],
};

function loadChaosPanel() {
  loadChaosScenarios();
  loadChaosStatus();
  loadChaosHistory();
  populateChaosTargets();
}

async function loadChaosScenarios() {
  try {
    var res = await fetch('/api/chaos/scenarios');
    var data = await res.json();
    chaosState.scenarios = Array.isArray(data) ? data : (data.scenarios || []);
    var sel = document.getElementById('chaosScenarioSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">Select scenario...</option>';
    chaosState.scenarios.forEach(function(s) {
      var opt = document.createElement('option');
      opt.value = s.id || s.name || s;
      opt.textContent = s.label || s.name || s;
      sel.appendChild(opt);
    });
    updateChaosButtons();
  } catch(e) {}
}

function populateChaosTargets() {
  var sel = document.getElementById('chaosTargetSelect');
  if (!sel || !state.cluster) return;
  sel.innerHTML = '<option value="">Select target...</option>';
  var vms = (state.cluster.vms || []).filter(function(v) { return v.status === 'running'; });
  vms.forEach(function(vm) {
    var opt = document.createElement('option');
    opt.value = vm.vmid || vm.id;
    opt.textContent = (vm.name || 'VM') + ' (' + (vm.vmid || vm.id) + ')';
    sel.appendChild(opt);
  });
}

function updateChaosButtons() {
  var scenario = document.getElementById('chaosScenarioSelect');
  var target = document.getElementById('chaosTargetSelect');
  var simBtn = document.getElementById('chaosSimulateBtn');
  var execBtn = document.getElementById('chaosExecuteBtn');
  if (!scenario || !simBtn || !execBtn) return;
  var hasScenario = !!scenario.value;
  var hasTarget = !!target.value;
  simBtn.disabled = !hasScenario;
  execBtn.disabled = !chaosState.simulation || !hasScenario;
}

// Wire up select change events
document.getElementById('chaosScenarioSelect')?.addEventListener('change', function() {
  chaosState.simulation = null;
  document.getElementById('chaosSimResults')?.classList.remove('visible');
  document.getElementById('chaosResults')?.classList.remove('visible');
  updateChaosButtons();
});
document.getElementById('chaosTargetSelect')?.addEventListener('change', updateChaosButtons);

async function chaosSimulate() {
  var scenario = document.getElementById('chaosScenarioSelect')?.value;
  var target = document.getElementById('chaosTargetSelect')?.value;
  if (!scenario) return;
  var simBtn = document.getElementById('chaosSimulateBtn');
  if (simBtn) { simBtn.disabled = true; simBtn.textContent = 'Simulating...'; }
  try {
    var body = { scenario: scenario, params: {} };
    if (target) body.params.vmid = parseInt(target);
    var res = await fetch('/api/chaos/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = await res.json();
    if (data.error) { alert('Simulation error: ' + data.error); return; }
    chaosState.simulation = data;
    renderChaosSimulation(data);
  } catch(e) {
    alert('Failed to simulate: ' + e.message);
  } finally {
    if (simBtn) { simBtn.disabled = false; simBtn.textContent = 'Simulate'; }
    updateChaosButtons();
  }
}

function renderChaosSimulation(sim) {
  var panel = document.getElementById('chaosSimResults');
  if (!panel) return;

  // Blast radius list
  var blastList = document.getElementById('chaosBlastList');
  var affected = sim.blast_radius || sim.blastRadius || [];
  blastList.innerHTML = affected.map(function(item) {
    var impact = item.impact || 'direct';
    var dotClass = impact === 'direct' ? 'direct' : impact === 'indirect' ? 'indirect' : 'safe';
    return '<div class="chaos-blast-item">' +
      '<span class="chaos-blast-dot ' + dotClass + '"></span>' +
      '<span>' + escapeHtml(item.name || item.vmid || item.id || 'Unknown') + '</span>' +
      '<span style="margin-left:auto;color:var(--text-tertiary);font-size:0.71rem">' + escapeHtml(impact) + '</span>' +
    '</div>';
  }).join('');

  // Stats
  var recoveryTime = sim.predicted_recovery_time || sim.predictedRecoveryTime || '--';
  var riskScore = sim.risk_score != null ? sim.risk_score : (sim.riskScore != null ? sim.riskScore : '--');
  var riskClass = riskScore === '--' ? '' : riskScore <= 33 ? 'risk-low' : riskScore <= 66 ? 'risk-medium' : 'risk-high';

  document.getElementById('chaosSimStats').innerHTML =
    '<div class="chaos-sim-stat"><div class="chaos-sim-stat-label">Affected VMs</div><div class="chaos-sim-stat-value">' + affected.length + '</div></div>' +
    '<div class="chaos-sim-stat"><div class="chaos-sim-stat-label">Recovery Time</div><div class="chaos-sim-stat-value">' + escapeHtml(String(recoveryTime)) + '</div></div>' +
    '<div class="chaos-sim-stat"><div class="chaos-sim-stat-label">Risk Score</div><div class="chaos-sim-stat-value ' + riskClass + '">' + riskScore + '</div></div>';

  // Recommendation
  var rec = sim.recommendation || sim.message || 'Review the blast radius before executing.';
  document.getElementById('chaosSimRec').textContent = rec;

  panel.classList.add('visible');
}

async function chaosExecute() {
  var scenario = document.getElementById('chaosScenarioSelect')?.value;
  var target = document.getElementById('chaosTargetSelect')?.value;
  if (!scenario) return;
  if (!confirm('This will execute a destructive chaos test on your infrastructure. Continue?')) return;
  var execBtn = document.getElementById('chaosExecuteBtn');
  if (execBtn) { execBtn.disabled = true; execBtn.textContent = 'Starting...'; }
  try {
    var body = { scenario: scenario, params: {} };
    if (target) body.params.vmid = parseInt(target);
    var res = await fetch('/api/chaos/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = await res.json();
    if (data.error) { alert('Execution error: ' + data.error); return; }
    chaosState.activeRun = data;
    chaosState.execStartTime = Date.now();
    chaosState.execLogEntries = [];
    showChaosExecution(data);
    startChaosTimer();
  } catch(e) {
    alert('Failed to execute: ' + e.message);
  } finally {
    if (execBtn) { execBtn.textContent = 'Execute'; }
    updateChaosButtons();
  }
}

function showChaosExecution(run) {
  document.getElementById('chaosSimResults')?.classList.remove('visible');
  document.getElementById('chaosResults')?.classList.remove('visible');
  var panel = document.getElementById('chaosExecution');
  if (panel) panel.classList.add('visible');
  updateChaosExecPhase(run.phase || run.status || 'executing');
  addChaosLogEntry('Chaos test started: ' + (run.scenario || '') + ' (Run ID: ' + (run.run_id || run.id || '--') + ')');
}

function updateChaosExecPhase(phase) {
  var badge = document.getElementById('chaosExecBadge');
  if (badge) {
    badge.className = 'chaos-exec-status-badge ' + phase;
    badge.textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
  }
  var phases = ['executing', 'recovering', 'verifying', 'completed'];
  var idx = phases.indexOf(phase);
  document.querySelectorAll('.chaos-phase').forEach(function(el, i) {
    el.classList.remove('active', 'done', 'failed');
    if (phase === 'failed') {
      if (i <= Math.max(idx, 0)) el.classList.add('failed');
    } else if (i < idx) {
      el.classList.add('done');
    } else if (i === idx) {
      el.classList.add('active');
    }
  });
}

function startChaosTimer() {
  if (chaosState.execTimerInterval) clearInterval(chaosState.execTimerInterval);
  chaosState.execTimerInterval = setInterval(function() {
    if (!chaosState.execStartTime) return;
    var elapsed = Math.floor((Date.now() - chaosState.execStartTime) / 1000);
    var mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    var secs = String(elapsed % 60).padStart(2, '0');
    var el = document.getElementById('chaosExecTimer');
    if (el) el.textContent = mins + ':' + secs;
  }, 1000);
}

function stopChaosTimer() {
  if (chaosState.execTimerInterval) {
    clearInterval(chaosState.execTimerInterval);
    chaosState.execTimerInterval = null;
  }
}

function addChaosLogEntry(msg) {
  var now = new Date();
  var time = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0') + ':' + String(now.getSeconds()).padStart(2,'0');
  chaosState.execLogEntries.push({ time: time, msg: msg });
  var log = document.getElementById('chaosExecLog');
  if (!log) return;
  var entry = document.createElement('div');
  entry.className = 'chaos-log-entry';
  entry.innerHTML = '<span class="chaos-log-time">' + time + '</span>' + escapeHtml(msg);
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function handleChaosEvent(type, event) {
  var d = event.data || event;
  switch (type) {
    case 'chaos_simulated':
      // Handled via direct API response
      break;
    case 'chaos_started':
      chaosState.activeRun = d;
      chaosState.execStartTime = chaosState.execStartTime || Date.now();
      showChaosExecution(d);
      startChaosTimer();
      addChaosLogEntry('Chaos injection active');
      break;
    case 'chaos_recovery_detected':
      updateChaosExecPhase('recovering');
      addChaosLogEntry('Recovery detected: ' + (d.message || d.detail || 'System recovering'));
      break;
    case 'chaos_completed':
      updateChaosExecPhase('completed');
      stopChaosTimer();
      addChaosLogEntry('Chaos test completed');
      chaosState.activeRun = null;
      setTimeout(function() { renderChaosResults(d); }, 800);
      loadChaosHistory();
      updateChaosButtons();
      break;
    case 'chaos_failed':
      updateChaosExecPhase('failed');
      stopChaosTimer();
      addChaosLogEntry('Chaos test FAILED: ' + (d.error || d.message || 'Unknown error'));
      chaosState.activeRun = null;
      setTimeout(function() { renderChaosResults(d); }, 800);
      loadChaosHistory();
      updateChaosButtons();
      break;
  }
  // Also push to main event log
  handleEvent(event);
}

function renderChaosResults(data) {
  var panel = document.getElementById('chaosResults');
  if (!panel) return;

  // Verdict
  var verdict = (data.verdict || 'UNKNOWN').toUpperCase();
  var verdictClass = verdict === 'PASS' ? 'pass' : verdict === 'PARTIAL' ? 'partial' : 'fail';
  var verdictEl = document.getElementById('chaosVerdictValue');
  if (verdictEl) { verdictEl.textContent = verdict; verdictEl.className = 'chaos-verdict-value ' + verdictClass; }

  // Resilience score
  var score = data.resilience_score != null ? data.resilience_score : (data.resilienceScore != null ? data.resilienceScore : '--');
  var scoreEl = document.getElementById('chaosResilienceScore');
  if (scoreEl) {
    scoreEl.textContent = score !== '--' ? score + '%' : '--';
    scoreEl.style.color = score === '--' ? 'var(--text-tertiary)' : score >= 80 ? 'var(--teal)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
  }

  // Comparison: predicted vs actual
  var predicted = data.predicted_recovery_time || chaosState.simulation?.predicted_recovery_time || chaosState.simulation?.predictedRecoveryTime || '--';
  var actual = data.actual_recovery_time || data.actualRecoveryTime || '--';
  document.getElementById('chaosComparison').innerHTML =
    '<div class="chaos-compare-cell"><div class="chaos-compare-label">Predicted Recovery</div><div class="chaos-compare-value">' + escapeHtml(String(predicted)) + '</div></div>' +
    '<div class="chaos-compare-cell"><div class="chaos-compare-label">Actual Recovery</div><div class="chaos-compare-value">' + escapeHtml(String(actual)) + '</div></div>';

  // Event log
  var events = data.events || data.timeline || [];
  var logEl = document.getElementById('chaosEventLog');
  if (logEl) {
    logEl.innerHTML = events.map(function(evt) {
      var dotType = evt.type === 'incident' ? 'incident' : evt.type === 'heal' || evt.type === 'healing' ? 'heal' : 'action';
      return '<div class="chaos-event-entry">' +
        '<span class="chaos-event-dot ' + dotType + '"></span>' +
        '<span>' + escapeHtml(evt.message || evt.description || evt.type || '') + '</span>' +
      '</div>';
    }).join('');
  }

  document.getElementById('chaosExecution')?.classList.remove('visible');
  panel.classList.add('visible');
}

async function loadChaosStatus() {
  try {
    var res = await fetch('/api/chaos/status');
    var data = await res.json();
    if (data && data.run_id) {
      chaosState.activeRun = data;
      chaosState.execStartTime = data.started_at ? new Date(data.started_at).getTime() : Date.now();
      showChaosExecution(data);
      startChaosTimer();
    }
  } catch(e) {}
}

async function loadChaosHistory() {
  try {
    var res = await fetch('/api/chaos/history');
    var data = await res.json();
    chaosState.history = Array.isArray(data) ? data : (data.runs || []);
    renderChaosHistory();
  } catch(e) {}
}

function renderChaosHistory() {
  var list = document.getElementById('chaosHistoryList');
  var badge = document.getElementById('chaosHistoryCount');
  if (!list) return;
  if (badge) badge.textContent = chaosState.history.length;
  if (!chaosState.history.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);padding:24px;font-size:0.78rem">No past chaos runs</div>';
    return;
  }
  list.innerHTML = chaosState.history.map(function(run) {
    var verdict = (run.verdict || 'unknown').toUpperCase();
    var verdictColor = verdict === 'PASS' ? 'var(--teal)' : verdict === 'PARTIAL' ? 'var(--amber)' : 'var(--red)';
    var when = run.completed_at || run.started_at || '';
    var timeStr = when ? new Date(when).toLocaleString() : '--';
    return '<div class="chaos-history-item">' +
      '<span>' + escapeHtml(run.scenario || run.name || 'Unknown') + '</span>' +
      '<span style="color:' + verdictColor + ';font-weight:600">' + verdict + '</span>' +
      '<span class="chaos-history-meta">' + timeStr + '</span>' +
    '</div>';
  }).join('');
}

// ── Topology Map ────────────────────────────────────────

var topoState = {
  selectedVm: null,
  vmEffects: {},
  lastCluster: null,
};

function svgEl(tag, attrs) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) {
    var keys = Object.keys(attrs);
    for (var ki = 0; ki < keys.length; ki++) {
      el.setAttribute(keys[ki], String(attrs[keys[ki]]));
    }
  }
  return el;
}

function vmStatusColor(status) {
  if (status === 'running') return 'var(--teal)';
  if (status === 'stopped') return 'var(--red)';
  if (status === 'paused') return 'var(--amber)';
  return 'var(--text-tertiary)';
}

function vmStatusClass(status) {
  if (status === 'running') return 'running';
  if (status === 'stopped') return 'stopped';
  if (status === 'paused') return 'paused';
  return 'stopped';
}

function topoBarColor(pct) {
  if (pct > 85) return 'var(--red)';
  if (pct > 65) return 'var(--amber)';
  return 'var(--teal)';
}

function topoFmtBytes(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb + ' MB';
}

function topoFmtUptime(seconds) {
  if (!seconds || seconds < 0) return '-';
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

async function refreshTopology() {
  try {
    var data = await fetch('/api/cluster').then(function(r) { return r.json(); });
    topoState.lastCluster = data;
    renderTopology(data);
  } catch(e) {}
}

function renderTopology(data) {
  var svg = document.getElementById('topoSvg');
  if (!svg) return;
  var container = document.getElementById('topoContainer');
  var W = container.clientWidth || 900;

  var nodes = data.nodes || [];
  var vms = (data.vms || []).map(function(v) {
    if (!v.vmid && v.id) v.vmid = v.id;
    return v;
  });
  var storage = data.storage || [];

  var nodeBoxW = 220, nodeBoxH = 90;
  var vmBaseR = 18;
  var storageW = 140, storageH = 52;

  var nodeY = 60;
  var vmY = 240;
  var maxPerRow = 8;
  var maxVmsPerNode = 1;
  for (var ni = 0; ni < nodes.length; ni++) {
    var cnt = vms.filter(function(v) { return v.node === nodes[ni].name; }).length;
    if (cnt > maxVmsPerNode) maxVmsPerNode = cnt;
  }
  var vmRows = Math.ceil(maxVmsPerNode / maxPerRow);
  var storageY_base = vmY + vmRows * 80 + 100;
  var totalH = storageY_base + (storage.length > 0 ? storageH + 40 : 0) + 60;

  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + totalH);
  svg.style.minHeight = totalH + 'px';
  svg.innerHTML = '';

  // Defs
  var defs = svgEl('defs');
  var glowF = svgEl('filter', { id: 'topoGlow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  var feGB = svgEl('feGaussianBlur', { stdDeviation: '3', result: 'coloredBlur' });
  var feM = svgEl('feMerge');
  feM.appendChild(svgEl('feMergeNode', { 'in': 'coloredBlur' }));
  feM.appendChild(svgEl('feMergeNode', { 'in': 'SourceGraphic' }));
  glowF.appendChild(feGB);
  glowF.appendChild(feM);
  defs.appendChild(glowF);

  var grd = svgEl('radialGradient', { id: 'topoGridFade', cx: '50%', cy: '40%', r: '60%' });
  grd.appendChild(svgEl('stop', { offset: '0%', 'stop-color': 'rgba(10,205,170,0.04)' }));
  grd.appendChild(svgEl('stop', { offset: '100%', 'stop-color': 'rgba(10,205,170,0)' }));
  defs.appendChild(grd);
  svg.appendChild(defs);

  // Grid dots
  var gridG = svgEl('g', { opacity: '0.3' });
  for (var gx = 20; gx < W; gx += 30) {
    for (var gy = 20; gy < totalH; gy += 30) {
      gridG.appendChild(svgEl('circle', { cx: gx, cy: gy, r: 0.5, fill: 'var(--text-tertiary)' }));
    }
  }
  svg.appendChild(gridG);
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: totalH, fill: 'url(#topoGridFade)' }));

  // Section labels
  var lblG = svgEl('g');
  function mkLbl(text, x, y) {
    var t = svgEl('text', { x: x, y: y, fill: 'var(--text-tertiary)', 'font-family': 'var(--font-mono)', 'font-size': '9', 'letter-spacing': '0.1em', opacity: '0.5' });
    t.textContent = text;
    return t;
  }
  lblG.appendChild(mkLbl('NODES', 16, nodeY - 8));
  if (vms.length > 0) lblG.appendChild(mkLbl('VIRTUAL MACHINES', 16, vmY - 50));
  if (storage.length > 0) lblG.appendChild(mkLbl('STORAGE', 16, storageY_base - 8));
  svg.appendChild(lblG);

  // ---- Nodes ----
  var nodePositions = {};
  var nodeSpacing = Math.min(300, (W - 40) / Math.max(1, nodes.length));
  var nodeStartX = (W - nodeSpacing * (nodes.length - 1) - nodeBoxW) / 2;

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var nx = nodes.length === 1 ? (W - nodeBoxW) / 2 : nodeStartX + i * nodeSpacing;
    var ny = nodeY;
    nodePositions[node.name] = { x: nx + nodeBoxW / 2, y: ny + nodeBoxH / 2 };

    var g = svgEl('g', { class: 'topo-node-box', transform: 'translate(' + nx + ',' + ny + ')' });
    g.appendChild(svgEl('rect', { x: -2, y: -2, width: nodeBoxW + 4, height: nodeBoxH + 4, rx: 12, ry: 12, fill: 'none', stroke: 'var(--teal)', 'stroke-width': 0.5, opacity: 0.15 }));
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: nodeBoxW, height: nodeBoxH, class: 'topo-node-rect' }));

    var sCls = (node.status === 'online') ? 'online' : (node.status === 'offline' ? 'offline' : 'unknown');
    g.appendChild(svgEl('circle', { cx: 16, cy: 20, class: 'topo-status-dot ' + sCls }));

    var nt = svgEl('text', { x: 26, y: 24, class: 'topo-node-label' });
    nt.textContent = node.name;
    g.appendChild(nt);

    var cpuPct = node.cpu_usage_pct || node.cpu_pct || 0;
    g.appendChild(svgEl('rect', { x: 14, y: 38, width: nodeBoxW - 28, height: 6, class: 'topo-bar-bg' }));
    g.appendChild(svgEl('rect', { x: 14, y: 38, width: Math.max(1, (nodeBoxW - 28) * cpuPct / 100), height: 6, class: 'topo-bar-fill', fill: topoBarColor(cpuPct) }));
    var cl = svgEl('text', { x: 14, y: 35, class: 'topo-bar-label' });
    cl.textContent = 'CPU ' + Math.round(cpuPct) + '% (' + (node.cpu_cores || '?') + ' cores)';
    g.appendChild(cl);

    var ramTotal = node.ram_total_mb || node.ram_mb || 0;
    var ramUsed = node.ram_used_mb || 0;
    var ramPct = ramTotal > 0 ? (ramUsed / ramTotal) * 100 : 0;
    g.appendChild(svgEl('rect', { x: 14, y: 60, width: nodeBoxW - 28, height: 6, class: 'topo-bar-bg' }));
    g.appendChild(svgEl('rect', { x: 14, y: 60, width: Math.max(1, (nodeBoxW - 28) * ramPct / 100), height: 6, class: 'topo-bar-fill', fill: topoBarColor(ramPct) }));
    var rl = svgEl('text', { x: 14, y: 57, class: 'topo-bar-label' });
    rl.textContent = 'RAM ' + Math.round(ramPct) + '% (' + topoFmtBytes(ramTotal) + ')';
    g.appendChild(rl);

    svg.appendChild(g);
  }

  // ---- VMs ----
  for (var ndi = 0; ndi < nodes.length; ndi++) {
    var nd = nodes[ndi];
    var nodeVms = vms.filter(function(v) { return v.node === nd.name; });
    if (nodeVms.length === 0) continue;

    var nodeCx = nodePositions[nd.name].x;
    var nodeBy = nodePositions[nd.name].y + nodeBoxH / 2;

    for (var vi = 0; vi < nodeVms.length; vi++) {
      var vm = nodeVms[vi];
      var row = Math.floor(vi / maxPerRow);
      var inRow = vi % maxPerRow;
      var rowCount = Math.min(maxPerRow, nodeVms.length - row * maxPerRow);

      var hSpacing = Math.min(80, (W - 80) / Math.max(1, rowCount));
      var hStart = nodeCx - (rowCount - 1) * hSpacing / 2;
      var fx = hStart + inRow * hSpacing;
      var fy = vmY + row * 80;

      var ramMb = vm.ram_mb || (vm.maxmem ? vm.maxmem / (1024 * 1024) : 512);
      var r = Math.max(14, Math.min(32, vmBaseR + Math.log2(Math.max(1, ramMb / 512)) * 4));

      var cls = vmStatusClass(vm.status);

      // Connection line
      var line = svgEl('path', {
        d: 'M' + nodeCx + ',' + (nodeBy + 10) + ' C' + nodeCx + ',' + (nodeBy + 50) + ' ' + fx + ',' + (fy - 40) + ' ' + fx + ',' + (fy - r),
        class: 'topo-link ' + cls,
        'data-vmid': vm.vmid,
      });
      svg.appendChild(line);

      // VM group
      var vg = svgEl('g', { class: 'topo-vm-group', 'data-vmid': vm.vmid, transform: 'translate(' + fx + ',' + fy + ')' });

      if (cls === 'running') {
        vg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: r + 6, class: 'topo-vm-glow running', filter: 'url(#topoGlow)' }));
      }

      var effect = topoState.vmEffects[vm.vmid];
      if (effect) {
        if (effect.type === 'incident') {
          vg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: r + 5, class: 'topo-vm-incident-ring' }));
        } else if (effect.type === 'healing') {
          vg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: r + 5, class: 'topo-vm-healing-ring' }));
        } else if (effect.type === 'healed') {
          vg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: r + 5, class: 'topo-vm-healed-flash' }));
          if (Date.now() - effect.ts > 1500) delete topoState.vmEffects[vm.vmid];
        }
      }

      vg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: r, class: 'topo-vm-circle ' + cls }));

      var dName = vm.name || ('vm-' + vm.vmid);
      var sName = dName.length > 10 ? dName.substring(0, 9) + '..' : dName;
      var nmT = svgEl('text', { x: 0, y: r + 14, class: 'topo-vm-label' });
      nmT.textContent = sName;
      vg.appendChild(nmT);

      var idT = svgEl('text', { x: 0, y: r + 24, class: 'topo-vm-id-label' });
      idT.textContent = 'ID:' + vm.vmid;
      vg.appendChild(idT);

      (function(vmRef) {
        vg.addEventListener('mouseenter', function(e) { showTopoTooltip(e, vmRef); });
        vg.addEventListener('mousemove', function(e) { moveTopoTooltip(e); });
        vg.addEventListener('mouseleave', function() { hideTopoTooltip(); });
        vg.addEventListener('click', function() { selectTopoVm(vmRef); });
      })(vm);

      svg.appendChild(vg);
    }
  }

  // ---- Storage ----
  if (storage.length > 0) {
    var stSpacing = Math.min(160, (W - 40) / Math.max(1, storage.length));
    var stStartX = (W - stSpacing * (storage.length - 1) - storageW) / 2;

    for (var si = 0; si < storage.length; si++) {
      var st = storage[si];
      var sx = storage.length === 1 ? (W - storageW) / 2 : stStartX + si * stSpacing;
      var sy = storageY_base;

      var sg = svgEl('g', { transform: 'translate(' + sx + ',' + sy + ')' });
      sg.appendChild(svgEl('rect', { x: 0, y: 0, width: storageW, height: storageH, class: 'topo-storage-rect' }));

      var snT = svgEl('text', { x: 10, y: 16, class: 'topo-storage-label' });
      snT.textContent = st.storage || st.name || 'storage';
      sg.appendChild(snT);

      var tGB = st.total ? (st.total / (1024 * 1024 * 1024)).toFixed(0) : (st.total_gb || 0);
      var uGB = st.used ? (st.used / (1024 * 1024 * 1024)).toFixed(0) : (st.used_gb || 0);
      var spct = tGB > 0 ? (uGB / tGB * 100) : 0;

      var suT = svgEl('text', { x: 10, y: 28, class: 'topo-storage-sub' });
      suT.textContent = uGB + ' / ' + tGB + ' GB (' + Math.round(spct) + '%)';
      sg.appendChild(suT);

      var bW = storageW - 20;
      sg.appendChild(svgEl('rect', { x: 10, y: 35, width: bW, height: 5, class: 'topo-storage-bar-bg' }));
      sg.appendChild(svgEl('rect', { x: 10, y: 35, width: Math.max(1, bW * spct / 100), height: 5, class: 'topo-storage-bar-fill', fill: topoBarColor(spct) }));

      svg.appendChild(sg);
    }
  }

  if (topoState.selectedVm) highlightVm(topoState.selectedVm.vmid);
}

function showTopoTooltip(e, vm) {
  var tip = document.getElementById('topoTooltip');
  if (!tip) return;
  var dot = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + vmStatusColor(vm.status) + '"></span>';
  var rmb = vm.ram_mb || (vm.maxmem ? Math.round(vm.maxmem / (1024 * 1024)) : 0);
  var dsk = vm.disk_gb || (vm.maxdisk ? (vm.maxdisk / (1024 * 1024 * 1024)).toFixed(1) : '-');
  var upt = vm.uptime ? topoFmtUptime(vm.uptime) : '-';

  tip.innerHTML = '<div class="tt-title">' + dot + ' ' + escapeHtml(vm.name || 'VM ' + vm.vmid) + '</div>' +
    '<div class="tt-row"><span class="tt-key">VMID</span><span class="tt-val">' + vm.vmid + '</span></div>' +
    '<div class="tt-row"><span class="tt-key">Status</span><span class="tt-val">' + (vm.status || 'unknown') + '</span></div>' +
    '<div class="tt-row"><span class="tt-key">Node</span><span class="tt-val">' + (vm.node || '-') + '</span></div>' +
    '<div class="tt-row"><span class="tt-key">CPU</span><span class="tt-val">' + (vm.cpu_cores || vm.cpus || '-') + ' cores</span></div>' +
    '<div class="tt-row"><span class="tt-key">RAM</span><span class="tt-val">' + topoFmtBytes(rmb) + '</span></div>' +
    '<div class="tt-row"><span class="tt-key">Disk</span><span class="tt-val">' + dsk + ' GB</span></div>' +
    '<div class="tt-row"><span class="tt-key">Uptime</span><span class="tt-val">' + upt + '</span></div>';
  tip.classList.add('visible');
  moveTopoTooltip(e);
}

function moveTopoTooltip(e) {
  var tip = document.getElementById('topoTooltip');
  var container = document.getElementById('topoContainer');
  if (!tip || !container) return;
  var rect = container.getBoundingClientRect();
  var x = e.clientX - rect.left + 16;
  var y = e.clientY - rect.top - 10;
  var tw = tip.offsetWidth || 280;
  var th = tip.offsetHeight || 160;
  if (x + tw > rect.width) x = e.clientX - rect.left - tw - 16;
  if (y + th > rect.height) y = rect.height - th - 8;
  if (y < 0) y = 8;
  tip.style.transform = 'translate(' + x + 'px,' + y + 'px)';
}

function hideTopoTooltip() {
  var tip = document.getElementById('topoTooltip');
  if (tip) tip.classList.remove('visible');
}

function selectTopoVm(vm) {
  topoState.selectedVm = vm;
  highlightVm(vm.vmid);

  var panel = document.getElementById('topoDetailPanel');
  var content = document.getElementById('topoDetailContent');
  if (!panel || !content) return;

  var sCls = vmStatusClass(vm.status);
  var rmb = vm.ram_mb || (vm.maxmem ? Math.round(vm.maxmem / (1024 * 1024)) : 0);
  var dsk = vm.disk_gb || (vm.maxdisk ? (vm.maxdisk / (1024 * 1024 * 1024)).toFixed(1) : '-');
  var upt = vm.uptime ? topoFmtUptime(vm.uptime) : '-';
  var cpuU = vm.cpu_pct !== undefined ? Math.round(vm.cpu_pct) + '%' : (vm.cpu !== undefined ? (vm.cpu * 100).toFixed(1) + '%' : '-');

  content.innerHTML =
    '<div class="topo-detail-title">' + escapeHtml(vm.name || 'VM ' + vm.vmid) + '</div>' +
    '<div class="topo-detail-status"><div class="dot ' + sCls + '"></div> ' + (vm.status || 'unknown') + '</div>' +
    '<div class="topo-detail-section">' +
      '<div class="topo-detail-section-title">Identification</div>' +
      '<div class="topo-detail-row"><span class="dk">VMID</span><span class="dv">' + vm.vmid + '</span></div>' +
      '<div class="topo-detail-row"><span class="dk">Node</span><span class="dv">' + (vm.node || '-') + '</span></div>' +
      '<div class="topo-detail-row"><span class="dk">Type</span><span class="dv">' + (vm.type || 'qemu') + '</span></div>' +
    '</div>' +
    '<div class="topo-detail-section">' +
      '<div class="topo-detail-section-title">Resources</div>' +
      '<div class="topo-detail-row"><span class="dk">CPU Cores</span><span class="dv">' + (vm.cpu_cores || vm.cpus || '-') + '</span></div>' +
      '<div class="topo-detail-row"><span class="dk">CPU Usage</span><span class="dv">' + cpuU + '</span></div>' +
      '<div class="topo-detail-row"><span class="dk">RAM</span><span class="dv">' + topoFmtBytes(rmb) + '</span></div>' +
      '<div class="topo-detail-row"><span class="dk">Disk</span><span class="dv">' + dsk + ' GB</span></div>' +
    '</div>' +
    '<div class="topo-detail-section">' +
      '<div class="topo-detail-section-title">Runtime</div>' +
      '<div class="topo-detail-row"><span class="dk">Uptime</span><span class="dv">' + upt + '</span></div>' +
      '<div class="topo-detail-row"><span class="dk">PID</span><span class="dv">' + (vm.pid || '-') + '</span></div>' +
    '</div>';

  panel.classList.add('open');
}

function highlightVm(vmid) {
  document.querySelectorAll('.topo-link.highlight').forEach(function(el) { el.classList.remove('highlight'); });
  document.querySelectorAll('.topo-vm-group.selected').forEach(function(el) { el.classList.remove('selected'); });
  var link = document.querySelector('.topo-link[data-vmid="' + vmid + '"]');
  if (link) link.classList.add('highlight');
  var vmG = document.querySelector('.topo-vm-group[data-vmid="' + vmid + '"]');
  if (vmG) vmG.classList.add('selected');
}

// Close detail panel
(function() {
  var closeBtn = document.getElementById('topoDetailClose');
  if (closeBtn) closeBtn.addEventListener('click', function() {
    var p = document.getElementById('topoDetailPanel');
    if (p) p.classList.remove('open');
    topoState.selectedVm = null;
    document.querySelectorAll('.topo-link.highlight').forEach(function(el) { el.classList.remove('highlight'); });
  });
})();

// Topology SSE event handler
function handleTopoEvent(event) {
  if (!event || !event.type) return;
  var d = event.data || {};
  var vmid = d.vmid || d.vm_id;
  if (!vmid && d.target && typeof d.target === 'string') {
    var m = d.target.match(/(\\d{3,})/);
    if (m) vmid = parseInt(m[1]);
  }
  if (!vmid) return;

  switch(event.type) {
    case 'incident_opened':
      topoState.vmEffects[vmid] = { type: 'incident', ts: Date.now() };
      if (topoState.lastCluster) renderTopology(topoState.lastCluster);
      break;
    case 'healing_started':
      topoState.vmEffects[vmid] = { type: 'healing', ts: Date.now() };
      if (topoState.lastCluster) renderTopology(topoState.lastCluster);
      break;
    case 'healing_completed':
    case 'incident_resolved':
      topoState.vmEffects[vmid] = { type: 'healed', ts: Date.now() };
      if (topoState.lastCluster) renderTopology(topoState.lastCluster);
      setTimeout(function() { delete topoState.vmEffects[vmid]; if (topoState.lastCluster) renderTopology(topoState.lastCluster); }, 1500);
      break;
    case 'step_completed':
      topoState.vmEffects[vmid] = { type: 'healed', ts: Date.now() };
      if (topoState.lastCluster) renderTopology(topoState.lastCluster);
      setTimeout(function() { delete topoState.vmEffects[vmid]; if (topoState.lastCluster) renderTopology(topoState.lastCluster); }, 1500);
      break;
  }
}

// Patch handleEvent for topology
var _origHandleEvent = handleEvent;
handleEvent = function(event) {
  _origHandleEvent(event);
  handleTopoEvent(event);
};

// Patch handleHealthCheck for live node resource bars
var _origHandleHealthCheck = handleHealthCheck;
handleHealthCheck = function(d) {
  _origHandleHealthCheck(d);
  var tp = document.getElementById('tab-topology');
  if (tp && tp.classList.contains('active') && topoState.lastCluster) {
    if (d && d.nodes && topoState.lastCluster.nodes) {
      for (var hi = 0; hi < d.nodes.length; hi++) {
        var hn = d.nodes[hi];
        for (var ei = 0; ei < topoState.lastCluster.nodes.length; ei++) {
          var en = topoState.lastCluster.nodes[ei];
          if (en.name === hn.name || en.node === hn.node) {
            if (hn.cpu_pct !== undefined) en.cpu_pct = hn.cpu_pct;
            if (hn.ram_pct !== undefined) en.ram_pct = hn.ram_pct;
          }
        }
      }
      renderTopology(topoState.lastCluster);
    }
  }
};

// Auto-refresh topology every 30s
setInterval(function() {
  var tp = document.getElementById('tab-topology');
  if (tp && tp.classList.contains('active')) refreshTopology();
}, 30000);

// Initial topology load
refreshTopology();

// ── Command Palette (Cmd+K) ─────────────────────────────
(function() {
  var overlay = document.getElementById('cmdPaletteOverlay');
  var palette = document.getElementById('cmdPalette');
  var input = document.getElementById('cmdPaletteInput');
  var loading = document.getElementById('cmdPaletteLoading');
  var response = document.getElementById('cmdPaletteResponse');
  var responseBody = document.getElementById('cmdPaletteResponseBody');
  var chips = document.getElementById('cmdPaletteChips');
  var trigger = document.getElementById('cmdKTrigger');

  function openPalette() {
    overlay.classList.remove('closing');
    overlay.classList.add('open');
    // Reset state
    input.value = '';
    loading.classList.remove('visible');
    response.classList.remove('visible');
    chips.style.display = '';
    responseBody.className = 'cmd-palette-response-body';
    responseBody.textContent = '';
    setTimeout(function() { input.focus(); }, 50);
  }

  function closePalette() {
    overlay.classList.add('closing');
    setTimeout(function() {
      overlay.classList.remove('open', 'closing');
    }, 150);
  }

  function isPaletteOpen() {
    return overlay.classList.contains('open');
  }

  async function sendCommand(command) {
    if (!command.trim()) return;
    // Show loading, hide chips
    chips.style.display = 'none';
    response.classList.remove('visible');
    loading.classList.add('visible');

    try {
      var res = await fetch('/api/agent/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command.trim() }),
      });
      var data = await res.json();
      loading.classList.remove('visible');
      response.classList.add('visible');

      if (!res.ok || data.error) {
        responseBody.className = 'cmd-palette-response-body error';
        responseBody.textContent = data.error || 'Request failed (HTTP ' + res.status + ')';
      } else {
        responseBody.className = 'cmd-palette-response-body success';
        // Format the result
        var lines = [];
        if (data.success !== undefined) lines.push(data.success ? 'Completed successfully' : 'Completed with errors');
        if (data.steps_completed !== undefined) lines.push('Steps completed: ' + data.steps_completed);
        if (data.steps_failed) lines.push('Steps failed: ' + data.steps_failed);
        if (data.duration_ms) lines.push('Duration: ' + (data.duration_ms / 1000).toFixed(1) + 's');
        if (data.plan && data.plan.reasoning) lines.push('\\nReasoning: ' + data.plan.reasoning);
        if (data.plan && data.plan.steps) {
          lines.push('\\nPlan:');
          data.plan.steps.forEach(function(s, i) {
            lines.push('  ' + (i + 1) + '. ' + s.description + (s.status ? ' [' + s.status + ']' : ''));
          });
        }
        if (data.outputs && data.outputs.length) {
          lines.push('\\nOutputs:');
          data.outputs.forEach(function(o) {
            if (o.summary) lines.push('  - ' + o.summary);
            if (o.output) lines.push('    ' + (typeof o.output === 'string' ? o.output : JSON.stringify(o.output)));
          });
        }
        if (data.errors && data.errors.length) {
          lines.push('\\nErrors:');
          data.errors.forEach(function(e) { lines.push('  - ' + e); });
        }
        responseBody.textContent = lines.join('\\n');
      }
    } catch (err) {
      loading.classList.remove('visible');
      response.classList.add('visible');
      responseBody.className = 'cmd-palette-response-body error';
      responseBody.textContent = 'Network error: ' + err.message;
    }
  }

  // Keyboard shortcut: Cmd+K / Ctrl+K
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      e.stopPropagation();
      if (isPaletteOpen()) {
        closePalette();
      } else {
        openPalette();
      }
    }
    if (e.key === 'Escape' && isPaletteOpen()) {
      e.preventDefault();
      closePalette();
    }
  });

  // Click overlay to close
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closePalette();
  });

  // Trigger button
  trigger.addEventListener('click', function() {
    openPalette();
  });

  // Enter to submit
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCommand(input.value);
    }
  });

  // Suggestion chips
  chips.addEventListener('click', function(e) {
    var chip = e.target.closest('.cmd-palette-chip');
    if (chip) {
      var cmd = chip.getAttribute('data-cmd');
      input.value = cmd;
      sendCommand(cmd);
    }
  });
})();

// ── Shadow Mode Banner ─────────────────────────────────
// Reflect /api/agent/status.shadow_mode in the top banner. We poll a
// little aggressively at startup so operators see the banner on first
// load; afterwards we settle into a 30s cadence.
function refreshShadowBanner() {
  fetch('/api/agent/status').then(function(r) { return r.json(); }).then(function(d) {
    var b = document.getElementById('shadowModeBanner');
    if (!b) return;
    b.style.display = (d && d.shadow_mode) ? 'block' : 'none';
  }).catch(function() { /* ignore — banner just stays in its last state */ });
}
refreshShadowBanner();
setInterval(refreshShadowBanner, 30000);

// ── Init ───────────────────────────────────────────────
connect();
pollCluster();
loadIncidents();
loadPendingApprovals();
loadPredictions();
setInterval(pollCluster, 10000);
setInterval(updateGov, 5000);
setInterval(function() { updateIncidentBadge(); renderActiveIncidents(); renderPendingApprovals(); }, 15000); // refresh time-ago
setInterval(loadPendingApprovals, 10000);
setInterval(loadPredictions, 30000);
loadRightsizing();
setInterval(loadRightsizing, 30000);
</script>
</body>
</html>`;
}
