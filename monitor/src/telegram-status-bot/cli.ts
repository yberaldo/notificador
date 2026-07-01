#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadTargetsConfig } from "../checks/public-listener-check/config.js";
import { runPublicListenerMultiCheck } from "../checks/public-listener-check/multi.js";
import type { PublicListenerMultiDiagnostic } from "../checks/public-listener-check/types.js";
import { isStatusCommand } from "./commands.js";
import {
  DEFAULT_TELEGRAM_API_BASE_URL,
  DEFAULT_TELEGRAM_TIMEOUT_MS,
  TelegramApiClient,
  sanitizeTelegramText
} from "./telegram-api.js";
import {
  loadTelegramStatusOffset,
  resolveTelegramStatusOffsetPath,
  saveTelegramStatusOffset
} from "./offset-store.js";
import { formatStatusMessage } from "./status-format.js";
import type {
  RunStatusCheck,
  TelegramMessage,
  TelegramStatusBotConfig,
  TelegramStatusBotState,
  TelegramUpdate
} from "./types.js";

const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const POLL_ERROR_BACKOFF_MS = 5_000;

interface TelegramStatusBotCliOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  now?: () => Date;
  fetchImpl?: typeof fetch;
  runStatusCheck?: RunStatusCheck;
}

interface TelegramStatusBotRuntime {
  config: TelegramStatusBotConfig;
  api: TelegramApiClient;
  runStatusCheck: RunStatusCheck;
  stderr: { write(chunk: string): unknown };
  now: () => Date;
  state: TelegramStatusBotState;
}

export async function runTelegramStatusBotCli(options: TelegramStatusBotCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;

  try {
    const config = loadTelegramStatusBotConfig(env);
    const api = new TelegramApiClient({
      botToken: config.botToken,
      apiBaseUrl: config.apiBaseUrl,
      timeoutMs: config.telegramTimeoutMs,
      fetchImpl: options.fetchImpl
    });
    const runStatusCheck = options.runStatusCheck ?? createPublicListenerStatusCheck(env);

    await runTelegramStatusBot({
      config,
      api,
      runStatusCheck,
      stderr,
      now: options.now ?? (() => new Date()),
      state: { currentCheck: null }
    });

    return 0;
  } catch (error) {
    stderr.write(`${sanitizeTelegramText(formatError(error), env.PUBLIC_LISTENER_TELEGRAM_BOT_TOKEN)}\n`);
    return 1;
  }
}

export function loadTelegramStatusBotConfig(env: NodeJS.ProcessEnv): TelegramStatusBotConfig {
  const botToken = normalizeNonEmptyString(env.PUBLIC_LISTENER_TELEGRAM_BOT_TOKEN);
  if (!botToken) {
    throw new Error("telegram bot token ausente");
  }

  const chatId = normalizeNonEmptyString(env.PUBLIC_LISTENER_TELEGRAM_CHAT_ID);
  if (!chatId) {
    throw new Error("telegram chat id ausente");
  }

  return {
    botToken,
    chatId,
    apiBaseUrl: normalizeNonEmptyString(env.PUBLIC_LISTENER_TELEGRAM_API_BASE_URL) ?? DEFAULT_TELEGRAM_API_BASE_URL,
    threadId: normalizeThreadId(env.PUBLIC_LISTENER_TELEGRAM_THREAD_ID),
    telegramTimeoutMs: readPositiveInteger(env.PUBLIC_LISTENER_TELEGRAM_TIMEOUT_MS, DEFAULT_TELEGRAM_TIMEOUT_MS),
    pollTimeoutSeconds: readBoundedInteger(
      env.PUBLIC_LISTENER_TELEGRAM_STATUS_POLL_TIMEOUT_SECONDS,
      DEFAULT_POLL_TIMEOUT_SECONDS,
      0,
      50
    ),
    offsetFilePath: resolveTelegramStatusOffsetPath(env.PUBLIC_LISTENER_TELEGRAM_STATUS_OFFSET_PATH),
    once: readBoolean(env.PUBLIC_LISTENER_TELEGRAM_STATUS_ONCE, false)
  };
}

export async function runTelegramStatusBot(runtime: TelegramStatusBotRuntime): Promise<void> {
  for (;;) {
    try {
      await processTelegramStatusPollRound(runtime);
    } catch (error) {
      runtime.stderr.write(`${runtime.api.sanitizeText(formatError(error))}\n`);

      if (runtime.config.once) {
        throw error;
      }

      await sleep(POLL_ERROR_BACKOFF_MS);
    }

    if (runtime.config.once) {
      if (runtime.state.currentCheck) {
        await runtime.state.currentCheck;
      }
      return;
    }
  }
}

