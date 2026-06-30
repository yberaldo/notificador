import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { readFile, mkdtemp, stat } from "node:fs/promises";
import {
  DEFAULT_INCIDENT_OUTBOX_PATH,
  loadIncidentOutbox,
  saveIncidentOutbox
} from "./outbox-store.js";
import {
  DEFAULT_INCIDENT_STATE_PATH,
  loadIncidentState,
  saveIncidentState
} from "./state-store.js";

export interface OptionalFileSnapshot {
  exists: boolean;
  content: string | null;
  size: number | null;
  mtimeMs: number | null;
}

type GuardedIncidentPersistence = {
  loadIncidentState: typeof loadIncidentState;
  saveIncidentState: typeof saveIncidentState;
  loadIncidentOutbox: typeof loadIncidentOutbox;
  saveIncidentOutbox: typeof saveIncidentOutbox;
};

export interface IncidentTestContext {
  directoryPath: string;
  stateFilePath: string;
  outboxFilePath: string;
  options: {
    stateFilePath: string;
    outboxFilePath: string;
    persistence: GuardedIncidentPersistence;
  };
}

export const REAL_INCIDENT_PRODUCTION_FILE_PATHS = [
  DEFAULT_INCIDENT_STATE_PATH,
  `${DEFAULT_INCIDENT_STATE_PATH}.bak`,
  DEFAULT_INCIDENT_OUTBOX_PATH,
  `${DEFAULT_INCIDENT_OUTBOX_PATH}.bak`
] as const;

const productionFileSnapshotsPromise = snapshotProductionFiles();
const protectedPathSet = new Set(REAL_INCIDENT_PRODUCTION_FILE_PATHS.map((filePath) => normalizePath(filePath)));

after(async () => {
  assert.deepEqual(
    await snapshotProductionFiles(),
    await productionFileSnapshotsPromise,
    "Os testes tocaram os caminhos reais de producao em data/."
  );
});

export async function createTemporaryTestDirectory(name: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `radio-cabrito-${name}-`));
}

export async function createIncidentTestContext(
  name: string,
  persistenceOverrides: Partial<GuardedIncidentPersistence> = {}
): Promise<IncidentTestContext> {
  const directoryPath = await createTemporaryTestDirectory(name);
  const stateFilePath = path.join(directoryPath, "data", "incidents-state.json");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  return {
    directoryPath,
    stateFilePath,
    outboxFilePath,
    options: {
      stateFilePath,
      outboxFilePath,
      persistence: createGuardedIncidentPersistence(persistenceOverrides)
    }
  };
}

export function createGuardedIncidentPersistence(
  persistenceOverrides: Partial<GuardedIncidentPersistence> = {}
): GuardedIncidentPersistence {
  const persistence: GuardedIncidentPersistence = {
    loadIncidentState,
    saveIncidentState,
    loadIncidentOutbox,
    saveIncidentOutbox,
    ...persistenceOverrides
  };

  return {
    async loadIncidentState(filePath, template) {
      assertNotProductionPath(filePath, "carregar incident state");
      return persistence.loadIncidentState(filePath, template);
    },
    async saveIncidentState(filePath, state) {
      assertNotProductionPath(filePath, "salvar incident state");
      return persistence.saveIncidentState(filePath, state);
    },
    async loadIncidentOutbox(filePath, updatedAt) {
      assertNotProductionPath(filePath, "carregar outbox");
      return persistence.loadIncidentOutbox(filePath, updatedAt);
    },
    async saveIncidentOutbox(filePath, outbox) {
      assertNotProductionPath(filePath, "salvar outbox");
      return persistence.saveIncidentOutbox(filePath, outbox);
    }
  };
}

export async function withWorkingDirectory<T>(
  directoryPath: string,
  callback: () => Promise<T> | T
): Promise<T> {
  const previousDirectory = process.cwd();
  process.chdir(directoryPath);

  try {
    return await callback();
  } finally {
    process.chdir(previousDirectory);
  }
}

export async function assertProductionFilesUntouched(): Promise<void> {
  assert.deepEqual(
    await snapshotProductionFiles(),
    await productionFileSnapshotsPromise,
    "Os testes tocaram os caminhos reais de producao em data/."
  );
}

export async function snapshotProductionFiles(): Promise<Record<string, OptionalFileSnapshot>> {
  const entries = await Promise.all(
    REAL_INCIDENT_PRODUCTION_FILE_PATHS.map(async (filePath) => [filePath, await snapshotOptionalFile(filePath)] as const)
  );

  return Object.fromEntries(entries);
}

export async function snapshotOptionalFile(filePath: string): Promise<OptionalFileSnapshot> {
  try {
    const [content, metadata] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);

    return {
      exists: true,
      content,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        exists: false,
        content: null,
        size: null,
        mtimeMs: null
      };
    }

    throw error;
  }
}

function assertNotProductionPath(filePath: string, operation: string): void {
  assert.equal(
    protectedPathSet.has(normalizePath(filePath)),
    false,
    `Teste tentou ${operation} no caminho real de producao: ${filePath}`
  );
}

function normalizePath(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}