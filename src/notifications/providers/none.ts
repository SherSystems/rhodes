// ============================================================
// RHODES — Notifications: NoneProvider
// Logs-only delivery. Used when running detached / in CI / offline.
// ============================================================

import type { Alert, AlertProvider, NotificationDeliveryResult } from "../types.js";

export class NoneProvider implements AlertProvider {
  readonly id = "none";

  async send(alert: Alert): Promise<NotificationDeliveryResult> {
    // Log to stdout so operators tailing journalctl/docker logs still
    // see what would have been sent. One-line preview, multi-line body.
    console.log(`[notify:none] ${alert.kind} ${alert.title}`);
    if (alert.body && alert.body !== alert.title) {
      for (const line of alert.body.split("\n")) {
        console.log(`[notify:none] | ${line}`);
      }
    }
    return { delivered: true, provider: this.id };
  }
}