export async function processTelegramStatusPollRound(runtime: TelegramStatusBotRuntime): Promise<void> {
  const loadedOffset = await loadTelegramStatusOffset(runtime.config.offsetFilePath);

  if (!loadedOffset.exists) {
    const updates = await runtime.api.getUpdates({
      timeoutSeconds: 0
    });
    await saveTelegramStatusOffset(
      runtime.config.offsetFilePath,
      resolveNextOffset(updates, 0),
      runtime.now()
    );
    return;
  }

  const updates = await runtime.api.getUpdates({
    offset: loadedOffset.snapshot?.offset ?? 0,
    timeoutSeconds: runtime.config.pollTimeoutSeconds
  });

  for (const update of [...updates].sort((left, right) => left.update_id - right.update_id)) {
    await processTelegramStatusUpdate(runtime, update);
    await saveTelegramStatusOffset(runtime.config.offsetFilePath, update.update_id + 1, runtime.now());
  }
}

function createPublicListenerStatusCheck(env: NodeJS.ProcessEnv): RunStatusCheck {
  const baseConfig = loadConfig(env, []);
  const targets = loadTargetsConfig(env, []);

  if (!targets) {
    throw new Error("PUBLIC_LISTENER_TARGETS_JSON e obrigatorio para telegram-status-bot");
  }

  return () => runPublicListenerMultiCheck(baseConfig, targets);
}

async function processTelegramStatusUpdate(runtime: TelegramStatusBotRuntime, update: TelegramUpdate): Promise<void> {
  const message = update.message;

  if (!message || !isAuthorizedMessage(runtime.config, message) || !isStatusCommand(message.text)) {
    return;
  }

  if (runtime.state.currentCheck) {
    await runtime.api.sendMessage({
      chatId: runtime.config.chatId,
      text: "⏳ Já estou checando os players. Tente novamente em instantes.",
      threadId: runtime.config.threadId
    });
    return;
  }

  await runtime.api.sendMessage({
    chatId: runtime.config.chatId,
    text: "⏳ Checando players agora...",
    threadId: runtime.config.threadId
  });

  startStatusCheck(runtime);
}

function startStatusCheck(runtime: TelegramStatusBotRuntime): void {
  const task = (async () => {
    try {
      const diagnostic = await runtime.runStatusCheck();
      await runtime.api.sendMessage({
        chatId: runtime.config.chatId,
        text: formatStatusMessage(diagnostic),
        threadId: runtime.config.threadId
      });
    } catch (error) {
      runtime.stderr.write(`${runtime.api.sanitizeText(formatError(error))}\n`);

      try {
        await runtime.api.sendMessage({
          chatId: runtime.config.chatId,
          text: "📻 Status dos players\nNão consegui checar agora.",
          threadId: runtime.config.threadId
        });
      } catch (sendError) {
        runtime.stderr.write(`${runtime.api.sanitizeText(formatError(sendError))}\n`);
      }
    } finally {
      runtime.state.currentCheck = null;
    }
  })();

  runtime.state.currentCheck = task;
}

function isAuthorizedMessage(config: TelegramStatusBotConfig, message: TelegramMessage): boolean {
  if (String(message.chat.id) !== String(config.chatId)) {
    return false;
  }

  if (config.threadId !== null && message.message_thread_id !== config.threadId) {
    return false;
  }

  return true;
}

function resolveNextOffset(updates: TelegramUpdate[], fallback: number): number {
  return updates.reduce((nextOffset, update) => Math.max(nextOffset, update.update_id + 1), fallback);
}

function normalizeThreadId(rawValue?: string | null): number | null {
  const normalized = normalizeNonEmptyString(rawValue);
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNonEmptyString(value?: string | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPositiveInteger(rawValue: string | undefined, fallback: number): number {
  if (!rawValue?.trim()) {
    return fallback;
  }

  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoundedInteger(rawValue: string | undefined, fallback: number, min: number, max: number): number {
  if (!rawValue?.trim()) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function readBoolean(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  process.exitCode = await runTelegramStatusBotCli();
}

const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (entryFilePath && entryFilePath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${sanitizeTelegramText(formatError(error), process.env.PUBLIC_LISTENER_TELEGRAM_BOT_TOKEN)}\n`);
    process.exitCode = 1;
  });
}
