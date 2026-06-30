import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { PublicListenerMultiDiagnostic, PublicListenerStatus, Severity } from "../checks/public-listener-check/types.js";
import { evaluatePublicListenerIncidents } from "./evaluate-public-listener-incidents.js";

function createMultiDiagnostic(
  status: PublicListenerStatus,
  severity: Severity,
  reason: string = status
): PublicListenerMultiDiagnostic {
  const checkedAt = new Date().toISOString();

  return {
    checkName: "public-listener-check",
    checkVersion: "v1",
    mode: "multi",
    summary: {
      overallStatus: status === "healthy" ? "healthy" : "failed",
      healthyCount: status === "healthy" ? 1 : 0,
      failedCount: status === "healthy" ? 0 : 1,
      totalCount: 1
    },
    results: [
      {
        targetId: "geral",
        targetName: "Geral / Tudo",
        target: {
          streamUrl: "https://scrc.radiocabrito.com:13386/;",
          host: "scrc.radiocabrito.com"
        },
        result: {
          status,
          reason,
          severity,
          shouldOpenIncident: status !== "healthy",
          requiresConsecutiveFailures: status === "silent" || status === "stalled",
          message: `${status}:${reason}`
        },
        metrics: {
          bytesReceived: 1024,
          decodedSeconds: status === "healthy" ? 10 : 0,
          sampleDurationSeconds: 10,
          silenceDetectedSeconds: status === "silent" ? 10 : 0,
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
      }
    ]
  };
}

async function createStateFilePath(name: string): Promise<string> {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), `radio-cabrito-${name}-`));
  return path.join(directoryPath, "data", "incidents-state.json");
}

test("healthy -> timeout -> timeout abre incidente critico", async () => {
  const stateFilePath = await createStateFilePath("critical-open");

  let evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });
  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "none");

  evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });
  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "none");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.consecutiveFailures, 1);

  evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });
  assert.equal(evaluation.notifiableEvents.length, 1);
  assert.equal(evaluation.notifiableEvents[0]?.type, "incident_opened");
  assert.equal(evaluation.notifiableEvents[0]?.severity, "critical");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "opened");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.incidentState, "open");
});

test("healthy -> silent -> silent -> silent abre incidente warning", async () => {
  const stateFilePath = await createStateFilePath("warning-open");

  await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
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
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });

  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "recovering");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.incidentState, "open");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.consecutiveSuccesses, 1);
});

test("incidente aberto -> healthy -> healthy resolve", async () => {
  const stateFilePath = await createStateFilePath("resolved");

  await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });

  assert.equal(evaluation.notifiableEvents.length, 1);
  assert.equal(evaluation.notifiableEvents[0]?.type, "incident_resolved");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "resolved");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.incidentState, "closed");
});

test("warning aberto -> falha critica mantem incidente aberto e atualiza status corrente", async () => {
  const stateFilePath = await createStateFilePath("warning-to-critical");

  await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });
  await evaluatePublicListenerIncidents(createMultiDiagnostic("silent", "warning", "continuous_silence_detected"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });

  const evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
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
    stateFilePath,
    stateFileDisplayPath: "data/incidents-state.json"
  });

  assert.equal(evaluation.incidentEvaluation.stateStore.recoveredFromCorruption, true);
  assert.equal(evaluation.incidentEvaluation.stateStore.writeSucceeded, true);

  const rewritten = JSON.parse(await readFile(stateFilePath, "utf8")) as { schemaVersion: number };
  assert.equal(rewritten.schemaVersion, 1);
});
