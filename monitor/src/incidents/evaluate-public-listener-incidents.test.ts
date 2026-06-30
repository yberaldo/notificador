import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import type { PublicListenerMultiDiagnostic, PublicListenerStatus, Severity } from "../checks/public-listener-check/types.js";
import { evaluatePublicListenerIncidents } from "./evaluate-public-listener-incidents.js";
import { DEFAULT_INCIDENT_OUTBOX_PATH } from "./outbox-store.js";
import { DEFAULT_INCIDENT_STATE_PATH, resolveIncidentStatePath } from "./state-store.js";
import type { IncidentOutboxSnapshot } from "./outbox-types.js";
import type { IncidentStateSnapshot } from "./types.js";

interface SyntheticTargetDiagnostic {
  targetId: string;
  targetName: string;
  status: PublicListenerStatus;
  severity: Severity;
  reason?: string;
  streamUrl?: string;
  host?: string;
}

interface OptionalFileSnapshot {
  exists: boolean;
  content: string | null;
  size: number | null;
  mtimeMs: number | null;
}

function createMultiDiagnostic(
  status: PublicListenerStatus,
  severity: Severity,
  reason: string = status
): PublicListenerMultiDiagnostic {
  return createMultiDiagnosticWithTargets([
    {
      targetId: "geral",
      targetName: "Geral / Tudo",
      status,
      severity,
      reason,
      streamUrl: "https://scrc.radiocabrito.com:13386/;",
      host: "scrc.radiocabrito.com"
    }
  ]);
}

function createMultiDiagnosticWithTargets(targets: SyntheticTargetDiagnostic[]): PublicListenerMultiDiagnostic {
  const checkedAt = new Date().toISOString();
  const results = targets.map((target) => {
    const reason = target.reason ?? target.status;

    return {
      targetId: target.targetId,
      targetName: target.targetName,
      target: {
        streamUrl: target.streamUrl ?? `https://${target.targetId}.example.test/;`,
        host: target.host ?? `${target.targetId}.example.test`
      },
      result: {
        status: target.status,
        reason,
        severity: target.severity,
        shouldOpenIncident: target.status !== "healthy",
        requiresConsecutiveFailures: target.status === "silent" || target.status === "stalled",
        message: `${target.status}:${reason}`
      },
      metrics: {
        bytesReceived: 1024,
        decodedSeconds: target.status === "healthy" ? 10 : 0,
        sampleDurationSeconds: 10,
        silenceDetectedSeconds: target.status === "silent" ? 10 : 0,
        ffprobeExitCode: 0,
        ffmpegExitCode: 0
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
        startedAt: checkedAt,
        finishedAt: checkedAt,
        executionDurationMs: 100,
        checkedAt
      },
      debug: {
        enabled: false
      }
    };
  });
  const healthyCount = results.filter((result) => result.result.status === "healthy").length;
  const failedCount = results.length - healthyCount;
  const totalCount = results.length;

  return {
    checkName: "public-listener-check",
    checkVersion: "v1",
    mode: "multi",
    summary: {
      overallStatus: healthyCount === totalCount ? "healthy" : failedCount === totalCount ? "failed" : "degraded",
      healthyCount,
      failedCount,
      totalCount
    },
    results
  };
}

async function createStateFilePath(name: string): Promise<string> {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), `radio-cabrito-${name}-`));
  return path.join(directoryPath, "data", "incidents-state.json");
}

async function createOutboxFilePath(name: string): Promise<string> {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), `radio-cabrito-${name}-`));
  return path.join(directoryPath, "data", "notifiable-events-outbox.json");
}

