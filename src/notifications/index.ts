// ============================================================
// RHODES — Notifications: public surface
// ============================================================

export type {
  Alert,
  AlertKind,
  AlertProvider,
  NotificationDeliveryResult,
} from "./types.js";

export { Notifier, type NotifierOptions, type NotifierStatus } from "./notifier.js";
export { NoneProvider } from "./providers/none.js";
export { SupraProvider, type SupraProviderOptions } from "./providers/supra.js";
export {
  TelegramDirectProvider,
  type TelegramDirectProviderOptions,
} from "./providers/telegram-direct.js";

export {
  formatAutopilotEvent,
  formatPlanGenerated,
  formatApprovalNeeded,
  formatExecutionOutcome,
  formatHealthCheckFailure,
  buildPlanDeepLink,
  type AutopilotEventContext,
  type ApprovalContext,
  type ExecutionOutcomeContext,
  type HealthCheckContext,
  type PlanSummary,
} from "./format.js";

export { attachAlertBridge, type AlertBridgeOptions } from "./event-bridge.js";
export { HealthzServer, type HealthzOptions } from "./healthz.js";

import { Notifier } from "./notifier.js";
import { getConfig } from "../config.js";

/**
 * Lazy singleton that reads notification config from getConfig() and
 * returns a process-wide Notifier. Most call sites should use this so
 * we don't construct multiple providers (and multiple websockets to
 * Supra) per process.
 */
let _notifier: Notifier | null = null;
export function getNotifier(): Notifier {
  if (_notifier) return _notifier;
  const cfg = getConfig();
  _notifier = new Notifier({
    provider: cfg.notifications.provider,
    supra: {
      url: cfg.notifications.supraUrl,
      userId: cfg.notifications.supraUserId,
    },
    telegram: {
      botToken: cfg.notifications.telegramBotToken,
      chatId: cfg.notifications.telegramChatId,
    },
  });
  return _notifier;
}

/** Reset the singleton — for tests only. */
export function __resetNotifier(): void {
  _notifier = null;
}
