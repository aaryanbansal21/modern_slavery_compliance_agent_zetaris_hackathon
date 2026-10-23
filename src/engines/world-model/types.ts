// World Model record shapes. Implemented from the Meterless World Model spec
// (engines/world-model/AGENTS.md): identity, semantics, provenance and
// lifecycle on entities; first-class bitemporal relationships; facts with a
// conflict policy; an append-only event log with an ordered audit trail.

export interface Provenance {
  kind: string; // e.g. "zetaris", "declaration", "agent", "analyst", "manual"
  at: string | Date; // observation time, never wall clock, so replay is idempotent
  by?: string;
  url?: string;
  runId?: string;
  ref?: string; // query id, row id, document id
  note?: string;
}

export interface StoredProvenance extends Provenance {
  at: string;
}

export type Lifecycle = "emerging" | "active" | "archived";

export interface Entity {
  id: string;
  type: string;
  name?: string;
  aliases: string[];
  attrs: Record<string, unknown>;
  state: Lifecycle;
  schemaVersion: number;
  source: StoredProvenance;
  createdAt: string;
  updatedAt: string;
  aggregates?: { mentionCount: number; firstSeenAt: string; lastSeenAt: string };
}

export interface Context {
  id: string;
  type: string;
  attrs: Record<string, unknown>;
  parent?: string;
  schemaVersion: number;
  source: StoredProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface Relationship {
  id: string;
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs?: Record<string, unknown>;
  validFrom: string;
  validTo?: string;
  supersededBy?: string;
  schemaVersion: number;
  source: StoredProvenance;
  createdAt: string;
}

export interface Fact {
  id: string;
  about: string;
  predicate: string;
  value: unknown;
  confidence: number;
  context?: string;
  source: StoredProvenance;
  assertedAt: string;
  supersededBy?: string;
}

export type EventKind =
  | "upsertEntity"
  | "upsertContext"
  | "relate"
  | "closeEdge"
  | "assertFact"
  | "alias"
  | "observation";

export interface WorldEvent {
  seq: number;
  id: string;
  kind: EventKind;
  at: string;
  payload: unknown;
}

export interface AuditEntry {
  seq: number;
  at: string;
  action: string;
  actor: string;
  detail: string;
  eventId?: string;
  runId?: string;
}

export interface MergeProposal {
  id: string;
  leftId: string;
  rightId: string;
  leftName: string;
  rightName: string;
  similarity: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  proposedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface IngestObservation {
  externalId: string;
  title: string;
  text?: string;
  at: string;
  type?: string;
  source: { kind: string; at?: string; url?: string; by?: string };
  entities?: { type: string; name: string }[];
}

export interface ObservationRecord {
  externalId: string;
  entityId: string;
  checksum: string;
  at: string;
  entityIds: string[];
}

export interface IngestReport {
  runId: string;
  processed: number;
  skippedUnchanged: number;
  eventsAppended: number;
  changed: boolean;
  stepTimingsMs: { step: string; ms: number }[];
}

export type ConflictPolicy = "most-recent-wins" | "highest-confidence-wins" | "source-priority";

export interface WorldModelOptions {
  namespace: string;
  storage?: "memory" | "file";
  directory?: string;
  clock?: () => Date;
  conflictPolicy?: ConflictPolicy;
  /** Lower index = higher priority, used by the "source-priority" policy. */
  sourcePriority?: string[];
  resolver?: { autoMergeAt?: number; reviewAt?: number };
  /**
   * Relationship types that may hold several open edges from the same node at
   * once (a supplier supplies many lines). Every other type is functional: a
   * new open edge with the same (from, type, context) and a different target
   * closes the previous one, which is what makes point-in-time queries work.
   */
  multiValued?: string[];
}
