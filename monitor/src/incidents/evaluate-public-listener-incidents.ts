import type {
  PublicListenerDiagnostic,
  PublicListenerMultiDiagnostic,
  PublicListenerStatus,
  Severity
} from "../checks/public-listener-check/types.js";
import { classifyIncidentPolicy, INCIDENT_POLICY } from "./policy.js";
import {
  loadIncidentOutbox,
  resolveIncidentOutboxPath,
  saveIncidentOutbox,
  upsertIncidentOutboxEntries
} from "./outbox-store.js";
import {
  createClosedIncidentState,
  createEmptyTargetState,
  loadIncidentState,
  resolveIncidentStatePath,
  saveIncidentState
} from "./state-store.js";
import type {
  EvaluatePublicListenerIncidentsResult,
  IncidentCurrentIncidentState,
  IncidentEvaluationSummary,
  IncidentEvaluationTargetResult,
  IncidentStateSnapshot,
  IncidentTargetState,
  NotifiableIncidentEvent,
  PublicListenerDiagnosticInput
} from "./types.js";

interface EvaluateOptions {
  stateFilePath?: string;
  outboxFilePath?: string;
  persistence?: Partial<{
    loadIncidentState: typeof loadIncidentState;
    saveIncidentState: typeof saveIncidentState;
    loadIncidentOutbox: typeof loadIncidentOutbox;
    saveIncidentOutbox: typeof saveIncidentOutbox;
  }>;
}

const DEFAULT_PERSISTENCE = {
  loadIncidentState,
  saveIncidentState,
  loadIncidentOutbox,
  saveIncidentOutbox
};

export async function evaluatePublicListenerIncidents(
  diagnostic: PublicListenerDiagnosticInput,
  options: EvaluateOptions = {}
): Promise<EvaluatePublicListenerIncidentsResult> {
  const evaluatedAt = new Date().toISOString();
  const persistence = {
    ...DEFAULT_PERSISTENCE,
    ...options.persistence
  };
  const stateStore = resolveIncidentStatePath(options.stateFilePath);
  const outboxStore = resolveIncidentOutboxPath(options.outboxFilePath);
  const template = {
    updatedAt: evaluatedAt,
    checkName: diagnostic.checkName,
    checkVersion: diagnostic.checkVersion,
    policySnapshot: INCIDENT_POLICY
  };
  const [{ state: currentState, meta: loadMeta }, { outbox: currentOutbox, meta: outboxLoadMeta }] = await Promise.all([
    persistence.loadIncidentState(stateStore.filePath, template),
    persistence.loadIncidentOutbox(outboxStore.filePath, evaluatedAt)
  ]);
  const normalizedTargets = normalizeDiagnosticTargets(diagnostic);
  const nextTargets: IncidentStateSnapshot["targets"] = {};
  const targetResults: IncidentEvaluationTargetResult[] = [];
  const notifiableEvents: NotifiableIncidentEvent[] = [];

  for (const target of normalizedTargets) {
    const previousState = currentState.targets[target.targetId] ?? createEmptyTargetState(target.targetId, target.targetName, target.streamUrl);
    const evaluatedTarget = evaluateTarget(previousState, target, evaluatedAt);
    nextTargets[target.targetId] = evaluatedTarget.nextState;
    targetResults.push(evaluatedTarget.result);
    notifiableEvents.push(...evaluatedTarget.events);
  }

  const nextState: IncidentStateSnapshot = {
    schemaVersion: currentState.schemaVersion,
    updatedAt: evaluatedAt,
    checkName: diagnostic.checkName,
    checkVersion: diagnostic.checkVersion,
    policySnapshot: INCIDENT_POLICY,
    targets: nextTargets
  };
  const outboxUpsert = upsertIncidentOutboxEntries(currentOutbox, notifiableEvents, evaluatedAt);
  const outboxWriteMeta = await persistence.saveIncidentOutbox(outboxStore.filePath, outboxUpsert.outbox);
  const shouldPersistState = outboxWriteMeta.writeSucceeded || outboxUpsert.queuedCount === 0;
  const writeMeta = shouldPersistState
    ? await persistence.saveIncidentState(stateStore.filePath, nextState)
    : {
        writeSucceeded: false,
        writeError: buildSkippedStateWriteError(outboxUpsert.queuedCount, outboxWriteMeta.writeError)
      };

  return {
    incidentEvaluation: {
      schemaVersion: nextState.schemaVersion,
      evaluatedAt,
      checkName: diagnostic.checkName,
      checkVersion: diagnostic.checkVersion,
      policySnapshot: INCIDENT_POLICY,
      summary: buildSummary(targetResults),
      stateStore: {
        path: stateStore.displayPath,
        loadSource: loadMeta.loadSource,
        recoveredFromCorruption: loadMeta.recoveredFromCorruption,
        loadError: loadMeta.loadError,
        writeSucceeded: writeMeta.writeSucceeded,
        writeError: writeMeta.writeError
      },
      outbox: {
        path: outboxStore.displayPath,
        loadSource: outboxLoadMeta.loadSource,
        recoveredFromCorruption: outboxLoadMeta.recoveredFromCorruption,
        loadError: outboxLoadMeta.loadError,
        queuedCount: outboxUpsert.queuedCount,
        duplicateCount: outboxUpsert.duplicateCount,
        entryCount: outboxUpsert.outbox.entries.length,
        writeSucceeded: outboxWriteMeta.writeSucceeded,
        writeError: outboxWriteMeta.writeError
      },
      targets: targetResults
    },
    notifiableEvents
  };
}

