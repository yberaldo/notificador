import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { DispatchLockInfo } from "./dispatch-types.js";

interface StoredDispatchLock {
  pid: number;
  createdAt: string;
  expiresAt: string;
}

interface DispatchLockHandle {
  descriptor: DispatchLockInfo;
  release(): Promise<DispatchLockInfo>;
}

interface AcquireDispatchLockOptions {
  filePath: string;
  ttlMs: number;
  pid?: number;
  now?: () => Date;
}

type LockReadResult =
  | { kind: "missing" }
  | { kind: "valid"; lock: StoredDispatchLock }
  | { kind: "stale"; error: string };

export async function acquireDispatchLock(options: AcquireDispatchLockOptions): Promise<DispatchLockHandle> {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  let replacedExpired = false;

  try {
    await mkdir(path.dirname(options.filePath), { recursive: true });
  } catch (error) {
    return createErrorHandle(options.filePath, `Nao foi possivel preparar o diretorio do lock: ${formatError(error)}`);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const createdAt = now().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + options.ttlMs).toISOString();
    const lockPayload: StoredDispatchLock = {
      pid,
      createdAt,
      expiresAt
    };

    try {
      await writeFile(options.filePath, `${JSON.stringify(lockPayload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });

      const descriptor: DispatchLockInfo = {
        path: options.filePath,
        pid,
        createdAt,
        expiresAt,
        acquired: true,
        skippedBecauseLocked: false,
        replacedExpired,
        released: false,
        error: null
      };

      return {
        descriptor,
        async release() {
          return releaseOwnedDispatchLock(options.filePath, lockPayload, descriptor);
        }
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        return createErrorHandle(options.filePath, `Nao foi possivel criar o lock do dispatcher: ${formatError(error)}`);
      }
    }

    const existing = await readDispatchLock(options.filePath);

    if (existing.kind === "missing") {
      continue;
    }

    if (existing.kind === "valid" && !isExpired(existing.lock.expiresAt, now())) {
      return {
        descriptor: {
          path: options.filePath,
          pid: existing.lock.pid,
          createdAt: existing.lock.createdAt,
          expiresAt: existing.lock.expiresAt,
          acquired: false,
          skippedBecauseLocked: true,
          replacedExpired: false,
          released: false,
          error: null
        },
        async release() {
          return {
            path: options.filePath,
            pid: existing.lock.pid,
            createdAt: existing.lock.createdAt,
            expiresAt: existing.lock.expiresAt,
            acquired: false,
            skippedBecauseLocked: true,
            replacedExpired: false,
            released: false,
            error: null
          };
        }
      };
    }

    try {
      await rm(options.filePath, { force: true });
      replacedExpired = true;
    } catch (error) {
      return createErrorHandle(options.filePath, `Nao foi possivel substituir o lock expirado do dispatcher: ${formatError(error)}`);
    }
  }

  return createErrorHandle(options.filePath, "Nao foi possivel adquirir o lock do dispatcher de forma segura.");
}

async function releaseOwnedDispatchLock(
  filePath: string,
  ownedLock: StoredDispatchLock,
  descriptor: DispatchLockInfo
): Promise<DispatchLockInfo> {
  try {
    const currentLock = await readDispatchLock(filePath);

    if (currentLock.kind === "missing") {
      return {
        ...descriptor,
        released: true,
        error: null
      };
    }

    if (currentLock.kind === "stale") {
      await rm(filePath, { force: true });
      return {
        ...descriptor,
        released: true,
        error: null
      };
    }

    if (!sameLock(currentLock.lock, ownedLock)) {
      return {
        ...descriptor,
        pid: currentLock.lock.pid,
        createdAt: currentLock.lock.createdAt,
        expiresAt: currentLock.lock.expiresAt,
        released: false,
        error: null
      };
    }

    await rm(filePath, { force: true });

    return {
      ...descriptor,
      released: true,
      error: null
    };
  } catch (error) {
    return {
      ...descriptor,
      released: false,
      error: `Nao foi possivel liberar o lock do dispatcher: ${formatError(error)}`
    };
  }
}

async function readDispatchLock(filePath: string): Promise<LockReadResult> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeStoredDispatchLock(parsed);

    if (!normalized) {
      return {
        kind: "stale",
        error: "conteudo invalido"
      };
    }

    return {
      kind: "valid",
      lock: normalized
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { kind: "missing" };
    }

    return {
      kind: "stale",
      error: formatError(error)
    };
  }
}

function normalizeStoredDispatchLock(input: unknown): StoredDispatchLock | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const pid = typeof record.pid === "number" && Number.isFinite(record.pid) ? record.pid : null;
  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt.trim() : null;
  const expiresAt = typeof record.expiresAt === "string" && record.expiresAt.trim() ? record.expiresAt.trim() : null;

  if (pid === null || !createdAt || !expiresAt) {
    return null;
  }

  return {
    pid,
    createdAt,
    expiresAt
  };
}

function sameLock(left: StoredDispatchLock, right: StoredDispatchLock): boolean {
  return left.pid === right.pid && left.createdAt === right.createdAt && left.expiresAt === right.expiresAt;
}

function isExpired(expiresAt: string, now: Date): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime();
}

function createErrorHandle(filePath: string, error: string): DispatchLockHandle {
  const descriptor: DispatchLockInfo = {
    path: filePath,
    pid: null,
    createdAt: null,
    expiresAt: null,
    acquired: false,
    skippedBecauseLocked: false,
    replacedExpired: false,
    released: false,
    error
  };

  return {
    descriptor,
    async release() {
      return descriptor;
    }
  };
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}