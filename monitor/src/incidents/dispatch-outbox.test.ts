import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dispatchIncidentOutbox } from "./dispatch-outbox.js";
import { runDispatchOutboxCli } from "./dispatch-outbox-cli.js";
import { createEmptyIncidentOutboxSnapshot, saveIncidentOutbox } from "./outbox-store.js";
import type { IncidentOutboxEntry, IncidentOutboxSnapshot } from "./outbox-types.js";
import {
  assertProductionFilesUntouched,
  createTemporaryTestDirectory,
  snapshotProductionFiles,
  withWorkingDirectory
} from "./test-helpers.js";
import type { DispatchAdapter, DispatchOutboxResult } from "./dispatch-types.js";

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