function normalizeDiagnosticTargets(diagnostic: PublicListenerDiagnosticInput) {
  if (isMultiDiagnostic(diagnostic)) {
    return diagnostic.results.map((result) => ({
      targetId: result.targetId,
      targetName: result.targetName,
      streamUrl: result.target.streamUrl,
      result: result.result,
      checkedAt: result.timing.checkedAt
    }));
  }

  const streamUrl = diagnostic.target.streamUrl.trim();

  return [
    {
      targetId: streamUrl ? `single:${streamUrl}` : "single:default",
      targetName: diagnostic.target.host || streamUrl || "Default stream",
      streamUrl,
      result: diagnostic.result,
      checkedAt: diagnostic.timing.checkedAt
    }
  ];
}

function evaluateTarget(previousState: IncidentTargetState, input: ReturnType<typeof normalizeDiagnosticTargets>[number], now: string) {
  const policy = classifyIncidentPolicy(input.result);
  const currentIncident = previousState.currentIncident;
  const nextStateBase: IncidentTargetState = {
    ...previousState,
    targetId: input.targetId,
    targetName: input.targetName,
    streamUrl: input.streamUrl,
    lastCheck: {
      status: input.result.status,
      reason: input.result.reason,
      severity: input.result.severity,
      checkedAt: input.checkedAt
    }
  };
  const events: NotifiableIncidentEvent[] = [];

  if (input.result.status === "healthy") {
    const consecutiveSuccesses = previousState.streak.consecutiveSuccesses + 1;
    const nextStreak = {
      consecutiveFailures: 0,
      consecutiveSuccesses,
      highestFailureSeverity: null,
      firstFailureAt: null,
      lastFailureAt: null,
      lastHealthyAt: input.checkedAt
    } satisfies IncidentTargetState["streak"];

    if (currentIncident.state === "open" && currentIncident.incidentId && consecutiveSuccesses >= policy.resolveAfterConsecutiveSuccesses) {
      const event = buildEvent(
        "incident_resolved",
        currentIncident.incidentId,
        input.targetId,
        input.targetName,
        input.result.status,
        input.result.reason,
        input.result.severity,
        now,
        consecutiveSuccesses
      );
      events.push(event);

      const lastResolvedIncident = currentIncident.openedAt && currentIncident.openedByStatus && currentIncident.openedByReason && currentIncident.openedSeverity
        ? {
            incidentId: currentIncident.incidentId,
            openedAt: currentIncident.openedAt,
            resolvedAt: now,
            openedByStatus: currentIncident.openedByStatus,
            openedByReason: currentIncident.openedByReason,
            openedSeverity: currentIncident.openedSeverity,
            finalStatus: input.result.status,
            finalReason: input.result.reason,
            finalSeverity: input.result.severity
          }
        : previousState.lastResolvedIncident;

      const nextState: IncidentTargetState = {
        ...nextStateBase,
        streak: nextStreak,
        currentIncident: createClosedIncidentState(),
        lastResolvedIncident,
        lastEvent: event
      };

      return {
        nextState,
        events,
        result: buildEvaluationResult(nextState, input, policy.resolveAfterConsecutiveSuccesses, "resolved", now)
      };
    }

    const nextCurrentIncident: IncidentCurrentIncidentState =
      currentIncident.state === "open"
        ? {
            ...currentIncident,
            updatedAt: now,
            currentStatus: input.result.status,
            currentReason: input.result.reason,
            currentSeverity: input.result.severity
          }
        : currentIncident;

    const nextState: IncidentTargetState = {
      ...nextStateBase,
      streak: nextStreak,
      currentIncident: nextCurrentIncident,
      lastEvent: previousState.lastEvent
    };

    return {
      nextState,
      events,
      result: buildEvaluationResult(
        nextState,
        input,
        policy.resolveAfterConsecutiveSuccesses,
        currentIncident.state === "open" ? "recovering" : "none",
        null
      )
    };
  }

  const highestFailureSeverity = pickHigherSeverity(previousState.streak.highestFailureSeverity, input.result.severity);
  const consecutiveFailures = previousState.streak.consecutiveFailures + 1;
  const nextStreak = {
    consecutiveFailures,
    consecutiveSuccesses: 0,
    highestFailureSeverity,
    firstFailureAt: previousState.streak.consecutiveFailures > 0 ? previousState.streak.firstFailureAt : input.checkedAt,
    lastFailureAt: input.checkedAt,
    lastHealthyAt: previousState.streak.lastHealthyAt
  } satisfies IncidentTargetState["streak"];

  if (currentIncident.state === "open" && currentIncident.incidentId) {
    const nextState: IncidentTargetState = {
      ...nextStateBase,
      streak: nextStreak,
      currentIncident: {
        ...currentIncident,
        updatedAt: now,
        currentStatus: input.result.status,
        currentReason: input.result.reason,
        currentSeverity: input.result.severity
      },
      lastEvent: previousState.lastEvent
    };

    return {
      nextState,
      events,
      result: buildEvaluationResult(nextState, input, policy.resolveAfterConsecutiveSuccesses, "kept_open", null, policy.openAfterConsecutiveFailures)
    };
  }

  if (policy.openAfterConsecutiveFailures !== null && consecutiveFailures >= policy.openAfterConsecutiveFailures) {
    const incidentId = buildIncidentId(previousState, input);
    const event = buildEvent(
      "incident_opened",
      incidentId,
      input.targetId,
      input.targetName,
      input.result.status,
      input.result.reason,
      input.result.severity,
      now,
      consecutiveFailures
    );
    events.push(event);

    const nextState: IncidentTargetState = {
      ...nextStateBase,
      streak: nextStreak,
      currentIncident: {
        state: "open",
        incidentId,
        openedAt: now,
        updatedAt: now,
        openedByStatus: input.result.status,
        openedByReason: input.result.reason,
        openedSeverity: input.result.severity,
        currentStatus: input.result.status,
        currentReason: input.result.reason,
        currentSeverity: input.result.severity
      },
      lastEvent: event
    };

    return {
      nextState,
      events,
      result: buildEvaluationResult(nextState, input, policy.resolveAfterConsecutiveSuccesses, "opened", null, policy.openAfterConsecutiveFailures)
    };
  }

  const nextState: IncidentTargetState = {
    ...nextStateBase,
    streak: nextStreak,
    currentIncident,
    lastEvent: previousState.lastEvent
  };

  return {
    nextState,
    events,
    result: buildEvaluationResult(nextState, input, policy.resolveAfterConsecutiveSuccesses, "none", null, policy.openAfterConsecutiveFailures)
  };
}

