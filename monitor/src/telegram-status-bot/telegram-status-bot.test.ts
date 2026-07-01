import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { isStatusCommand } from "./commands.js";
import { formatStatusMessage } from "./status-format.js";
import {
  loadTelegramStatusOffset,
  saveTelegramStatusOffset
} from "./offset-store.js";
import { runTelegramStatusBotCli } from "./cli.js";
import {
  assertProductionFilesUntouched,
  createTemporaryTestDirectory,
  snapshotProductionFiles
} from "../incidents/test-helpers.js";
import type {
  PublicListenerMultiDiagnostic,
  PublicListenerStatus,
  Severity
} from "../checks/public-listener-check/types.js";

interface CapturedTelegramRequest {
  methodName: string;
  url: URL;
  body: Record<string, unknown> | null;
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
  updates: Array<Record<string, unknown>>,
  requests: CapturedTelegramRequest[]
): typeof fetch {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const methodName = url.pathname.split("/").at(-1) ?? "";
    const request: CapturedTelegramRequest = {
      methodName,
      url,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    };
    requests.push(request);

    if (methodName === "getUpdates") {
      return createJsonResponse(200, { ok: true, result: updates });
    }

    return createJsonResponse(200, { ok: true, result: { message_id: requests.length } });
  };

  return fetchImpl;
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

function createDiagnostic(statuses: Record<string, PublicListenerStatus>): PublicListenerMultiDiagnostic {
  const results: PublicListenerMultiDiagnostic["results"] = Object.entries(statuses).map(([targetId, status]) => {
    const targetName = targetId === "geral"
      ? "Geral / Tudo"
      : targetId === "modao"
        ? "Modão"
        : "Festa / Universitário";

    return {
      targetId,
      targetName,
      target: {
        streamUrl: `https://example.test/${targetId}`,
        host: "example.test"
      },
      result: {
        status,
        reason: status,
        severity: (status === "healthy" ? "none" : "critical") satisfies Severity,
        shouldOpenIncident: status !== "healthy",
        requiresConsecutiveFailures: false,
        message: status
      },
      metrics: {
        bytesReceived: status === "healthy" ? 1024 : 0,
        decodedSeconds: status === "healthy" ? 10 : 0,
        sampleDurationSeconds: 10,
        silenceDetectedSeconds: 0,
        ffprobeExitCode: status === "healthy" ? 0 : 1,
        ffmpegExitCode: status === "healthy" ? 0 : 1
      },
      evidence: {
        contentType: null,
        tlsError: null,
        ffprobeSummary: null,
        ffmpegSummary: null,
        stderrSnippet: null,
        stdoutSnippet: null
      },
      timing: {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        executionDurationMs: 1000,
        checkedAt: "2026-01-01T00:00:01.000Z"
      },
      debug: {
        enabled: false
      }
    };
  });
  const healthyCount = results.filter((result) => result.result.status === "healthy").length;
  const failedCount = results.length - healthyCount;

  return {
    checkName: "public-listener-check",
    checkVersion: "v1",
    mode: "multi",
    summary: {
      overallStatus: failedCount === 0 ? "healthy" : healthyCount === 0 ? "failed" : "degraded",
      healthyCount,
      failedCount,
      totalCount: results.length
    },
    results
  };
}

function createBaseEnv(offsetFilePath: string): NodeJS.ProcessEnv {
  return {
    PUBLIC_LISTENER_TELEGRAM_BOT_TOKEN: "123456:STATUS_BOT_SEGREDO",
    PUBLIC_LISTENER_TELEGRAM_CHAT_ID: "-100123456",
    PUBLIC_LISTENER_TELEGRAM_API_BASE_URL: "https://telegram.example.test/api",
    PUBLIC_LISTENER_TELEGRAM_STATUS_OFFSET_PATH: offsetFilePath,
    PUBLIC_LISTENER_TELEGRAM_STATUS_ONCE: "true",
    PUBLIC_LISTENER_TARGETS_JSON: '[{"id":"geral","name":"Geral / Tudo","url":"https://example.test/geral"},{"id":"modao","name":"Modão","url":"https://example.test/modao"},{"id":"festa","name":"Festa / Universitário","url":"https://example.test/festa"}]'
  };
}

test("reconhece comandos de status esperados", () => {
  assert.equal(isStatusCommand("/status"), true);
  assert.equal(isStatusCommand("status"), true);
  assert.equal(isStatusCommand("online"), true);
  assert.equal(isStatusCommand("tão online?"), true);
  assert.equal(isStatusCommand("tao online?"), true);
  assert.equal(isStatusCommand("ola"), false);
  assert.equal(isStatusCommand("/start"), false);
});

