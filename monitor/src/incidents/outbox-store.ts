import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INCIDENT_OUTBOX_SCHEMA_VERSION,
  type IncidentOutboxEntry,
  type IncidentOutboxSnapshot,
  type IncidentOutboxStoreMeta,
  type IncidentOutboxUpsertResult,
  type NotifiableEventOutboxPayload
} from "./outbox-types.js";

const DEFAULT_OUTBOX_FILE_URL = new URL("../../data/notifiable-events-outbox.json", import.meta.url);

interface LoadedOutboxResult {
  outbox: IncidentOutboxSnapshot;
  meta: Omit<IncidentOutboxStoreMeta, "path" | "queuedCount" | "duplicateCount" | "entryCount" | "writeSucceeded" | "writeError">;
}

type ReadOutboxAttempt =
  | { kind: "ok"; outbox: IncidentOutboxSnapshot }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export const DEFAULT_INCIDENT_OUTBOX_PATH = fileURLToPath(DEFAULT_OUTBOX_FILE_URL);
export const DEFAULT_INCIDENT_OUTBOX_DISPLAY_PATH = "data/notifiable-events-outbox.json";

export function resolveIncidentOutboxPath(
  configuredPath?: string | null,
  baseDirectory: string = process.cwd()
): { filePath: string; displayPath: string } {
  const normalizedConfiguredPath = typeof configuredPath === "string" ? configuredPath.trim() : "";

  if (!normalizedConfiguredPath) {
    return {
      filePath: DEFAULT_INCIDENT_OUTBOX_PATH,
      displayPath: DEFAULT_INCIDENT_OUTBOX_DISPLAY_PATH
    };
  }

  const filePath = path.isAbsolute(normalizedConfiguredPath)
    ? normalizedConfiguredPath
    : path.resolve(baseDirectory, normalizedConfiguredPath);

  return {
    filePath,
    displayPath: filePath
  };
}

export function createEmptyIncidentOutboxSnapshot(updatedAt: string): IncidentOutboxSnapshot {
  return {
    schemaVersion: INCIDENT_OUTBOX_SCHEMA_VERSION,
    updatedAt,
    entries: []
  };
}

export async function loadIncidentOutbox(
  filePath: string,
  updatedAt: string
): Promise<LoadedOutboxResult> {
  const emptyOutbox = createEmptyIncidentOutboxSnapshot(updatedAt);
  const primaryAttempt = await readOutboxFromPath(filePath);

  if (primaryAttempt.kind === "ok") {
    return {
      outbox: primaryAttempt.outbox,
      meta: {
        loadSource: "primary",
        recoveredFromCorruption: false,
        loadError: null
      }
    };
  }

  const backupPath = `${filePath}.bak`;
  const backupAttempt = await readOutboxFromPath(backupPath);

  if (backupAttempt.kind === "ok") {
    return {
      outbox: backupAttempt.outbox,
      meta: {
        loadSource: "backup",
        recoveredFromCorruption: primaryAttempt.kind === "error",
        loadError: primaryAttempt.kind === "error" ? primaryAttempt.message : null
      }
    };
  }

  return {
    outbox: emptyOutbox,
    meta: {
      loadSource: "fresh",
      recoveredFromCorruption: primaryAttempt.kind === "error" || backupAttempt.kind === "error",
      loadError: primaryAttempt.kind === "error" ? primaryAttempt.message : backupAttempt.kind === "error" ? backupAttempt.message : null
    }
  };
}

export function upsertIncidentOutboxEntries(
  snapshot: IncidentOutboxSnapshot,
  events: readonly NotifiableEventOutboxPayload[],
  observedAt: string
): IncidentOutboxUpsertResult {
  const entries = snapshot.entries.map((entry) => ({ ...entry }));
  const indexesByDedupeKey = new Map(entries.map((entry, index) => [entry.dedupeKey, index]));
  let queuedCount = 0;
  let duplicateCount = 0;

  for (const event of events) {
    const existingIndex = indexesByDedupeKey.get(event.dedupeKey);

    if (existingIndex === undefined) {
      entries.push(createOutboxEntry(event, observedAt));
      indexesByDedupeKey.set(event.dedupeKey, entries.length - 1);
      queuedCount += 1;
      continue;
    }

    duplicateCount += 1;
    entries[existingIndex] = {
      ...entries[existingIndex],
      updatedAt: observedAt,
      lastSeenAt: event.occurredAt
    };
  }

  return {
    outbox: {
      schemaVersion: INCIDENT_OUTBOX_SCHEMA_VERSION,
      updatedAt: observedAt,
      entries
    },
    queuedCount,
    duplicateCount
  };
}

