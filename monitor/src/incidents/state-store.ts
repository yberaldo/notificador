import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INCIDENT_STATE_SCHEMA_VERSION,
  type IncidentCurrentIncidentState,
  type IncidentPolicySnapshot,
  type IncidentResolvedIncidentRecord,
  type IncidentStateLoadSource,
  type IncidentStateSnapshot,
  type IncidentStateStoreMeta,
  type IncidentStreak,
  type IncidentTargetState,
  type NotifiableIncidentEvent
} from "./types.js";

const DEFAULT_STATE_FILE_URL = new URL("../../data/incidents-state.json", import.meta.url);

interface IncidentStateTemplate {
  updatedAt: string;
  checkName: string;
  checkVersion: string;
  policySnapshot: IncidentPolicySnapshot;
}

interface LoadedStateResult {
  state: IncidentStateSnapshot;
  meta: Omit<IncidentStateStoreMeta, "path" | "writeSucceeded" | "writeError">;
}

type ReadStateAttempt =
  | { kind: "ok"; state: IncidentStateSnapshot }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export const DEFAULT_INCIDENT_STATE_PATH = fileURLToPath(DEFAULT_STATE_FILE_URL);
export const DEFAULT_INCIDENT_STATE_DISPLAY_PATH = "data/incidents-state.json";

export function resolveIncidentStatePath(
  configuredPath?: string | null,
  baseDirectory: string = process.cwd()
): { filePath: string; displayPath: string } {
  const normalizedConfiguredPath = typeof configuredPath === "string" ? configuredPath.trim() : "";

  if (!normalizedConfiguredPath) {
    return {
      filePath: DEFAULT_INCIDENT_STATE_PATH,
      displayPath: DEFAULT_INCIDENT_STATE_DISPLAY_PATH
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

export function createEmptyIncidentState(template: IncidentStateTemplate): IncidentStateSnapshot {
  return {
    schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
    updatedAt: template.updatedAt,
    checkName: template.checkName,
    checkVersion: template.checkVersion,
    policySnapshot: template.policySnapshot,
    targets: {}
  };
}

export function createEmptyTargetState(targetId: string, targetName: string, streamUrl: string): IncidentTargetState {
  return {
    targetId,
    targetName,
    streamUrl,
    lastCheck: null,
    streak: createEmptyStreak(),
    currentIncident: createClosedIncidentState(),
    lastResolvedIncident: null,
    lastEvent: null
  };
}

export function createEmptyStreak(): IncidentStreak {
  return {
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    highestFailureSeverity: null,
    firstFailureAt: null,
    lastFailureAt: null,
    lastHealthyAt: null
  };
}

export function createClosedIncidentState(): IncidentCurrentIncidentState {
  return {
    state: "closed",
    incidentId: null,
    openedAt: null,
    updatedAt: null,
    openedByStatus: null,
    openedByReason: null,
    openedSeverity: null,
    currentStatus: null,
    currentReason: null,
    currentSeverity: null
  };
}

export async function loadIncidentState(
  filePath: string,
  template: IncidentStateTemplate
): Promise<LoadedStateResult> {
  const emptyState = createEmptyIncidentState(template);
  const primaryAttempt = await readStateFromPath(filePath, template);

  if (primaryAttempt.kind === "ok") {
    return {
      state: primaryAttempt.state,
      meta: {
        loadSource: "primary",
        recoveredFromCorruption: false,
        loadError: null
      }
    };
  }

  const backupPath = `${filePath}.bak`;
  const backupAttempt = await readStateFromPath(backupPath, template);

  if (backupAttempt.kind === "ok") {
    return {
      state: backupAttempt.state,
      meta: {
        loadSource: "backup",
        recoveredFromCorruption: primaryAttempt.kind === "error",
        loadError: primaryAttempt.kind === "error" ? primaryAttempt.message : null
      }
    };
  }

  return {
    state: emptyState,
    meta: {
      loadSource: "fresh",
      recoveredFromCorruption: primaryAttempt.kind === "error" || backupAttempt.kind === "error",
      loadError: primaryAttempt.kind === "error" ? primaryAttempt.message : backupAttempt.kind === "error" ? backupAttempt.message : null
    }
  };
}

export async function saveIncidentState(
  filePath: string,
  state: IncidentStateSnapshot
): Promise<Pick<IncidentStateStoreMeta, "writeSucceeded" | "writeError">> {
  const directoryPath = path.dirname(filePath);
  const backupPath = `${filePath}.bak`;
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await mkdir(directoryPath, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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

async function readStateFromPath(filePath: string, template: IncidentStateTemplate): Promise<ReadStateAttempt> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return {
      kind: "ok",
      state: normalizeStateSnapshot(parsed, template)
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

function normalizeStateSnapshot(parsed: unknown, template: IncidentStateTemplate): IncidentStateSnapshot {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("incidents-state.json deve conter um objeto JSON.");
  }

  const record = parsed as Record<string, unknown>;

  if (record.schemaVersion !== INCIDENT_STATE_SCHEMA_VERSION) {
    throw new Error(`schemaVersion invalido em incidents-state.json: ${String(record.schemaVersion)}`);
  }

  const targets = normalizeTargets(record.targets);

  return {
    schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
    updatedAt: template.updatedAt,
    checkName: template.checkName,
    checkVersion: template.checkVersion,
    policySnapshot: template.policySnapshot,
    targets
  };
}

function normalizeTargets(input: unknown): Record<string, IncidentTargetState> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const entries = Object.entries(input as Record<string, unknown>);
  const targets: Record<string, IncidentTargetState> = {};

  for (const [key, value] of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const target = value as Record<string, unknown>;
    const targetId = readString(target.targetId, key);
    const targetName = readString(target.targetName, targetId);
    const streamUrl = readString(target.streamUrl, "");

    targets[targetId] = {
      targetId,
      targetName,
      streamUrl,
      lastCheck: normalizeLastCheck(target.lastCheck),
      streak: normalizeStreak(target.streak),
      currentIncident: normalizeCurrentIncident(target.currentIncident),
      lastResolvedIncident: normalizeResolvedIncident(target.lastResolvedIncident),
      lastEvent: normalizeEvent(target.lastEvent)
    };
  }

  return targets;
}

function normalizeLastCheck(input: unknown): IncidentTargetState["lastCheck"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;

  return {
    status: readString(record.status, "unknown_error") as IncidentTargetState["lastCheck"] extends infer T
      ? T extends { status: infer U }
        ? U
        : never
      : never,
    reason: readString(record.reason, "unexpected_error"),
    severity: readString(record.severity, "critical") as IncidentTargetState["lastCheck"] extends infer T
      ? T extends { severity: infer U }
        ? U
        : never
      : never,
    checkedAt: readString(record.checkedAt, new Date(0).toISOString())
  };
}

function normalizeStreak(input: unknown): IncidentStreak {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createEmptyStreak();
  }

  const record = input as Record<string, unknown>;

  return {
    consecutiveFailures: readNumber(record.consecutiveFailures, 0),
    consecutiveSuccesses: readNumber(record.consecutiveSuccesses, 0),
    highestFailureSeverity: normalizeNullableFailureSeverity(record.highestFailureSeverity),
    firstFailureAt: normalizeNullableString(record.firstFailureAt),
    lastFailureAt: normalizeNullableString(record.lastFailureAt),
    lastHealthyAt: normalizeNullableString(record.lastHealthyAt)
  };
}

function normalizeCurrentIncident(input: unknown): IncidentCurrentIncidentState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createClosedIncidentState();
  }

  const record = input as Record<string, unknown>;

  return {
    state: readString(record.state, "closed") === "open" ? "open" : "closed",
    incidentId: normalizeNullableString(record.incidentId),
    openedAt: normalizeNullableString(record.openedAt),
    updatedAt: normalizeNullableString(record.updatedAt),
    openedByStatus: normalizeNullableStatus(record.openedByStatus),
    openedByReason: normalizeNullableString(record.openedByReason),
    openedSeverity: normalizeNullableSeverity(record.openedSeverity),
    currentStatus: normalizeNullableStatus(record.currentStatus),
    currentReason: normalizeNullableString(record.currentReason),
    currentSeverity: normalizeNullableSeverity(record.currentSeverity)
  };
}

function normalizeResolvedIncident(input: unknown): IncidentResolvedIncidentRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const incidentId = normalizeNullableString(record.incidentId);
  const openedAt = normalizeNullableString(record.openedAt);
  const resolvedAt = normalizeNullableString(record.resolvedAt);
  const openedByStatus = normalizeNullableStatus(record.openedByStatus);
  const openedByReason = normalizeNullableString(record.openedByReason);
  const openedSeverity = normalizeNullableSeverity(record.openedSeverity);
  const finalStatus = normalizeNullableStatus(record.finalStatus);
  const finalReason = normalizeNullableString(record.finalReason);
  const finalSeverity = normalizeNullableSeverity(record.finalSeverity);

  if (
    !incidentId ||
    !openedAt ||
    !resolvedAt ||
    !openedByStatus ||
    !openedByReason ||
    !openedSeverity ||
    !finalStatus ||
    !finalReason ||
    !finalSeverity
  ) {
    return null;
  }

  return {
    incidentId,
    openedAt,
    resolvedAt,
    openedByStatus,
    openedByReason,
    openedSeverity,
    finalStatus,
    finalReason,
    finalSeverity
  };
}

