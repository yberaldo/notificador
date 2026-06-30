import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import type { PublicListenerMultiDiagnostic, PublicListenerStatus, Severity } from "../checks/public-listener-check/types.js";
import { evaluatePublicListenerIncidents } from "./evaluate-public-listener-incidents.js";
import { DEFAULT_INCIDENT_STATE_PATH, resolveIncidentStatePath } from "./state-store.js";

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

test("healthy -> timeout -> timeout abre incidente critico", async () => {
  const stateFilePath = await createStateFilePath("critical-open");

  let evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("healthy", "none", "audio_decoded_without_continuous_silence"), {
    stateFilePath
  });
  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "none");

  evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath
  });
  assert.equal(evaluation.notifiableEvents.length, 0);
  assert.equal(evaluation.incidentEvaluation.targets[0]?.transition, "none");
  assert.equal(evaluation.incidentEvaluation.targets[0]?.consecutiveFailures, 1);

  evaluation = await evaluatePublicListenerIncidents(createMultiDiagnostic("timeout", "critical", "operation_timeout"), {
    stateFilePath
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