export async function saveIncidentOutbox(
  filePath: string,
  outbox: IncidentOutboxSnapshot
): Promise<Pick<IncidentOutboxStoreMeta, "writeSucceeded" | "writeError">> {
  const directoryPath = path.dirname(filePath);
  const backupPath = `${filePath}.bak`;
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await mkdir(directoryPath, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(outbox, null, 2)}\n`, { mode: 0o600 });
    await tryApplyPrivatePermissions(tempPath);

    if (await pathExists(filePath)) {
      await rm(backupPath, { force: true });
      await copyFile(filePath, backupPath, fsConstants.COPYFILE_FICLONE_FORCE).catch(async () => {
        await copyFile(filePath, backupPath);
      });
      await tryApplyPrivatePermissions(backupPath);
    }

    await replaceFile(tempPath, filePath);
    await tryApplyPrivatePermissions(filePath);

    return {
      writeSucceeded: true,
      writeError: null
    };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    return {
      writeSucceeded: false,
      writeError: error instanceof Error ? error.message : String(error)
    };
  }
}

function createOutboxEntry(
  event: NotifiableEventOutboxPayload,
  queuedAt: string
): IncidentOutboxEntry {
  return {
    dedupeKey: event.dedupeKey,
    eventId: event.eventId,
    incidentId: event.incidentId,
    targetId: event.targetId,
    targetName: event.targetName,
    type: event.type,
    status: "pending",
    reason: event.reason,
    severity: event.severity,
    occurredAt: event.occurredAt,
    streakCount: event.streakCount,
    queuedAt,
    updatedAt: queuedAt,
    lastSeenAt: event.occurredAt,
    attempts: 0,
    lastAttemptAt: null,
    sentAt: null,
    discardedAt: null,
    lastError: null
  };
}

async function replaceFile(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    if (!isWindowsRenameConflict(error)) {
      throw error;
    }

    await rm(destinationPath, { force: true });
    await rename(sourcePath, destinationPath);
  }
}

async function readOutboxFromPath(filePath: string): Promise<ReadOutboxAttempt> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return {
      kind: "ok",
      outbox: normalizeOutboxSnapshot(parsed)
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return { kind: "missing" };
    }

    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function normalizeOutboxSnapshot(parsed: unknown): IncidentOutboxSnapshot {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("notifiable-events-outbox.json deve conter um objeto JSON.");
  }

  const record = parsed as Record<string, unknown>;

  if (record.schemaVersion !== INCIDENT_OUTBOX_SCHEMA_VERSION) {
    throw new Error(`schemaVersion invalido em notifiable-events-outbox.json: ${String(record.schemaVersion)}`);
  }

  return {
    schemaVersion: INCIDENT_OUTBOX_SCHEMA_VERSION,
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
    entries: normalizeOutboxEntries(record.entries)
  };
}

function normalizeOutboxEntries(input: unknown): IncidentOutboxEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const entriesByDedupeKey = new Map<string, IncidentOutboxEntry>();

  for (const value of input) {
    const entry = normalizeOutboxEntry(value);

    if (!entry) {
      throw new Error("entrada invalida em notifiable-events-outbox.json.");
    }

    entriesByDedupeKey.set(entry.dedupeKey, entry);
  }

  return [...entriesByDedupeKey.values()];
}

function normalizeOutboxEntry(input: unknown): IncidentOutboxEntry | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const dedupeKey = normalizeNullableString(record.dedupeKey);
  const eventId = normalizeNullableString(record.eventId);
  const incidentId = normalizeNullableString(record.incidentId);
  const targetId = normalizeNullableString(record.targetId);
  const targetName = normalizeNullableString(record.targetName);
  const type = normalizeEventType(record.type);
  const reason = normalizeNullableString(record.reason);
  const severity = normalizeSeverity(record.severity);
  const occurredAt = normalizeNullableString(record.occurredAt);
  const status = normalizeEntryStatus(record.status);

  if (!dedupeKey || !eventId || !incidentId || !targetId || !targetName || !type || !reason || !severity || !occurredAt) {
    return null;
  }

  const queuedAt = normalizeNullableString(record.queuedAt) ?? occurredAt;
  const updatedAt = normalizeNullableString(record.updatedAt) ?? queuedAt;
  const lastSeenAt = normalizeNullableString(record.lastSeenAt) ?? occurredAt;

  return {
    dedupeKey,
    eventId,
    incidentId,
    targetId,
    targetName,
    type,
    status,
    reason,
    severity,
    occurredAt,
    streakCount: readNumber(record.streakCount, 0),
    queuedAt,
    updatedAt,
    lastSeenAt,
    attempts: readNumber(record.attempts, 0),
    lastAttemptAt: normalizeNullableString(record.lastAttemptAt),
    sentAt: normalizeNullableString(record.sentAt),
    discardedAt: normalizeNullableString(record.discardedAt),
    lastError: normalizeNullableString(record.lastError)
  };
}

function normalizeEventType(value: unknown): IncidentOutboxEntry["type"] | null {
  const normalized = normalizeNullableString(value);

  if (normalized === "incident_opened" || normalized === "incident_resolved") {
    return normalized;
  }

  return null;
}

function normalizeEntryStatus(value: unknown): IncidentOutboxEntry["status"] {
  const normalized = normalizeNullableString(value);

  if (normalized === "sent" || normalized === "failed" || normalized === "discarded") {
    return normalized;
  }

  return "pending";
}

function normalizeSeverity(value: unknown): IncidentOutboxEntry["severity"] | null {
  const normalized = normalizeNullableString(value);

  if (normalized === "none" || normalized === "warning" || normalized === "critical") {
    return normalized;
  }

  return null;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

async function tryApplyPrivatePermissions(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  await chmod(filePath, 0o600).catch(() => undefined);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isWindowsRenameConflict(error: unknown): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: string }).code;
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}