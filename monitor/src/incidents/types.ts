import type {
  PublicListenerDiagnostic,
  PublicListenerMultiDiagnostic,
  PublicListenerResult,
  PublicListenerStatus,
  Severity
} from "../checks/public-listener-check/types.js";

export const INCIDENT_STATE_SCHEMA_VERSION = 1;

export type IncidentTransition = "none" | "opened" | "kept_open" | "recovering" | "resolved";
export type IncidentLifecycleState = "open" | "closed";
export type IncidentFailureClass = "healthy" | "structural" | "critical" | "quality";
export type IncidentStateLoadSource = "primary" | "backup" | "fresh";

export interface IncidentPolicySnapshot {
  structuralOpenThreshold: number;
  criticalOpenThreshold: number;
  qualityOpenThreshold: number;
  resolveAfterConsecutiveSuccesses: number;
  structuralReasons: string[];
  qualityStatuses: PublicListenerStatus[];
}

export interface IncidentLastCheck {
  status: PublicListenerStatus;
  reason: string;
  severity: Severity;
  checkedAt: string;
}

export interface IncidentStreak {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  highestFailureSeverity: Exclude<Severity, "none"> | null;
  firstFailureAt: string | null;
  lastFailureAt: string | null;
  lastHealthyAt: string | null;
}

export interface IncidentCurrentIncidentState {
  state: IncidentLifecycleState;
  incidentId: string | null;
  openedAt: string | null;
  updatedAt: string | null;
  openedByStatus: PublicListenerStatus | null;
  openedByReason: string | null;
  openedSeverity: Severity | null;
  currentStatus: PublicListenerStatus | null;
  currentReason: string | null;
  currentSeverity: Severity | null;
}

export interface IncidentResolvedIncidentRecord {
  incidentId: string;
  openedAt: string;
  resolvedAt: string;
  openedByStatus: PublicListenerStatus;
  openedByReason: string;
  openedSeverity: Severity;
  finalStatus: PublicListenerStatus;
  finalReason: string;
  finalSeverity: Severity;
}

export type NotifiableIncidentEventType = "incident_opened" | "incident_resolved";

export interface NotifiableIncidentEvent {
  eventId: string;
  incidentId: string;
  targetId: string;
  targetName: string;
  type: NotifiableIncidentEventType;
  status: PublicListenerStatus;
  reason: string;
  severity: Severity;
  occurredAt: string;
  streakCount: number;
  dedupeKey: string;
}

export interface IncidentTargetState {
  targetId: string;
  targetName: string;
  streamUrl: string;
  lastCheck: IncidentLastCheck | null;
  streak: IncidentStreak;
  currentIncident: IncidentCurrentIncidentState;
  lastResolvedIncident: IncidentResolvedIncidentRecord | null;
  lastEvent: NotifiableIncidentEvent | null;
}

export interface IncidentStateSnapshot {
  schemaVersion: number;
  updatedAt: string;
  checkName: string;
  checkVersion: string;
  policySnapshot: IncidentPolicySnapshot;
  targets: Record<string, IncidentTargetState>;
}

export interface IncidentStateStoreMeta {
  path: string;
  loadSource: IncidentStateLoadSource;
  recoveredFromCorruption: boolean;
  loadError: string | null;
  writeSucceeded: boolean;
  writeError: string | null;
}

export interface IncidentEvaluationTargetResult {
  targetId: string;
  targetName: string;
  streamUrl: string;
  status: PublicListenerStatus;
  reason: string;
  severity: Severity;
  failureClass: IncidentFailureClass;
  structuralFailure: boolean;
  transition: IncidentTransition;
  incidentState: IncidentLifecycleState;
  incidentId: string | null;
  openedAt: string | null;
  resolvedAt: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openAfterConsecutiveFailures: number | null;
  resolveAfterConsecutiveSuccesses: number;
}

export interface IncidentEvaluationSummary {
  targetCount: number;
  openIncidentCount: number;
  openedCount: number;
  keptOpenCount: number;
  recoveringCount: number;
  resolvedCount: number;
  noneCount: number;
}

export interface PublicListenerIncidentEvaluation {
  schemaVersion: number;
  evaluatedAt: string;
  checkName: string;
  checkVersion: string;
  policySnapshot: IncidentPolicySnapshot;
  summary: IncidentEvaluationSummary;
  stateStore: IncidentStateStoreMeta;
  targets: IncidentEvaluationTargetResult[];
}

export interface EvaluatePublicListenerIncidentsResult {
  incidentEvaluation: PublicListenerIncidentEvaluation;
  notifiableEvents: NotifiableIncidentEvent[];
}

export interface IncidentEvaluationInputTarget {
  targetId: string;
  targetName: string;
  streamUrl: string;
  result: PublicListenerResult;
  checkedAt: string;
}

export type PublicListenerDiagnosticInput = PublicListenerDiagnostic | PublicListenerMultiDiagnostic;
