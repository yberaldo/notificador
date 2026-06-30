import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dispatchIncidentOutbox } from "./dispatch-outbox.js";
import { loadDispatchOutboxCliConfig, runDispatchOutboxCli } from "./dispatch-outbox-cli.js";
import { createEmptyIncidentOutboxSnapshot, saveIncidentOutbox } from "./outbox-store.js";
import type { IncidentOutboxEntry, IncidentOutboxSnapshot } from "./outbox-types.js";
import {
  assertProductionFilesUntouched,
  createTemporaryTestDirectory,
  snapshotProductionFiles,
  withWorkingDirectory
} from "./test-helpers.js";
import type { DispatchAdapter, DispatchOutboxResult } from "./dispatch-types.js";

interface CapturedTelegramRequest {
  url: string;
  body: Record<string, unknown>;
}

function createOutboxEntry(overrides: Partial<IncidentOutboxEntry> = {}): IncidentOutboxEntry {
  return {
    dedupeKey: "incident_opened:geral:fresh",
    eventId: "incident_opened:geral:fresh:2026-01-01T00:00:00.000Z",
    incidentId: "geral:fresh",
    targetId: "geral",
    targetName: "Geral / Tudo",
    type: "incident_opened",
    status: "pending",
    reason: "operation_timeout",
    severity: "critical",
    occurredAt: "2026-01-01T00:00:00.000Z",
    streakCount: 2,
    queuedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    attempts: 0,
    lastAttemptAt: null,
    sentAt: null,
    discardedAt: null,
    lastError: null,
    ...overrides
  };
}

async function writeOutbox(filePath: string, entries: IncidentOutboxEntry[], updatedAt: string = "2026-01-01T00:00:00.000Z") {
  const snapshot = createEmptyIncidentOutboxSnapshot(updatedAt);
  snapshot.entries = entries;
  const writeMeta = await saveIncidentOutbox(filePath, snapshot);
  assert.equal(writeMeta.writeSucceeded, true);
}

async function readOutbox(filePath: string): Promise<IncidentOutboxSnapshot> {
  return JSON.parse(await readFile(filePath, "utf8")) as IncidentOutboxSnapshot;
}

function createCapturedWriter() {
  const chunks: string[] = [];

  return {
    chunks,
    writer: {
      write(chunk: string) {
        chunks.push(chunk);
      }
    }
  };
}

function createJsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function createTelegramFetchMock(
  responseFactory: Response | ((request: CapturedTelegramRequest, init?: RequestInit) => Promise<Response> | Response),
  requests: CapturedTelegramRequest[]
): typeof fetch {
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    };
    requests.push(request);

    if (typeof responseFactory === "function") {
      return responseFactory(request, init);
    }

    return responseFactory;
  };

  return fetchImpl;
}

function createTelegramTimeoutFetchMock(requests: CapturedTelegramRequest[]): typeof fetch {
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    });

    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;

      if (signal?.aborted) {
        const abortError = new Error("telegram timeout");
        abortError.name = "AbortError";
        reject(abortError);
        return;
      }

      signal?.addEventListener(
        "abort",
        () => {
          const abortError = new Error("telegram timeout");
          abortError.name = "AbortError";
          reject(abortError);
        },
        { once: true }
      );
    });
  };

  return fetchImpl;
}

test("evento pending vira sent com adapter log", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-log-success");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");
  const logMessages: string[] = [];

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "log",
    onAdapterLog(message) {
      logMessages.push(message);
    }
  });

  assert.equal(result.summary.writeSucceeded, true);
  assert.equal(result.summary.processedCount, 1);
  assert.equal(result.summary.sentCount, 1);
  assert.equal(logMessages.length, 1);
  assert.match(logMessages[0] ?? "", /dedupeKey=incident_opened:geral:fresh/);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "sent");
  assert.equal(outbox.entries[0]?.attempts, 1);
  assert.equal(typeof outbox.entries[0]?.sentAt, "string");
});

