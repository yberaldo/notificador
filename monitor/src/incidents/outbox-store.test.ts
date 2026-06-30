import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createEmptyIncidentOutboxSnapshot,
  resolveIncidentOutboxPath,
  upsertIncidentOutboxEntries
} from "./outbox-store.js";
import { createTemporaryTestDirectory, withWorkingDirectory } from "./test-helpers.js";
import type { NotifiableEventOutboxPayload } from "./outbox-types.js";

function createEvent(overrides: Partial<NotifiableEventOutboxPayload> = {}): NotifiableEventOutboxPayload {
  return {
    eventId: "incident_opened:geral:fresh:2026-01-01T00:00:00.000Z",
    incidentId: "geral:fresh",
    targetId: "geral",
    targetName: "Geral / Tudo",
    type: "incident_opened",
    status: "timeout",
    reason: "operation_timeout",
    severity: "critical",
    occurredAt: "2026-01-01T00:00:00.000Z",
    streakCount: 2,
    dedupeKey: "incident_opened:geral:fresh",
    ...overrides
  };
}

test("caminho relativo configurado do outbox resolve a partir do diretorio de execucao", async () => {
  const executionDirectory = await createTemporaryTestDirectory("relative-outbox");

  await withWorkingDirectory(executionDirectory, async () => {
    const resolved = resolveIncidentOutboxPath(path.join("tmp", "sim", "notifiable-events-outbox.json"));

    assert.equal(resolved.filePath, path.resolve(executionDirectory, "tmp", "sim", "notifiable-events-outbox.json"));
    assert.equal(resolved.displayPath, path.resolve(executionDirectory, "tmp", "sim", "notifiable-events-outbox.json"));
  });
});

test("evento novo entra como pending no outbox", () => {
  const snapshot = createEmptyIncidentOutboxSnapshot("2026-01-01T00:00:00.000Z");
  const result = upsertIncidentOutboxEntries(snapshot, [createEvent()], "2026-01-01T00:00:05.000Z");

  assert.equal(result.queuedCount, 1);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.outbox.entries.length, 1);
  assert.equal(result.outbox.entries[0]?.status, "pending");
  assert.equal(result.outbox.entries[0]?.queuedAt, "2026-01-01T00:00:05.000Z");
  assert.equal(result.outbox.entries[0]?.lastSeenAt, "2026-01-01T00:00:00.000Z");
  assert.equal(result.outbox.entries[0]?.attempts, 0);
});

test("mesmo dedupeKey nao duplica e atualiza lastSeenAt", () => {
  const firstSnapshot = upsertIncidentOutboxEntries(
    createEmptyIncidentOutboxSnapshot("2026-01-01T00:00:00.000Z"),
    [createEvent()],
    "2026-01-01T00:00:05.000Z"
  ).outbox;

  const result = upsertIncidentOutboxEntries(
    firstSnapshot,
    [
      createEvent({
        eventId: "incident_opened:geral:fresh:2026-01-01T00:02:00.000Z",
        occurredAt: "2026-01-01T00:02:00.000Z"
      })
    ],
    "2026-01-01T00:02:05.000Z"
  );

  assert.equal(result.queuedCount, 0);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.outbox.entries.length, 1);
  assert.equal(result.outbox.entries[0]?.eventId, "incident_opened:geral:fresh:2026-01-01T00:00:00.000Z");
  assert.equal(result.outbox.entries[0]?.updatedAt, "2026-01-01T00:02:05.000Z");
  assert.equal(result.outbox.entries[0]?.lastSeenAt, "2026-01-01T00:02:00.000Z");
});

test("incident_opened e incident_resolved viram entradas independentes", () => {
  const result = upsertIncidentOutboxEntries(
    createEmptyIncidentOutboxSnapshot("2026-01-01T00:00:00.000Z"),
    [
      createEvent(),
      createEvent({
        eventId: "incident_resolved:geral:fresh:2026-01-01T00:10:00.000Z",
        type: "incident_resolved",
        status: "healthy",
        reason: "audio_decoded_without_continuous_silence",
        severity: "none",
        occurredAt: "2026-01-01T00:10:00.000Z",
        streakCount: 2,
        dedupeKey: "incident_resolved:geral:fresh"
      })
    ],
    "2026-01-01T00:10:05.000Z"
  );

  assert.equal(result.queuedCount, 2);
  assert.equal(result.outbox.entries.length, 2);
  assert.deepEqual(
    result.outbox.entries.map((entry) => entry.type).sort(),
    ["incident_opened", "incident_resolved"]
  );
});