function buildEvaluationResult(
  state: IncidentTargetState,
  input: ReturnType<typeof normalizeDiagnosticTargets>[number],
  resolveAfterConsecutiveSuccesses: number,
  transition: IncidentEvaluationTargetResult["transition"],
  resolvedAt: string | null,
  openAfterConsecutiveFailures: number | null = null
): IncidentEvaluationTargetResult {
  const policy = classifyIncidentPolicy(input.result);

  return {
    targetId: input.targetId,
    targetName: input.targetName,
    streamUrl: input.streamUrl,
    status: input.result.status,
    reason: input.result.reason,
    severity: input.result.severity,
    failureClass: policy.failureClass,
    structuralFailure: policy.structuralFailure,
    transition,
    incidentState: state.currentIncident.state,
    incidentId: state.currentIncident.incidentId,
    openedAt: state.currentIncident.openedAt,
    resolvedAt,
    consecutiveFailures: state.streak.consecutiveFailures,
    consecutiveSuccesses: state.streak.consecutiveSuccesses,
    openAfterConsecutiveFailures,
    resolveAfterConsecutiveSuccesses
  };
}

function buildIncidentId(
  previousState: IncidentTargetState,
  input: ReturnType<typeof normalizeDiagnosticTargets>[number]
): string {
  const originKey = previousState.streak.firstFailureAt
    ?? previousState.streak.lastHealthyAt
    ?? previousState.lastCheck?.checkedAt
    ?? "fresh";

  return `${input.targetId}:${originKey}`;
}