test("adapter telegram com HTTP 200 ok true marca evento como sent", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-telegram-success");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");
  const requests: CapturedTelegramRequest[] = [];
  const botToken = "123456:ABC_TOKEN_SEGREDO";

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "telegram",
    telegram: {
      botToken,
      chatId: "-100123456",
      apiBaseUrl: "https://telegram.example.test/custom-api",
      messagePrefix: "[monitor-vps]",
      threadId: "77",
      fetchImpl: createTelegramFetchMock(createJsonResponse(200, { ok: true, result: { message_id: 1 } }), requests)
    }
  });

  assert.equal(result.summary.writeSucceeded, true);
  assert.equal(result.summary.sentCount, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, `https://telegram.example.test/custom-api/bot${botToken}/sendMessage`);
  assert.equal(requests[0]?.body.chat_id, "-100123456");
  assert.equal(requests[0]?.body.message_thread_id, 77);
  assert.equal(String(requests[0]?.body.text ?? ""), "[monitor-vps]\n🚨 PLAYER OFFLINE\nGeral / Tudo");
  assert.match(String(requests[0]?.body.text ?? ""), /PLAYER OFFLINE/);
  assert.match(String(requests[0]?.body.text ?? ""), /Geral \/ Tudo/);
  assert.doesNotMatch(String(requests[0]?.body.text ?? ""), /severity|reason|occurredAt|incidentId|eventId|streakCount/);
  assert.doesNotMatch(String(requests[0]?.body.text ?? ""), new RegExp(botToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(botToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "sent");
});

test("adapter telegram gera mensagem simples para incident_resolved", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-telegram-resolved-message");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");
  const requests: CapturedTelegramRequest[] = [];

  await writeOutbox(
    outboxFilePath,
    [
      createOutboxEntry({
        type: "incident_resolved",
        severity: "none",
        reason: "audio_decoded_without_continuous_silence"
      })
    ]
  );

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "telegram",
    telegram: {
      botToken: "123456:RESOLVED_SEGREDO",
      chatId: "-100123456",
      fetchImpl: createTelegramFetchMock(createJsonResponse(200, { ok: true, result: { message_id: 2 } }), requests)
    }
  });

  assert.equal(result.summary.sentCount, 1);
  assert.equal(String(requests[0]?.body.text ?? ""), "✅ PLAYER ONLINE NOVAMENTE\nGeral / Tudo");
  assert.match(String(requests[0]?.body.text ?? ""), /PLAYER ONLINE NOVAMENTE/);
  assert.match(String(requests[0]?.body.text ?? ""), /Geral \/ Tudo/);
  assert.doesNotMatch(String(requests[0]?.body.text ?? ""), /severity|reason|occurredAt|incidentId|eventId|streakCount/);
});

test("token ausente gera erro critico controlado sem tocar o outbox", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-telegram-missing-token");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "telegram",
    telegram: {
      chatId: "-100123456"
    }
  });

  assert.equal(result.summary.writeSucceeded, false);
  assert.match(result.summary.writeError ?? "", /telegram bot token ausente/);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "pending");
});

test("chatId ausente gera erro critico controlado sem vazar token no JSON final", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-telegram-missing-chat");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");
  const botToken = "123456:CHAT_AUSENTE_SEGREDO";

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "telegram",
    telegram: {
      botToken
    }
  });

  assert.equal(result.summary.writeSucceeded, false);
  assert.match(result.summary.writeError ?? "", /telegram chat id ausente/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(botToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("adapter telegram classifica HTTP 401 como erro permanente e descarta evento", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-telegram-401");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "telegram",
    telegram: {
      botToken: "123456:UNAUTHORIZED",
      chatId: "-100123456",
      fetchImpl: createTelegramFetchMock(createJsonResponse(401, { ok: false, error_code: 401, description: "Unauthorized" }), [])
    }
  });

  assert.equal(result.summary.discardedCount, 1);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "discarded");
  assert.equal(outbox.entries[0]?.lastError, "telegram 401 unauthorized");
});

