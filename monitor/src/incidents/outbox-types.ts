import type { PublicListenerStatus, Severity } from "../checks/public-listener-check/types.js";

export const INCIDENT_OUTBOX_SCHEMA_VERSION = 1;

export type IncidentOutboxEntryStatus = "pending" | "sent" | "failed" | "discarded";
export type IncidentOutboxLoadSource = "primary" | "backup" | "fresh";

export interface IncidentOutboxEntry {
  dedupeKey: string;
  eventId: string;
  incidentId: string;
  targetId: string;
  targetName: string;
  type: "incident_opened" | "incident_resolved";
  status: IncidentOutboxEntryStatus;
  reason: string;
  severity: Severity;
  occurredAt: string;
  streakCount: number;
  queuedAt: string;
  updatedAt: string;
  lastSeenAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  sentAt: string | null;
  discardedAt: string | null;
  lastError: string | null;
}

export interface IncidentOutboxSnapshot {
  schemaVersion: number;
  updatedAt: string;
  entries: IncidentOutboxEntry[];
}

export interface IncidentOutboxStoreMeta {
  path: string;
  loadSource: IncidentOutboxLoadSource;
  recoveredFromCorruption: boolean;
  loadError: string | null;
  queuedCount: number;
  duplicateCount: number;
  entryCount: number;
  writeSucceeded: boolean;
  writeError: string | null;
}

export interface IncidentOutboxUpsertResult {
  outbox: IncidentOutboxSnapshot;
  queuedCount: number;
  duplicateCount: number;
}

export interface NotifiableEventOutboxPayload {
  eventId: string;
  incidentId: string;
  targetId: string;
  targetName: string;
  type: "incident_opened" | "incident_resolved";
  status: PublicListenerStatus;
  reason: string;
  severity: Severity;
  occurredAt: string;
  streakCount: number;
  dedupeKey: string;
}