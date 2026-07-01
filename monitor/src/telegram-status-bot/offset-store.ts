import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { TelegramStatusOffsetSnapshot } from "./types.js";

export const DEFAULT_TELEGRAM_STATUS_OFFSET_PATH = "data/telegram-status-offset.json";

export interface LoadTelegramStatusOffsetResult {
  exists: boolean;
  snapshot: TelegramStatusOffsetSnapshot | null;
}

export function resolveTelegramStatusOffsetPath(rawValue?: string | null): string {
  const candidate = rawValue?.trim() || DEFAULT_TELEGRAM_STATUS_OFFSET_PATH;
  return path.resolve(candidate);
}

export async function loadTelegramStatusOffset(filePath: string): Promise<LoadTelegramStatusOffsetResult> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return {
      exists: true,
      snapshot: normalizeOffsetSnapshot(parsed)
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        exists: false,
        snapshot: null
      };
    }

    throw error;
  }
}

export async function saveTelegramStatusOffset(
  filePath: string,
  offset: number,
  now: Date = new Date()
): Promise<TelegramStatusOffsetSnapshot> {
  const snapshot: TelegramStatusOffsetSnapshot = {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    offset: normalizeOffset(offset)
  };
  const directoryPath = path.dirname(filePath);
  const temporaryPath = path.join(directoryPath, `.telegram-status-offset.${process.pid}.${Date.now()}.tmp`);

  await mkdir(directoryPath, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);

  return snapshot;
}

function normalizeOffsetSnapshot(value: unknown): TelegramStatusOffsetSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("telegram status offset invalido");
  }

  const record = value as Record<string, unknown>;
  const updatedAt = typeof record.updatedAt === "string" && record.updatedAt.trim()
    ? record.updatedAt
    : new Date(0).toISOString();

  return {
    schemaVersion: 1,
    updatedAt,
    offset: normalizeOffset(record.offset)
  };
}

function normalizeOffset(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
