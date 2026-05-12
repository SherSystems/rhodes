// ============================================================
// RHODES — Notifications: shared types
// ============================================================

/**
 * What kind of operational moment triggered this alert. Used so providers
 * can format/highlight the message consistently regardless of who sent it.
 */
export type AlertKind =
  | "event"
  | "plan_generated"
  | "approval_needed"
  | "execution_complete"
  | "execution_failed"
  | "health_check_failed";

export interface Alert {
  /** Brief one-line subject; surfaces in Telegram preview. */
  title: string;
  /** Full alert body. Plain text or lightweight Markdown. */
  body: string;
  kind: AlertKind;
  /** When the underlying event fired (ISO 8601). Defaults to now. */
  timestamp?: string;
  /** Optional structured payload (host, vmid, plan_id, etc.). */
  context?: Record<string, unknown>;
  /** Optional deep link a human can click in the alert. */
  link?: string;
}

export interface NotificationDeliveryResult {
  /** Did the provider believe delivery succeeded? */
  delivered: boolean;
  /** Provider id (`none`, `supra`, `telegram_direct`). */
  provider: string;
  /** Whatever the upstream API returned (best-effort, may be partial). */
  response?: unknown;
  /** Error message if delivery failed; absent on success. */
  error?: string;
}

/**
 * Minimal contract every alert provider implements. Keep it tight so we
 * can stub it in tests without dragging a real fetch in.
 */
export interface AlertProvider {
  /** Stable id used for logs and the /healthz feed. */
  readonly id: string;
  send(alert: Alert): Promise<NotificationDeliveryResult>;
}