test("adapter telegram classifica HTTP 403 como erro permanente e descarta evento", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-telegram-403");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "telegram",
    telegram: {
      botToken: "123456:FORBIDDEN",
      chatId: "-100123456",
      fetchImpl: createTelegramFetchMock(createJsonResponse(403, { ok: false, error_code: 403, description: "Forbidden" }), [])
    }
  });

  assert.equal(result.summary.discardedCount, 1);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "discarded");
  assert.equal(outbox.entries[0]?.lastError, "telegram 403 forbidden");
});

test("adapter telegram classifica HTTP 429 como erro retryable", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-telegram-429");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "telegram",
    telegram: {
      botToken: "123456:RATE_LIMIT",
      chatId: "-100123456",
      fetchImpl: createTelegramFetchMock(createJsonResponse(429, { ok: false, error_code: 429, description: "Too Many Requests" }), [])
    }
  });

  assert.equal(result.summary.failedCount, 1);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "failed");
  assert.equal(outbox.entries[0]?.lastError, "telegram 429 retryable");
});

test("adapter telegram classifica HTTP 500 como erro retryable", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-telegram-500");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  await writeOutbox(
    outboxFilePath,
    [
      createOutboxEntry({
        type: "incident_resolved",
        severity: "none",
        reason: "audio_decoded_without_continuous_silence"
      })
    ]
  );

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "telegram",
    telegram: {
      botToken: "123456:SERVER_ERROR",
      chatId: "-100123456",
      fetchImpl: createTelegramFetchMock(createJsonResponse(500, { ok: false, description: "Server error" }), [])
    }
  });

  assert.equal(result.summary.failedCount, 1);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "failed");
  assert.equal(outbox.entries[0]?.lastError, "telegram 500 retryable");
});

test("adapter telegram classifica timeout como erro retryable", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-telegram-timeout");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");
  const requests: CapturedTelegramRequest[] = [];

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "telegram",
    telegram: {
      botToken: "123456:TIMEOUT",
      chatId: "-100123456",
      timeoutMs: 1,
      fetchImpl: createTelegramTimeoutFetchMock(requests)
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(result.summary.failedCount, 1);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "failed");
  assert.equal(outbox.entries[0]?.lastError, "telegram network timeout");
});

test("falha no adapter retryable vira failed e incrementa attempts", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-retryable");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "noop",
    noopMode: "retryable_error"
  });

  assert.equal(result.summary.writeSucceeded, true);
  assert.equal(result.summary.failedCount, 1);
  assert.equal(result.processedEvents[0]?.finalStatus, "failed");
  assert.equal(result.processedEvents[0]?.attempts, 1);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "failed");
  assert.equal(outbox.entries[0]?.attempts, 1);
  assert.match(outbox.entries[0]?.lastError ?? "", /retryable/);
});

test("falha permanente vira discarded", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-permanent");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "noop",
    noopMode: "permanent_error"
  });

  assert.equal(result.summary.writeSucceeded, true);
  assert.equal(result.summary.discardedCount, 1);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "discarded");
  assert.equal(typeof outbox.entries[0]?.discardedAt, "string");
  assert.match(outbox.entries[0]?.lastError ?? "", /permanente/);
});

test("evento failed com backoff ainda nao vencido nao e processado", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-not-due");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");
  const now = new Date("2026-01-01T00:03:00.000Z");

  await writeOutbox(outboxFilePath, [
    createOutboxEntry({
      status: "failed",
      attempts: 1,
      lastAttemptAt: "2026-01-01T00:00:30.000Z",
      updatedAt: "2026-01-01T00:00:30.000Z",
      lastError: "falha anterior"
    })
  ]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "noop",
    noopMode: "success",
    now: () => now
  });

  assert.equal(result.summary.eligibleCount, 0);
  assert.equal(result.summary.processedCount, 0);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "failed");
  assert.equal(outbox.entries[0]?.attempts, 1);
});

