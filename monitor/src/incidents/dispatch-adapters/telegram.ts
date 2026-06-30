import type { IncidentOutboxEntry } from "../outbox-types.js";
import type { DispatchAdapter, DispatchAdapterResult, DispatchTelegramConfig } from "../dispatch-types.js";

export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
export const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;

interface NormalizedTelegramConfig {
  botToken: string;
  chatId: string;
  apiBaseUrl: string;
  messagePrefix: string | null;
  threadId: number | null;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

interface TelegramApiResponse {
  ok?: boolean;
  error_code?: number;
  description?: string;
}

export function createTelegramDispatchAdapter(config: DispatchTelegramConfig = {}): DispatchAdapter {
  const normalizedConfig = normalizeTelegramConfig(config);

  return {
    name: "telegram",
    async dispatch(entry: IncidentOutboxEntry): Promise<DispatchAdapterResult> {
      return sendTelegramMessage(normalizedConfig, entry);
    }
  };
}

export function buildTelegramMessage(entry: IncidentOutboxEntry, messagePrefix?: string | null): string {
  const targetLabel = normalizeNonEmptyString(entry.targetName) ?? entry.targetId;
  const lines = [
    normalizeNonEmptyString(messagePrefix),
    entry.type === "incident_opened" ? "🚨 PLAYER OFFLINE" : "✅ PLAYER ONLINE NOVAMENTE",
    targetLabel
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
}

async function sendTelegramMessage(
  config: NormalizedTelegramConfig,
  entry: IncidentOutboxEntry
): Promise<DispatchAdapterResult> {
  const requestUrl = buildTelegramSendMessageUrl(config.apiBaseUrl, config.botToken);
  const requestBody = {
    chat_id: config.chatId,
    text: buildTelegramMessage(entry, config.messagePrefix),
    ...(config.threadId !== null ? { message_thread_id: config.threadId } : {})
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await config.fetchImpl(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    const classifiedByStatus = classifyTelegramHttpStatus(response.status);
    if (classifiedByStatus) {
      return classifiedByStatus;
    }

    const payload = await readTelegramApiResponse(response);

    if (!payload) {
      return retryableResult("telegram invalid response retryable");
    }

    if (payload.ok === true) {
      return {
        outcome: "success",
        message: null
      };
    }

    return classifyTelegramApiPayload(payload);
  } catch (error) {
    return classifyTelegramTransportError(error, config.botToken);
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeTelegramConfig(config: DispatchTelegramConfig): NormalizedTelegramConfig {
  const botToken = normalizeNonEmptyString(config.botToken);
  if (!botToken) {
    throw new Error("telegram bot token ausente");
  }

  const chatId = normalizeNonEmptyString(config.chatId);
  if (!chatId) {
    throw new Error("telegram chat id ausente");
  }

  const apiBaseUrl = normalizeTelegramApiBaseUrl(config.apiBaseUrl);
  const timeoutMs = normalizePositiveInteger(config.timeoutMs, DEFAULT_TELEGRAM_TIMEOUT_MS);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("telegram fetch indisponivel");
  }

  return {
    botToken,
    chatId,
    apiBaseUrl,
    messagePrefix: normalizeNonEmptyString(config.messagePrefix),
    threadId: normalizeThreadId(config.threadId),
    timeoutMs,
    fetchImpl
  };
}

function normalizeTelegramApiBaseUrl(rawValue?: string | null): string {
  const candidate = normalizeNonEmptyString(rawValue) ?? DEFAULT_TELEGRAM_API_BASE_URL;

  try {
    const parsed = new URL(candidate);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("telegram api base url invalida");
  }
}

function buildTelegramSendMessageUrl(apiBaseUrl: string, botToken: string): string {
  const parsed = new URL(apiBaseUrl);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${basePath}/bot${botToken}/sendMessage`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function readTelegramApiResponse(response: Response): Promise<TelegramApiResponse | null> {
  try {
    const parsed = (await response.json()) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as TelegramApiResponse;
  } catch {
    return null;
  }
}

function classifyTelegramApiPayload(payload: TelegramApiResponse): DispatchAdapterResult {
  const description = (payload.description ?? "").trim().toLowerCase();

  if (description.includes("retry after") || description.includes("rate limit") || description.includes("too many requests")) {
    return retryableResult("telegram 429 retryable");
  }

  if (description.includes("unauthorized")) {
    return permanentResult("telegram 401 unauthorized");
  }

  if (description.includes("forbidden")) {
    return permanentResult("telegram 403 forbidden");
  }

  if (description.includes("chat not found")) {
    return permanentResult("telegram 400 chat not found");
  }

  if (description.includes("bad request")) {
    return permanentResult("telegram 400 bad request");
  }

  const classifiedByStatus = classifyTelegramHttpStatus(payload.error_code ?? null);
  if (classifiedByStatus) {
    return classifiedByStatus;
  }

  return retryableResult("telegram api retryable");
}

function classifyTelegramHttpStatus(status: number | null): DispatchAdapterResult | null {
  if (status === null) {
    return null;
  }

  switch (status) {
    case 400:
      return permanentResult("telegram 400 bad request");
    case 401:
      return permanentResult("telegram 401 unauthorized");
    case 403:
      return permanentResult("telegram 403 forbidden");
    case 404:
      return permanentResult("telegram 404 not found");
    case 429:
      return retryableResult("telegram 429 retryable");
    default:
      if (status >= 500) {
        return retryableResult(`telegram ${status} retryable`);
      }

      return null;
  }
}

function classifyTelegramTransportError(error: unknown, botToken: string): DispatchAdapterResult {
  if (isAbortError(error)) {
    return retryableResult("telegram network timeout");
  }

  const normalizedError = sanitizeTelegramText(formatError(error), botToken).toLowerCase();

  if (normalizedError.includes("certificate") || normalizedError.includes("tls") || normalizedError.includes("ssl")) {
    return retryableResult("telegram network tls");
  }

  if (
    normalizedError.includes("dns")
    || normalizedError.includes("enotfound")
    || normalizedError.includes("eai_again")
    || normalizedError.includes("getaddrinfo")
  ) {
    return retryableResult("telegram network dns");
  }

  return retryableResult("telegram network retryable");
}

function normalizeThreadId(rawValue?: string | null): number | null {
  const normalized = normalizeNonEmptyString(rawValue);
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

function normalizeNonEmptyString(value?: string | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sanitizeTelegramText(text: string, botToken: string): string {
  return text
    .replaceAll(botToken, "[redacted]")
    .replace(/\/bot[^/\s]+\/sendMessage/gi, "/bot[redacted]/sendMessage");
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: string }).name === "AbortError");
}

function retryableResult(message: string): DispatchAdapterResult {
  return {
    outcome: "retryable_error",
    message
  };
}

function permanentResult(message: string): DispatchAdapterResult {
  return {
    outcome: "permanent_error",
    message
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}