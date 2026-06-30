import { acquireDispatchLock } from "./dispatch-lock.js";
import { createLogDispatchAdapter } from "./dispatch-adapters/log.js";
import { createNoopDispatchAdapter } from "./dispatch-adapters/noop.js";
import { createTelegramDispatchAdapter } from "./dispatch-adapters/telegram.js";
import {
  DEFAULT_DISPATCH_ADAPTER,
  DEFAULT_DISPATCH_LOCK_TTL_MS,
  DEFAULT_DISPATCH_MAX_ATTEMPTS,
  DEFAULT_DISPATCH_NOOP_MODE,
  DEFAULT_DISPATCH_RETRY_BASE_MS,
  DEFAULT_DISPATCH_RETRY_MAX_MS,
  DISPATCH_OUTBOX_COMMAND_NAME,
  DISPATCH_OUTBOX_COMMAND_VERSION,
  type DispatchAdapter,
  type DispatchAdapterName,
  type DispatchAdapterResult,
  type DispatchLockInfo,
  type DispatchOutboxOptions,
  type DispatchOutboxResult,
  type DispatchProcessedEvent,
  type DispatchSummary,
  type DispatchTelegramConfig
} from "./dispatch-types.js";
import { loadIncidentOutbox, resolveIncidentOutboxPath, saveIncidentOutbox } from "./outbox-store.js";
import type { IncidentOutboxEntry, IncidentOutboxSnapshot } from "./outbox-types.js";

interface NormalizedDispatchOptions {
  outboxFilePath?: string | null;
  adapter: DispatchAdapterName;
  noopMode: DispatchOutboxOptions["noopMode"];
  telegram?: DispatchTelegramConfig;
  lockTtlMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxAttempts: number;
  now: () => Date;
  pid: number;
  onAdapterLog?: (message: string) => void;
  adapterOverride?: DispatchAdapter;
}

export async function dispatchIncidentOutbox(options: DispatchOutboxOptions = {}): Promise<DispatchOutboxResult> {
  const normalizedOptions = normalizeDispatchOptions(options);
  const outboxPath = resolveIncidentOutboxPath(normalizedOptions.outboxFilePath).filePath;
  const lockPath = `${outboxPath}.lock`;
  const result = createDispatchOutboxResult(outboxPath, normalizedOptions.adapter, lockPath);
  let adapter: DispatchAdapter;

  try {
    adapter = normalizedOptions.adapterOverride
      ?? resolveDispatchAdapter(normalizedOptions.adapter, normalizedOptions.noopMode, normalizedOptions.telegram);
  } catch (error) {
    setCriticalError(result, formatError(error));
    return result;
  }

  const lockHandle = await acquireDispatchLock({
    filePath: lockPath,
    ttlMs: normalizedOptions.lockTtlMs,
    pid: normalizedOptions.pid,
    now: normalizedOptions.now
  });

  result.lock = lockHandle.descriptor;

  if (!lockHandle.descriptor.acquired) {
    result.summary.skippedBecauseLocked = lockHandle.descriptor.skippedBecauseLocked;

    if (!lockHandle.descriptor.skippedBecauseLocked) {
      setCriticalError(result, lockHandle.descriptor.error ?? "Nao foi possivel adquirir o lock do dispatcher.");
    }

    return result;
  }

  try {
    const loadedAt = normalizedOptions.now().toISOString();
    const { outbox, meta } = await loadIncidentOutbox(outboxPath, loadedAt);

    if (meta.loadSource === "fresh" && meta.loadError) {
      setCriticalError(result, `Nao foi possivel carregar o outbox com seguranca: ${meta.loadError}`);
      return result;
    }

    const snapshot = cloneOutboxSnapshot(outbox, loadedAt);
    result.summary.loadedCount = snapshot.entries.length;

    const eligibleEntries = snapshot.entries
      .filter((entry) => isEligibleForDispatch(entry, normalizedOptions.now(), normalizedOptions.retryBaseMs, normalizedOptions.retryMaxMs))
      .sort(compareOutboxEntries);

    result.summary.eligibleCount = eligibleEntries.length;

    for (const entry of eligibleEntries) {
      const previousStatus = entry.status;

      if (entry.attempts >= normalizedOptions.maxAttempts) {
        const discardedAt = normalizedOptions.now().toISOString();
        entry.status = "discarded";
        entry.discardedAt = discardedAt;
        entry.updatedAt = discardedAt;
        entry.lastError = `descartado sem nova tentativa: maxAttempts=${normalizedOptions.maxAttempts} atingido`;

        const discardWrite = await persistOutboxSnapshot(outboxPath, snapshot, discardedAt);
        recordProcessedEvent(result.processedEvents, entry, previousStatus);

        if (!discardWrite.writeSucceeded) {
          setCriticalError(result, discardWrite.writeError ?? "Nao foi possivel salvar o outbox ao descartar evento excedido.");
          return result;
        }

        continue;
      }

      const attemptAt = normalizedOptions.now().toISOString();
      entry.attempts += 1;
      entry.lastAttemptAt = attemptAt;
      entry.updatedAt = attemptAt;

      const attemptWrite = await persistOutboxSnapshot(outboxPath, snapshot, attemptAt);

      if (!attemptWrite.writeSucceeded) {
        setCriticalError(result, attemptWrite.writeError ?? "Nao foi possivel salvar o outbox antes da tentativa de envio.");
        return result;
      }

      const adapterResult = await dispatchWithAdapter(adapter, entry);

      if (adapterResult.logMessage && normalizedOptions.onAdapterLog) {
        normalizedOptions.onAdapterLog(adapterResult.logMessage);
      }

      const finalizedAt = normalizedOptions.now().toISOString();
      applyAdapterResult(entry, adapterResult, finalizedAt);

      const finalWrite = await persistOutboxSnapshot(outboxPath, snapshot, finalizedAt);
      recordProcessedEvent(result.processedEvents, entry, previousStatus);

      if (!finalWrite.writeSucceeded) {
        setCriticalError(result, finalWrite.writeError ?? "Nao foi possivel salvar o outbox apos a tentativa de envio.");
        return result;
      }
    }

    return result;
  } catch (error) {
    setCriticalError(result, formatError(error));
    return result;
  } finally {
    const releasedLock = await lockHandle.release();
    result.lock = releasedLock;

    if (releasedLock.error) {
      setCriticalError(result, releasedLock.error);
    }

    updateSummaryCounts(result.summary, result.processedEvents);
  }
}