test("evento failed com backoff vencido e processado", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-due");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");
  const now = new Date("2026-01-01T00:07:00.000Z");

  await writeOutbox(outboxFilePath, [
    createOutboxEntry({
      status: "failed",
      attempts: 1,
      lastAttemptAt: "2026-01-01T00:00:30.000Z",
      updatedAt: "2026-01-01T00:00:30.000Z",
      lastError: "falha anterior"
    })
  ]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "noop",
    noopMode: "success",
    now: () => now
  });

  assert.equal(result.summary.eligibleCount, 1);
  assert.equal(result.summary.sentCount, 1);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "sent");
  assert.equal(outbox.entries[0]?.attempts, 2);
});

test("evento acima de maxAttempts vira discarded sem enviar", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-max-attempts");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  await writeOutbox(outboxFilePath, [createOutboxEntry({ attempts: 10, status: "failed", lastAttemptAt: "2026-01-01T00:00:00.000Z" })]);

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapter: "noop",
    noopMode: "success",
    maxAttempts: 10
  });

  assert.equal(result.summary.discardedCount, 1);
  assert.equal(result.processedEvents[0]?.attempts, 10);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "discarded");
  assert.match(outbox.entries[0]?.lastError ?? "", /maxAttempts=10/);
});

test("lock valido existente faz dispatcher pular", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-valid-lock");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");
  const lockFilePath = `${outboxFilePath}.lock`;

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);
  await mkdir(path.dirname(lockFilePath), { recursive: true });
  await writeFile(
    lockFilePath,
    `${JSON.stringify({ pid: 9999, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, null, 2)}\n`,
    "utf8"
  );

  const result = await dispatchIncidentOutbox({ outboxFilePath });

  assert.equal(result.summary.skippedBecauseLocked, true);
  assert.equal(result.summary.processedCount, 0);
  assert.equal(result.lock.skippedBecauseLocked, true);

  const outbox = await readOutbox(outboxFilePath);
  assert.equal(outbox.entries[0]?.status, "pending");
});

test("lock expirado e substituido", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-expired-lock");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");
  const lockFilePath = `${outboxFilePath}.lock`;

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);
  await mkdir(path.dirname(lockFilePath), { recursive: true });
  await writeFile(
    lockFilePath,
    `${JSON.stringify({ pid: 1111, createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:10:00.000Z" }, null, 2)}\n`,
    "utf8"
  );

  const result = await dispatchIncidentOutbox({ outboxFilePath, adapter: "noop", noopMode: "success" });

  assert.equal(result.lock.replacedExpired, true);
  assert.equal(result.summary.sentCount, 1);
  await assert.rejects(access(lockFilePath));
});

test("salva tentativa no outbox antes de chamar o adapter", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-save-before-adapter");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const inspectingAdapter: DispatchAdapter = {
    name: "noop",
    async dispatch() {
      const snapshot = await readOutbox(outboxFilePath);
      assert.equal(snapshot.entries[0]?.attempts, 1);
      assert.equal(typeof snapshot.entries[0]?.lastAttemptAt, "string");

      return {
        outcome: "success",
        message: null
      };
    }
  };

  const result = await dispatchIncidentOutbox({
    outboxFilePath,
    adapterOverride: inspectingAdapter
  });

  assert.equal(result.summary.sentCount, 1);
});

test("configuracao CLI aceita adapter telegram e envia threadId, prefixo e base URL customizada", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-cli-telegram");
  const outboxFilePath = path.join(directoryPath, "data", "telegram-cli-outbox.json");
  const stdout = createCapturedWriter();
  const stderr = createCapturedWriter();
  const requests: CapturedTelegramRequest[] = [];
  const botToken = "999999:CLI_SEGREDO";

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);

  const exitCode = await runDispatchOutboxCli({
    env: {
      PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH: outboxFilePath,
      PUBLIC_LISTENER_DISPATCH_ADAPTER: "telegram",
      PUBLIC_LISTENER_TELEGRAM_BOT_TOKEN: botToken,
      PUBLIC_LISTENER_TELEGRAM_CHAT_ID: "-100998877",
      PUBLIC_LISTENER_TELEGRAM_API_BASE_URL: "https://telegram.example.test/base",
      PUBLIC_LISTENER_TELEGRAM_MESSAGE_PREFIX: "[cli-test]",
      PUBLIC_LISTENER_TELEGRAM_THREAD_ID: "91"
    },
    stdout: stdout.writer,
    stderr: stderr.writer,
    telegramFetchImpl: createTelegramFetchMock(createJsonResponse(200, { ok: true, result: { message_id: 2 } }), requests)
  });

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, `https://telegram.example.test/base/bot${botToken}/sendMessage`);
  assert.equal(requests[0]?.body.message_thread_id, 91);
  assert.match(String(requests[0]?.body.text ?? ""), /^\[cli-test\]/);
  assert.doesNotMatch(stdout.chunks.join(""), new RegExp(botToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(stderr.chunks.join(""), "");

  const result = JSON.parse(stdout.chunks.join("")) as DispatchOutboxResult;
  assert.equal(result.adapter, "telegram");
  assert.equal(result.summary.sentCount, 1);
});