async function snapshotOptionalFile(filePath: string): Promise<OptionalFileSnapshot> {
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

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

test("caminho relativo configurado resolve a partir do diretorio de execucao", async () => {
  const executionDirectory = await mkdtemp(path.join(os.tmpdir(), "radio-cabrito-relative-state-"));
  const resolved = resolveIncidentStatePath(path.join("tmp", "sim", "incidents-state.json"), executionDirectory);

  assert.equal(resolved.filePath, path.resolve(executionDirectory, "tmp", "sim", "incidents-state.json"));
  assert.equal(resolved.displayPath, path.resolve(executionDirectory, "tmp", "sim", "incidents-state.json"));
});

test("state path configurado grava fora do caminho padrao", async () => {
  const stateFilePath = await createStateFilePath("configured-path");
  const defaultStateBefore = await snapshotOptionalFile(DEFAULT_INCIDENT_STATE_PATH);

  const evaluation = await evaluatePublicListenerIncidents(
    createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"),
    { stateFilePath }
  );

  assert.equal(evaluation.incidentEvaluation.stateStore.path, stateFilePath);

  const storedState = JSON.parse(await readFile(stateFilePath, "utf8")) as {
    targets: Record<string, { targetId: string }>;
  };
  assert.equal(storedState.targets.geral.targetId, "geral");

  const defaultStateAfter = await snapshotOptionalFile(DEFAULT_INCIDENT_STATE_PATH);
  assert.deepEqual(defaultStateAfter, defaultStateBefore);
});

test("outbox path configurado grava fora do caminho padrao", async () => {
  const stateFilePath = await createStateFilePath("configured-outbox-state");
  const outboxFilePath = await createOutboxFilePath("configured-outbox-path");
  const defaultOutboxBefore = await snapshotOptionalFile(DEFAULT_INCIDENT_OUTBOX_PATH);

  await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    outboxFilePath
  });
  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    outboxFilePath
  });

  assert.equal(evaluation.incidentEvaluation.outbox.path, outboxFilePath);
  assert.equal(evaluation.incidentEvaluation.outbox.writeSucceeded, true);
  assert.equal(evaluation.incidentEvaluation.outbox.queuedCount, 1);
  assert.equal(evaluation.incidentEvaluation.outbox.duplicateCount, 0);

  const storedOutbox = JSON.parse(await readFile(outboxFilePath, "utf8")) as IncidentOutboxSnapshot;
  assert.equal(storedOutbox.entries.length, 1);
  assert.equal(storedOutbox.entries[0]?.status, "pending");

  const defaultOutboxAfter = await snapshotOptionalFile(DEFAULT_INCIDENT_OUTBOX_PATH);
  assert.deepEqual(defaultOutboxAfter, defaultOutboxBefore);
});

test("healthy -> timeout -> timeout abre incidente critico", async () => {
  const stateFilePath = await createStateFilePath("critical-open");
  const outboxFilePath = await createOutboxFilePath("critical-open");

  let evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath,
    outboxFilePath
  });
  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "none");

  evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    outboxFilePath
  });
  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "none");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.consecutiveFailures, 1);

  evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    outboxFilePath
  });
  assert.equal(evaluation.notifiableEvents.length, 1);
  assert.equal(evaluation.notifiableEvents[0]?.type, "incident_opened");
  assert.equal(evaluation.notifiableEvents[0]?.severity, "critical");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "opened");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.incidentState, "open");

  const repeatedEvaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    outboxFilePath
  });

  assert.equal(repeatedEvaluation.incidentEvaluation.outbox.queuedCount, 0);
  assert.equal(repeatedEvaluation.incidentEvaluation.outbox.duplicateCount, 0);

  const outbox = JSON.parse(await readFile(outboxFilePath, "utf8")) as IncidentOutboxSnapshot;
  assert.equal(outbox.entries.length, 1);
  assert.equal(outbox.entries[0]?.type, "incident_opened");
});

test("falha estrutural repetida nao duplica outbox e atualiza lastSeenAt", async () => {
  const stateFilePath = await createStateFilePath("structural-dedupe");
  const outboxFilePath = await createOutboxFilePath("structural-dedupe");

  let evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("connect_failed", "critical", "unsupported_protocol"), {
    stateFilePath,
    outboxFilePath
  });

  assert.equal(evaluation.notifiableEvents.length, 1);
  assert.equal(evaluation.incidentEvaluation.outbox.queuedCount, 1);

  const firstOutbox = JSON.parse(await readFile(outboxFilePath, "utf8")) as IncidentOutboxSnapshot;
  assert.equal(firstOutbox.entries.length, 1);
  const firstEntry = firstOutbox.entries[0];
  assert.equal(firstEntry?.status, "pending");

  evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("connect_failed", "critical", "unsupported_protocol"), {
    stateFilePath,
    outboxFilePath
  });

  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.outbox.queuedCount, 0);
  assert.equal(evaluation.incidentEvaluation.outbox.duplicateCount, 0);

  const secondOutbox = JSON.parse(await readFile(outboxFilePath, "utf8")) as IncidentOutboxSnapshot;
  assert.equal(secondOutbox.entries.length, 1);
  assert.equal(secondOutbox.entries[0]?.dedupeKey, firstEntry?.dedupeKey);
});