test("formata status ONLINE e OFFLINE de forma simples", () => {
  const message = formatStatusMessage(createDiagnostic({
    geral: "healthy",
    modao: "timeout",
    festa: "healthy"
  }));

  assert.equal(
    message,
    "📻 Status dos players\nGeral / Tudo: ONLINE\nModão: OFFLINE\nFesta / Universitário: ONLINE"
  );
});

test("offset store cria, le e grava em caminho temporario", async () => {
  const directoryPath = await createTemporaryTestDirectory("telegram-offset-store");
  const offsetFilePath = path.join(directoryPath, "data", "telegram-status-offset.json");

  assert.equal((await loadTelegramStatusOffset(offsetFilePath)).exists, false);

  await saveTelegramStatusOffset(offsetFilePath, 42, new Date("2026-01-01T00:00:00.000Z"));
  const loaded = await loadTelegramStatusOffset(offsetFilePath);

  assert.equal(loaded.exists, true);
  assert.equal(loaded.snapshot?.schemaVersion, 1);
  assert.equal(loaded.snapshot?.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(loaded.snapshot?.offset, 42);
});

test("bootstrap sem offset nao responde mensagens antigas e grava maior offset", async () => {
  const directoryPath = await createTemporaryTestDirectory("telegram-bootstrap");
  const offsetFilePath = path.join(directoryPath, "data", "telegram-status-offset.json");
  const requests: CapturedTelegramRequest[] = [];
  const stdout = createCapturedWriter();
  const stderr = createCapturedWriter();
  let checkCount = 0;

  const exitCode = await runTelegramStatusBotCli({
    env: createBaseEnv(offsetFilePath),
    stdout: stdout.writer,
    stderr: stderr.writer,
    fetchImpl: createTelegramFetchMock([
      {
        update_id: 10,
        message: {
          message_id: 1,
          chat: { id: "-100123456" },
          text: "/status"
        }
      }
    ], requests),
    runStatusCheck: async () => {
      checkCount += 1;
      return createDiagnostic({ geral: "healthy" });
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(checkCount, 0);
  assert.deepEqual(requests.map((request) => request.methodName), ["getUpdates"]);
  assert.equal((await loadTelegramStatusOffset(offsetFilePath)).snapshot?.offset, 11);
  assert.equal(stdout.chunks.join(""), "");
  assert.equal(stderr.chunks.join(""), "");
});

test("chat nao autorizado e ignorado e offset avanca", async () => {
  const directoryPath = await createTemporaryTestDirectory("telegram-unauthorized-chat");
  const offsetFilePath = path.join(directoryPath, "data", "telegram-status-offset.json");
  const requests: CapturedTelegramRequest[] = [];
  let checkCount = 0;

  await saveTelegramStatusOffset(offsetFilePath, 20, new Date("2026-01-01T00:00:00.000Z"));

  const exitCode = await runTelegramStatusBotCli({
    env: createBaseEnv(offsetFilePath),
    fetchImpl: createTelegramFetchMock([
      {
        update_id: 20,
        message: {
          message_id: 1,
          chat: { id: "-100999999" },
          text: "/status"
        }
      }
    ], requests),
    runStatusCheck: async () => {
      checkCount += 1;
      return createDiagnostic({ geral: "healthy" });
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(checkCount, 0);
  assert.deepEqual(requests.map((request) => request.methodName), ["getUpdates"]);
  assert.equal((await loadTelegramStatusOffset(offsetFilePath)).snapshot?.offset, 21);
});

test("comando autorizado envia mensagem inicial e resposta final", async () => {
  const directoryPath = await createTemporaryTestDirectory("telegram-authorized-status");
  const offsetFilePath = path.join(directoryPath, "data", "telegram-status-offset.json");
  const requests: CapturedTelegramRequest[] = [];

  await saveTelegramStatusOffset(offsetFilePath, 30, new Date("2026-01-01T00:00:00.000Z"));

  const exitCode = await runTelegramStatusBotCli({
    env: createBaseEnv(offsetFilePath),
    fetchImpl: createTelegramFetchMock([
      {
        update_id: 30,
        message: {
          message_id: 1,
          chat: { id: "-100123456" },
          text: "/status"
        }
      }
    ], requests),
    runStatusCheck: async () => createDiagnostic({
      geral: "healthy",
      modao: "healthy",
      festa: "timeout"
    })
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requests.map((request) => request.methodName), ["getUpdates", "sendMessage", "sendMessage"]);
  assert.equal(requests[1]?.body?.text, "⏳ Checando players agora...");
  assert.equal(
    requests[2]?.body?.text,
    "📻 Status dos players\nGeral / Tudo: ONLINE\nModão: ONLINE\nFesta / Universitário: OFFLINE"
  );
  assert.equal((await loadTelegramStatusOffset(offsetFilePath)).snapshot?.offset, 31);
});

test("thread configurada filtra mensagens e responde no topico", async () => {
  const directoryPath = await createTemporaryTestDirectory("telegram-thread");
  const offsetFilePath = path.join(directoryPath, "data", "telegram-status-offset.json");
  const requests: CapturedTelegramRequest[] = [];
  const env = {
    ...createBaseEnv(offsetFilePath),
    PUBLIC_LISTENER_TELEGRAM_THREAD_ID: "77"
  };

  await saveTelegramStatusOffset(offsetFilePath, 40, new Date("2026-01-01T00:00:00.000Z"));

  const exitCode = await runTelegramStatusBotCli({
    env,
    fetchImpl: createTelegramFetchMock([
      {
        update_id: 40,
        message: {
          message_id: 1,
          chat: { id: "-100123456" },
          message_thread_id: 99,
          text: "/status"
        }
      },
      {
        update_id: 41,
        message: {
          message_id: 2,
          chat: { id: "-100123456" },
          message_thread_id: 77,
          text: "online"
        }
      }
    ], requests),
    runStatusCheck: async () => createDiagnostic({ geral: "healthy" })
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requests.map((request) => request.methodName), ["getUpdates", "sendMessage", "sendMessage"]);
  assert.equal(requests[1]?.body?.message_thread_id, 77);
  assert.equal(requests[2]?.body?.message_thread_id, 77);
  assert.equal((await loadTelegramStatusOffset(offsetFilePath)).snapshot?.offset, 42);
});

test("segundo comando em lote recebe aviso enquanto checagem esta em andamento", async () => {
  const directoryPath = await createTemporaryTestDirectory("telegram-busy");
  const offsetFilePath = path.join(directoryPath, "data", "telegram-status-offset.json");
  const requests: CapturedTelegramRequest[] = [];

  await saveTelegramStatusOffset(offsetFilePath, 50, new Date("2026-01-01T00:00:00.000Z"));

  const exitCode = await runTelegramStatusBotCli({
    env: createBaseEnv(offsetFilePath),
    fetchImpl: createTelegramFetchMock([
      {
        update_id: 50,
        message: {
          message_id: 1,
          chat: { id: "-100123456" },
          text: "/status"
        }
      },
      {
        update_id: 51,
        message: {
          message_id: 2,
          chat: { id: "-100123456" },
          text: "status"
        }
      }
    ], requests),
    runStatusCheck: async () => new Promise((resolve) => {
      setTimeout(() => resolve(createDiagnostic({ geral: "healthy" })), 5);
    })
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(
    requests.filter((request) => request.methodName === "sendMessage").map((request) => request.body?.text),
    [
      "⏳ Checando players agora...",
      "⏳ Já estou checando os players. Tente novamente em instantes.",
      "📻 Status dos players\nGeral / Tudo: ONLINE"
    ]
  );
});

test("token nao aparece em erros ou logs de teste", async () => {
  const directoryPath = await createTemporaryTestDirectory("telegram-token-sanitize");
  const offsetFilePath = path.join(directoryPath, "data", "telegram-status-offset.json");
  const stderr = createCapturedWriter();
  const token = "123456:STATUS_BOT_SEGREDO";
  const fetchImpl: typeof fetch = async (input) => {
    throw new Error(`falha em ${String(input)}`);
  };

  const exitCode = await runTelegramStatusBotCli({
    env: createBaseEnv(offsetFilePath),
    stderr: stderr.writer,
    fetchImpl
  });

  const stderrText = stderr.chunks.join("");

  assert.equal(exitCode, 1);
  assert.doesNotMatch(stderrText, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(stderrText, /\/bot123456:STATUS_BOT_SEGREDO/);
  assert.match(stderrText, /\/bot\[redacted\]/);
});

test("modo once termina e nao toca arquivos reais de incidentes ou outbox", async () => {
  const productionBefore = await snapshotProductionFiles();
  const directoryPath = await createTemporaryTestDirectory("telegram-production-guard");
  const offsetFilePath = path.join(directoryPath, "data", "telegram-status-offset.json");
  const requests: CapturedTelegramRequest[] = [];

  await saveTelegramStatusOffset(offsetFilePath, 60, new Date("2026-01-01T00:00:00.000Z"));

  const exitCode = await runTelegramStatusBotCli({
    env: createBaseEnv(offsetFilePath),
    fetchImpl: createTelegramFetchMock([], requests),
    runStatusCheck: async () => createDiagnostic({ geral: "healthy" })
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(await snapshotProductionFiles(), productionBefore);
  await assertProductionFilesUntouched();

  const offsetContent = await readFile(offsetFilePath, "utf8");
  assert.match(offsetContent, /"offset": 60/);
});