function buildSkippedStateWriteError(queuedCount: number, writeError: string | null): string {
  const prefix = `incident state nao foi salvo para evitar perder ${queuedCount} evento(s) novo(s) do outbox.`;
  return writeError ? `${prefix} Erro do outbox: ${writeError}` : prefix;
}

function buildSummary(results: IncidentEvaluationTargetResult[]): IncidentEvaluationSummary {
  return {
    targetCount: results.length,
    openIncidentCount: results.filter((result) => result.incidentState === "open").length,
    openedCount: results.filter((result) => result.transition === "opened").length,
    keptOpenCount: results.filter((result) => result.transition === "kept_open").length,
    recoveringCount: results.filter((result) => result.transition === "recovering").length,
    resolvedCount: results.filter((result) => result.transition === "resolved").length,
    noneCount: results.filter((result) => result.transition === "none").length
  };
}

function buildEvent(
  type: NotifiableIncidentEvent["type"],
  incidentId: string,
  targetId: string,
  targetName: string,
  status: PublicListenerStatus,
  reason: string,
  severity: Severity,
  occurredAt: string,
  streakCount: number
): NotifiableIncidentEvent {
  return {
    eventId: `${type}:${incidentId}:${occurredAt}`,
    incidentId,
    targetId,
    targetName,
    type,
    status,
    reason,
    severity,
    occurredAt,
    streakCount,
    dedupeKey: `${type}:${incidentId}`
  };
}

function pickHigherSeverity(current: IncidentTargetState["streak"]["highestFailureSeverity"], next: Severity) {
  if (current === "critical" || next === "critical") {
    return "critical";
  }

  if (current === "warning" || next === "warning") {
    return "warning";
  }

  return null;
}

function isMultiDiagnostic(
  diagnostic: PublicListenerDiagnosticInput
): diagnostic is PublicListenerMultiDiagnostic {
  return "mode" in diagnostic && diagnostic.mode === "multi";
}

export function buildUnhandledErrorDiagnostic(error: unknown): PublicListenerDiagnostic {
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const debugEnabled = /^true$/i.test(process.env.PUBLIC_LISTENER_DEBUG ?? "");

  return {
    checkName: "public-listener-check",
    checkVersion: "v1",
    target: {
      streamUrl: process.env.PUBLIC_LISTENER_URL ?? "",
      host: ""
    },
    result: {
      status: "unknown_error",
      reason: "cli_unhandled_error",
      severity: "critical",
      shouldOpenIncident: true,
      requiresConsecutiveFailures: false,
      message: "Erro inesperado na CLI."
    },
    metrics: {
      bytesReceived: 0,
      decodedSeconds: 0,
      sampleDurationSeconds: 0,
      silenceDetectedSeconds: 0,
      ffprobeExitCode: null,
      ffmpegExitCode: null
    },
    evidence: {
      contentType: null,
      tlsError: null,
      ffprobeSummary: null,
      ffmpegSummary: null,
      stderrSnippet: debugEnabled ? message : null,
      stdoutSnippet: null
    },
    timing: {
      startedAt: now,
      finishedAt: now,
      executionDurationMs: 0,
      checkedAt: now
    },
    debug: {
      enabled: debugEnabled
    }
  };
}