test("loadDispatchOutboxCliConfig le variaveis do Telegram sem mudar o adapter padrao", () => {
  const config = loadDispatchOutboxCliConfig({
    PUBLIC_LISTENER_TELEGRAM_BOT_TOKEN: "123456:TOKEN",
    PUBLIC_LISTENER_TELEGRAM_CHAT_ID: "-100123456",
    PUBLIC_LISTENER_TELEGRAM_API_BASE_URL: "https://telegram.example.test/api",
    PUBLIC_LISTENER_TELEGRAM_MESSAGE_PREFIX: "[prod]",
    PUBLIC_LISTENER_TELEGRAM_THREAD_ID: "55",
    PUBLIC_LISTENER_TELEGRAM_TIMEOUT_MS: "12000"
  });

  assert.equal(config.adapter, "log");
  assert.equal(config.telegram?.botToken, "123456:TOKEN");
  assert.equal(config.telegram?.chatId, "-100123456");
  assert.equal(config.telegram?.apiBaseUrl, "https://telegram.example.test/api");
  assert.equal(config.telegram?.messagePrefix, "[prod]");
  assert.equal(config.telegram?.threadId, "55");
  assert.equal(config.telegram?.timeoutMs, 12000);
});

test("CLI usa PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH temporario e emite JSON final", async () => {
  const directoryPath = await createTemporaryTestDirectory("dispatch-cli-env-path");
  const relativeOutboxPath = path.join("tmp", "dispatch-outbox.json");
  const absoluteOutboxPath = path.join(directoryPath, relativeOutboxPath);
  const stdout = createCapturedWriter();
  const stderr = createCapturedWriter();

  await writeOutbox(absoluteOutboxPath, [createOutboxEntry()]);

  const exitCode = await withWorkingDirectory(directoryPath, async () =>
    runDispatchOutboxCli({
      env: {
        PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH: relativeOutboxPath,
        PUBLIC_LISTENER_DISPATCH_ADAPTER: "noop",
        PUBLIC_LISTENER_DISPATCH_NOOP_MODE: "success"
      },
      stdout: stdout.writer,
      stderr: stderr.writer
    })
  );

  assert.equal(exitCode, 0);
  const result = JSON.parse(stdout.chunks.join("")) as DispatchOutboxResult;
  assert.equal(result.commandName, "radio-cabrito-dispatch-outbox");
  assert.equal(result.outboxPath, absoluteOutboxPath);
  assert.equal(result.adapter, "noop");
  assert.equal(result.summary.sentCount, 1);

  const outbox = await readOutbox(absoluteOutboxPath);
  assert.equal(outbox.entries[0]?.status, "sent");
});

test("dispatcher nao toca caminhos reais de producao", async () => {
  const productionBefore = await snapshotProductionFiles();
  const directoryPath = await createTemporaryTestDirectory("dispatch-production-guard");
  const outboxFilePath = path.join(directoryPath, "data", "notifiable-events-outbox.json");

  await writeOutbox(outboxFilePath, [createOutboxEntry()]);
  await dispatchIncidentOutbox({ outboxFilePath, adapter: "noop", noopMode: "success" });

  assert.deepEqual(await snapshotProductionFiles(), productionBefore);
  await assertProductionFilesUntouched();
});