test("arquivo de outbox corrompido nao quebra a avaliacao", async () => {
  const stateFilePath = await createStateFilePath("corrupted-outbox-state");
  const outboxFilePath = await createOutboxFilePath("corrupted-outbox");
  await mkdir(path.dirname(outboxFilePath), { recursive: true });
  await writeFile(outboxFilePath, "{ invalid json", "utf8");

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath,
    outboxFilePath
  });

  assert.equal(evaluation.incidentEvaluation.outbox.recoveredFromCorruption, true);
  assert.equal(evaluation.incidentEvaluation.outbox.writeSucceeded, true);

  const rewritten = JSON.parse(await readFile(outboxFilePath, "utf8")) as IncidentOutboxSnapshot;
  assert.equal(rewritten.schemaVersion, 1);
  assert.deepEqual(rewritten.entries, []);
});

test("outbox e salvo antes do incident state e erro no outbox impede salvar state com evento novo", async () => {
  const stateFilePath = await createStateFilePath("ordering");
  const outboxFilePath = await createOutboxFilePath("ordering");
  const callOrder: string[] = [];

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("connect_failed", "critical", "unsupported_protocol"), {
    stateFilePath,
    outboxFilePath,
    persistence: {
      async loadIncidentState(filePath, template) {
        const { loadIncidentState } = await import("./state-store.js");
        return loadIncidentState(filePath, template);
      },
      async loadIncidentOutbox(filePath, updatedAt) {
        const { loadIncidentOutbox } = await import("./outbox-store.js");
        return loadIncidentOutbox(filePath, updatedAt);
      },
      async saveIncidentOutbox() {
        callOrder.push("outbox");
        return {
          writeSucceeded: false,
          writeError: "simulated outbox failure"
        };
      },
      async saveIncidentState() {
        callOrder.push("state");
        return {
          writeSucceeded: true,
          writeError: null
        };
      }
    }
  });

  assert.deepEqual(callOrder, ["outbox"]);
  assert.equal(evaluation.notifiableEvents.length, 1);
  assert.equal(evaluation.incidentEvaluation.outbox.writeSucceeded, false);
  assert.match(evaluation.incidentEvaluation.outbox.writeError ?? "", /simulated outbox failure/);
  assert.equal(evaluation.incidentEvaluation.stateStore.writeSucceeded, false);
  assert.match(evaluation.incidentEvaluation.stateStore.writeError ?? "", /nao foi salvo/);
});

test("se nao ha evento novo, falha no outbox nao bloqueia persistencia do state", async () => {
  const stateFilePath = await createStateFilePath("ordering-no-new-events");
  const outboxFilePath = await createOutboxFilePath("ordering-no-new-events");
  const savedStates: IncidentStateSnapshot[] = [];

  const firstEvaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath,
    outboxFilePath,
    persistence: {
      async loadIncidentState(filePath, template) {
        const { loadIncidentState } = await import("./state-store.js");
        return loadIncidentState(filePath, template);
      },
      async loadIncidentOutbox(filePath, updatedAt) {
        const { loadIncidentOutbox } = await import("./outbox-store.js");
        return loadIncidentOutbox(filePath, updatedAt);
      },
      async saveIncidentOutbox() {
        return {
          writeSucceeded: false,
          writeError: "simulated outbox failure"
        };
      },
      async saveIncidentState(_filePath, state) {
        savedStates.push(state);
        return {
          writeSucceeded: true,
          writeError: null
        };
      }
    }
  });

  assert.equal(firstEvaluation.notifiableEvents.length, 0);
  assert.equal(firstEvaluation.incidentEvaluation.outbox.queuedCount, 0);
  assert.equal(savedStates.length, 1);
});