export function calculateRetryDelayMs(attempts: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(attempts - 1, 0);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

export function isEligibleForDispatch(
  entry: IncidentOutboxEntry,
  now: Date,
  retryBaseMs: number,
  retryMaxMs: number
): boolean {
  if (entry.status === "pending") {
    return true;
  }

  if (entry.status !== "failed") {
    return false;
  }

  const referenceTimestamp = parseTimestamp(entry.lastAttemptAt ?? entry.updatedAt ?? entry.queuedAt);
  const retryDelayMs = calculateRetryDelayMs(entry.attempts, retryBaseMs, retryMaxMs);

  return referenceTimestamp + retryDelayMs <= now.getTime();
}

function normalizeDispatchOptions(options: DispatchOutboxOptions): NormalizedDispatchOptions {
  const retryBaseMs = normalizePositiveInteger(options.retryBaseMs, DEFAULT_DISPATCH_RETRY_BASE_MS);
  const retryMaxMs = Math.max(retryBaseMs, normalizePositiveInteger(options.retryMaxMs, DEFAULT_DISPATCH_RETRY_MAX_MS));

  return {
    outboxFilePath: options.outboxFilePath,
    adapter: options.adapter ?? DEFAULT_DISPATCH_ADAPTER,
    noopMode: options.noopMode ?? DEFAULT_DISPATCH_NOOP_MODE,
    telegram: options.telegram,
    lockTtlMs: normalizePositiveInteger(options.lockTtlMs, DEFAULT_DISPATCH_LOCK_TTL_MS),
    retryBaseMs,
    retryMaxMs,
    maxAttempts: normalizePositiveInteger(options.maxAttempts, DEFAULT_DISPATCH_MAX_ATTEMPTS),
    now: options.now ?? (() => new Date()),
    pid: options.pid ?? process.pid,
    onAdapterLog: options.onAdapterLog,
    adapterOverride: options.adapterOverride
  };
}

function resolveDispatchAdapter(
  adapterName: DispatchAdapterName,
  noopMode: DispatchOutboxOptions["noopMode"],
  telegram?: DispatchTelegramConfig
): DispatchAdapter {
  if (adapterName === "telegram") {
    return createTelegramDispatchAdapter(telegram);
  }

  if (adapterName === "noop") {
    return createNoopDispatchAdapter(noopMode ?? DEFAULT_DISPATCH_NOOP_MODE);
  }

  return createLogDispatchAdapter();
}

async function dispatchWithAdapter(adapter: DispatchAdapter, entry: IncidentOutboxEntry): Promise<DispatchAdapterResult> {
  try {
    return await adapter.dispatch({ ...entry });
  } catch (error) {
    return {
      outcome: "retryable_error",
      message: `adapter ${adapter.name} falhou com excecao: ${formatError(error)}`
    };
  }
}

function applyAdapterResult(entry: IncidentOutboxEntry, result: DispatchAdapterResult, finalizedAt: string): void {
  entry.updatedAt = finalizedAt;

  if (result.outcome === "success") {
    entry.status = "sent";
    entry.sentAt = finalizedAt;
    entry.lastError = null;
    return;
  }

  if (result.outcome === "permanent_error") {
    entry.status = "discarded";
    entry.discardedAt = finalizedAt;
    entry.lastError = result.message ?? "erro permanente sem detalhe";
    return;
  }

  entry.status = "failed";
  entry.lastError = result.message ?? "erro retryable sem detalhe";
}

async function persistOutboxSnapshot(outboxPath: string, snapshot: IncidentOutboxSnapshot, updatedAt: string) {
  snapshot.updatedAt = updatedAt;
  return saveIncidentOutbox(outboxPath, snapshot);
}

function cloneOutboxSnapshot(outbox: IncidentOutboxSnapshot, updatedAt: string): IncidentOutboxSnapshot {
  return {
    ...outbox,
    updatedAt,
    entries: outbox.entries.map((entry) => ({ ...entry }))
  };
}

function compareOutboxEntries(left: IncidentOutboxEntry, right: IncidentOutboxEntry): number {
  const queuedOrder = left.queuedAt.localeCompare(right.queuedAt);

  if (queuedOrder !== 0) {
    return queuedOrder;
  }

  return left.eventId.localeCompare(right.eventId);
}

function recordProcessedEvent(
  processedEvents: DispatchProcessedEvent[],
  entry: IncidentOutboxEntry,
  previousStatus: IncidentOutboxEntry["status"]
): void {
  processedEvents.push({
    dedupeKey: entry.dedupeKey,
    eventId: entry.eventId,
    targetId: entry.targetId,
    type: entry.type,
    previousStatus,
    finalStatus: entry.status,
    attempts: entry.attempts,
    lastError: entry.lastError
  });
}

function updateSummaryCounts(summary: DispatchSummary, processedEvents: readonly DispatchProcessedEvent[]): void {
  summary.processedCount = processedEvents.length;
  summary.sentCount = processedEvents.filter((event) => event.finalStatus === "sent").length;
  summary.failedCount = processedEvents.filter((event) => event.finalStatus === "failed").length;
  summary.discardedCount = processedEvents.filter((event) => event.finalStatus === "discarded").length;
}

function createDispatchOutboxResult(
  outboxPath: string,
  adapter: DispatchAdapterName,
  lockPath: string
): DispatchOutboxResult {
  return {
    commandName: DISPATCH_OUTBOX_COMMAND_NAME,
    commandVersion: DISPATCH_OUTBOX_COMMAND_VERSION,
    outboxPath,
    adapter,
    lock: createInitialLockInfo(lockPath),
    summary: {
      loadedCount: 0,
      eligibleCount: 0,
      processedCount: 0,
      sentCount: 0,
      failedCount: 0,
      discardedCount: 0,
      skippedBecauseLocked: false,
      writeSucceeded: true,
      writeError: null
    },
    processedEvents: []
  };
}

function createInitialLockInfo(lockPath: string): DispatchLockInfo {
  return {
    path: lockPath,
    pid: null,
    createdAt: null,
    expiresAt: null,
    acquired: false,
    skippedBecauseLocked: false,
    replacedExpired: false,
    released: false,
    error: null
  };
}

function setCriticalError(result: DispatchOutboxResult, error: string): void {
  result.summary.writeSucceeded = false;
  result.summary.writeError = error;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}