function normalizeEvent(input: unknown): NotifiableIncidentEvent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const eventId = normalizeNullableString(record.eventId);
  const incidentId = normalizeNullableString(record.incidentId);
  const targetId = normalizeNullableString(record.targetId);
  const targetName = normalizeNullableString(record.targetName);
  const type = normalizeNullableString(record.type);
  const status = normalizeNullableStatus(record.status);
  const reason = normalizeNullableString(record.reason);
  const severity = normalizeNullableSeverity(record.severity);
  const occurredAt = normalizeNullableString(record.occurredAt);
  const dedupeKey = normalizeNullableString(record.dedupeKey);

  if (
    !eventId ||
    !incidentId ||
    !targetId ||
    !targetName ||
    !type ||
    !status ||
    !reason ||
    !severity ||
    !occurredAt ||
    !dedupeKey
  ) {
    return null;
  }

  return {
    eventId,
    incidentId,
    targetId,
    targetName,
    type: type === "incident_resolved" ? "incident_resolved" : "incident_opened",
    status,
    reason,
    severity,
    occurredAt,
    streakCount: readNumber(record.streakCount, 0),
    dedupeKey
  };
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

function normalizeNullableStatus(value: unknown): IncidentCurrentIncidentState["currentStatus"] {
  const normalized = normalizeNullableString(value);
  return normalized as IncidentCurrentIncidentState["currentStatus"];
}

function normalizeNullableSeverity(value: unknown): IncidentCurrentIncidentState["currentSeverity"] {
  const normalized = normalizeNullableString(value);
  if (normalized === "none" || normalized === "warning" || normalized === "critical") {
    return normalized;
  }

  return null;
}

function normalizeNullableFailureSeverity(value: unknown): IncidentStreak["highestFailureSeverity"] {
  const normalized = normalizeNullableString(value);
  if (normalized === "warning" || normalized === "critical") {
    return normalized;
  }

  return null;
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