test("healthy -> silent -> silent -> silent abre incidente warning", async () => {
  const stateFilePath = await createStateFilePath("warning-open");

  await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath
  });

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath
  });

  assert.equal(evaluation.notifiableEvents.length, 1);
  assert.equal(evaluation.notifiableEvents[0]?.type, "incident_opened");
  assert.equal(evaluation.notifiableEvents[0]?.severity, "warning");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.consecutiveFailures, 3);
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "opened");
});

test("incidente aberto -> healthy nao fecha na primeira rodada", async () => {
  const stateFilePath = await createStateFilePath("recovering");

  await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath
  });

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath
  });

  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "recovering");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.incidentState, "open");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.consecutiveSuccesses, 1);
});

test("incidente aberto -> healthy -> healthy resolve", async () => {
  const stateFilePath = await createStateFilePath("resolved");

  await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath
  });

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath
  });

  assert.equal(evaluation.notifiableEvents.length, 1);
  assert.equal(evaluation.notifiableEvents[0]?.type, "incident_resolved");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "resolved");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.incidentState, "closed");
});

test("warning aberto -> falha critica mantem incidente aberto e atualiza status corrente", async () => {
  const stateFilePath = await createStateFilePath("warning-to-critical");

  await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath
  });

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath
  });

  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "kept_open");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.incidentState, "open");

  const state = JSON.parse(await readFile(stateFilePath, "utf8")) as {
    targets: Record<string, { currentIncident: { currentStatus: string; currentSeverity: string } }>;
  };
  assert.equal(state.targets.geral.currentIncident.currentStatus, "timeout");
  assert.equal(state.targets.geral.currentIncident.currentSeverity, "critical");
});

test("arquivo de estado corrompido nao quebra a avaliacao", async () => {
  const stateFilePath = await createStateFilePath("corrupted-state");
  await mkdir(path.dirname(stateFilePath), { recursive: true });
  await writeFile(stateFilePath, "{ invalid json", "utf8");

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath
  });

  assert.equal(evaluation.incidentEvaluation.stateStore.recoveredFromCorruption, true);
  assert.equal(evaluation.incidentEvaluation.stateStore.writeSucceeded, true);

  const rewritten = JSON.parse(await readFile(stateFilePath, "utf8")) as { schemaVersion: number };
  assert.equal(rewritten.schemaVersion, 1);
});

test("targets obsoletos saem do snapshot sem gerar evento", async () => {
  const stateFilePath = await createStateFilePath("stale-targets");

  await evaluatePublicListenerIncidents(
    createMultiDiagnosticWithTargets([
      {
        targetId: "sim-geral",
        targetName: "Sim Geral",
        status: "timeout",
        severity: "critical",
        reason: "operation_timeout"
      }
    ]),
    { stateFilePath }
  );
  await evaluatePublicListenerIncidents(
    createMultiDiagnosticWithTargets([
      {
        targetId: "sim-geral",
        targetName: "Sim Geral",
        status: "timeout",
        severity: "critical",
        reason: "operation_timeout"
      }
    ]),
    { stateFilePath }
  );

  const evaluation = await evaluatePublicListenerIncidents(
    createMultiDiagnosticWithTargets([
      {
        targetId: "geral",
        targetName: "Geral / Tudo",
        status: "healthy",
        severity: "none",
        reason: "audio_decoded_without_continuous_silence",
        streamUrl: "https://scrc.radiocabrito.com:13386/;",
        host: "scrc.radiocabrito.com"
      }
    ]),
    { stateFilePath }
  );

  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.summary.targetCount, 1);

  const state = JSON.parse(await readFile(stateFilePath, "utf8")) as {
    targets: Record<string, { targetId: string }>;
  };
  assert.deepEqual(Object.keys(state.targets), ["geral"]);
  assert.equal(state.targets.geral.targetId, "geral");
});
