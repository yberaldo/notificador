import type { IncidentOutboxEntry, IncidentOutboxEntryStatus } from "./outbox-types.js";

export const DISPATCH_OUTBOX_COMMAND_NAME = "radio-cabrito-dispatch-outbox";
export const DISPATCH_OUTBOX_COMMAND_VERSION = "v1";

export const DEFAULT_DISPATCH_LOCK_TTL_MS = 10 * 60 * 1_000;
export const DEFAULT_DISPATCH_RETRY_BASE_MS = 5 * 60 * 1_000;
export const DEFAULT_DISPATCH_RETRY_MAX_MS = 6 * 60 * 60 * 1_000;
export const DEFAULT_DISPATCH_MAX_ATTEMPTS = 10;
export const DEFAULT_DISPATCH_ADAPTER = "log";
export const DEFAULT_DISPATCH_NOOP_MODE = "success";

export type DispatchAdapterName = "log" | "noop";
export type DispatchNoopMode = "success" | "retryable_error" | "permanent_error";
export type DispatchAdapterOutcome = "success" | "retryable_error" | "permanent_error";

export interface DispatchAdapterResult {
  outcome: DispatchAdapterOutcome;
  message: string | null;
  logMessage?: string | null;
}

export interface DispatchAdapter {
  name: DispatchAdapterName;
  dispatch(entry: IncidentOutboxEntry): Promise<DispatchAdapterResult>;
}

export interface DispatchOutboxOptions {
  outboxFilePath?: string | null;
  adapter?: DispatchAdapterName;
  noopMode?: DispatchNoopMode;
  lockTtlMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  pid?: number;
  onAdapterLog?: (message: string) => void;
  adapterOverride?: DispatchAdapter;
}

export interface DispatchLockInfo {
  path: string;
  pid: number | null;
  createdAt: string | null;
  expiresAt: string | null;
  acquired: boolean;
  skippedBecauseLocked: boolean;
  replacedExpired: boolean;
  released: boolean;
  error: string | null;
}

export interface DispatchProcessedEvent {
  dedupeKey: string;
  eventId: string;
  targetId: string;
  type: IncidentOutboxEntry["type"];
  previousStatus: IncidentOutboxEntryStatus;
  finalStatus: IncidentOutboxEntryStatus;
  attempts: number;
  lastError: string | null;
}

export interface DispatchSummary {
  loadedCount: number;
  eligibleCount: number;
  processedCount: number;
  sentCount: number;
  failedCount: number;
  discardedCount: number;
  skippedBecauseLocked: boolean;
  writeSucceeded: boolean;
  writeError: string | null;
}

export interface DispatchOutboxResult {
  commandName: string;
  commandVersion: string;
  outboxPath: string;
  adapter: DispatchAdapterName;
  lock: DispatchLockInfo;
  summary: DispatchSummary;
  processedEvents: DispatchProcessedEvent[];
}