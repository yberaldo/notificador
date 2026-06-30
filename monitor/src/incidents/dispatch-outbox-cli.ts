#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchIncidentOutbox } from "./dispatch-outbox.js";
import {
  DEFAULT_DISPATCH_ADAPTER,
  DEFAULT_DISPATCH_LOCK_TTL_MS,
  DEFAULT_DISPATCH_MAX_ATTEMPTS,
  DEFAULT_DISPATCH_NOOP_MODE,
  DEFAULT_DISPATCH_RETRY_BASE_MS,
  DEFAULT_DISPATCH_RETRY_MAX_MS,
  DISPATCH_OUTBOX_COMMAND_NAME,
  DISPATCH_OUTBOX_COMMAND_VERSION,
  type DispatchAdapterName,
  type DispatchNoopMode,
  type DispatchOutboxOptions,
  type DispatchOutboxResult
} from "./dispatch-types.js";
import { resolveIncidentOutboxPath } from "./outbox-store.js";

interface DispatchCliRunOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  now?: () => Date;
  pid?: number;
}

export async function runDispatchOutboxCli(options: DispatchCliRunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const config = loadDispatchOutboxCliConfig(env);
    const result = await dispatchIncidentOutbox({
      ...config,
      now: options.now,
      pid: options.pid,
      onAdapterLog(message) {
        stderr.write(`${message}\n`);
      }
    });

    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.summary.writeSucceeded ? 0 : 1;
  } catch (error) {
    const fallback = createCliFailureResult(env, error);
    stdout.write(`${JSON.stringify(fallback, null, 2)}\n`);
    return 1;
  }
}

export function loadDispatchOutboxCliConfig(env: NodeJS.ProcessEnv): DispatchOutboxOptions {
  const adapter = readDispatchAdapter(env.PUBLIC_LISTENER_DISPATCH_ADAPTER);
  const retryBaseMs = readPositiveInteger(env.PUBLIC_LISTENER_DISPATCH_RETRY_BASE_MS, DEFAULT_DISPATCH_RETRY_BASE_MS);

  return {
    outboxFilePath: env.PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH,
    adapter,
    noopMode: readNoopMode(env.PUBLIC_LISTENER_DISPATCH_NOOP_MODE),
    lockTtlMs: readPositiveInteger(env.PUBLIC_LISTENER_DISPATCH_LOCK_TTL_MS, DEFAULT_DISPATCH_LOCK_TTL_MS),
    retryBaseMs,
    retryMaxMs: Math.max(retryBaseMs, readPositiveInteger(env.PUBLIC_LISTENER_DISPATCH_RETRY_MAX_MS, DEFAULT_DISPATCH_RETRY_MAX_MS)),
    maxAttempts: readPositiveInteger(env.PUBLIC_LISTENER_DISPATCH_MAX_ATTEMPTS, DEFAULT_DISPATCH_MAX_ATTEMPTS)
  };
}

function readDispatchAdapter(rawValue: string | undefined): DispatchAdapterName {
  const normalized = rawValue?.trim().toLowerCase();
  return normalized === "noop" ? "noop" : DEFAULT_DISPATCH_ADAPTER;
}

function readNoopMode(rawValue: string | undefined): DispatchNoopMode {
  const normalized = rawValue?.trim().toLowerCase();

  if (normalized === "retryable_error" || normalized === "permanent_error") {
    return normalized;
  }

  return DEFAULT_DISPATCH_NOOP_MODE;
}

function readPositiveInteger(rawValue: string | undefined, fallback: number): number {
  if (!rawValue?.trim()) {
    return fallback;
  }

  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.floor(parsed);
}

function createCliFailureResult(env: NodeJS.ProcessEnv, error: unknown): DispatchOutboxResult {
  const outboxPath = resolveIncidentOutboxPath(env.PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH).filePath;
  const adapter = readDispatchAdapter(env.PUBLIC_LISTENER_DISPATCH_ADAPTER);

  return {
    commandName: DISPATCH_OUTBOX_COMMAND_NAME,
    commandVersion: DISPATCH_OUTBOX_COMMAND_VERSION,
    outboxPath,
    adapter,
    lock: {
      path: `${outboxPath}.lock`,
      pid: null,
      createdAt: null,
      expiresAt: null,
      acquired: false,
      skippedBecauseLocked: false,
      replacedExpired: false,
      released: false,
      error: formatError(error)
    },
    summary: {
      loadedCount: 0,
      eligibleCount: 0,
      processedCount: 0,
      sentCount: 0,
      failedCount: 0,
      discardedCount: 0,
      skippedBecauseLocked: false,
      writeSucceeded: false,
      writeError: formatError(error)
    },
    processedEvents: []
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  process.exitCode = await runDispatchOutboxCli();
}

const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (entryFilePath && entryFilePath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(createCliFailureResult(process.env, error), null, 2)}\n`);
    process.exitCode = 1;
  });
}