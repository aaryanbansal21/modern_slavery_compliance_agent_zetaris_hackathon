// Meterless World Model engine, implemented for this project from the spec at
// github.com/meterless/meterless/engines/world-model/AGENTS.md (Apache 2.0).
//
// Event-sourced and deterministic: state is a fold over an append-only log,
// views are projections of the fold, every mutation writes an audit entry,
// and record timestamps come from provenance (never the wall clock), which is
// what makes ingest and replay idempotent.
//
// In this app the World Model is the shared state between agents: suppliers,
// manufacturers, purchase lines, countries, goods, declarations, findings,
// evidence and answers all live here, each with provenance back to the
// Zetaris query that produced it.

import { EventStore, SCHEMA_VERSION } from "./store.ts";
import {
  canonicalJson, contextIdFromAttrs, entityIdFromName, externalId, factId, normalizeName, relationshipId, sha256Hex,
} from "./stableIds.ts";
import { decide, nameSimilarity } from "./resolve.ts";
import type {
  AuditEntry, Context, Entity, Fact, IngestObservation, IngestReport, MergeProposal, ObservationRecord,
  Provenance, Relationship, StoredProvenance, WorldEvent, WorldModelOptions,
} from "./types.ts";

export * from "./types.ts";
export { canonicalJson, entityIdFromName, externalId, normalizeName, sha256Hex } from "./stableIds.ts";
export { decide, jaccard, levenshtein, nameSimilarity } from "./resolve.ts";

type ExternalKey = { system: string; id: string };

export interface UpsertEntityInput {
  type: string;
  externalKey?: ExternalKey;
  name?: string;
  attrs?: Record<string, unknown>;
  aliases?: string[];
  source: Provenance;
  state?: Entity["state"];
  /** Optional comparison key for resolution, e.g. a company name with legal suffixes removed. */
  matchKey?: string;
}

export interface UpsertContextInput {
  type: string;
  externalKey?: ExternalKey;
  attrs?: Record<string, unknown>;
  parent?: string;
  source: Provenance;
}

export interface RelateInput {
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs?: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
  source: Provenance;
}

export interface AssertFactInput {
  about: string;
  predicate: string;
  value: unknown;
  confidence?: number;
  context?: string;
  source: Provenance;
}

export interface UpsertResult {
  entity: Entity;
  decision: "existing" | "new" | "auto-merge" | "review";
  similarity?: number;
  matchedId?: string;
}

export class WorldModel {
  private store: EventStore;
  private opts: WorldModelOptions;
  private clock: () => Date;
  private writeLock: Promise<unknown> = Promise.resolve();
  private multiValued: Set<string>;
  /** Last resolution outcome per upsert call, readable by callers that need it. */
  lastResolution: UpsertResult | undefined;

  constructor(opts: WorldModelOptions) {
    if (!opts?.namespace) throw new Error("WorldModel: namespace is required");
    this.opts = opts;
    this.clock = opts.clock ?? (() => new Date());
    this.multiValued = new Set(opts.multiValued ?? ["mentions"]);
    this.store = new EventStore(opts.namespace, opts.storage ?? "memory", opts.directory);
  }

  get namespace(): string {
    return this.opts.namespace;
  }

  // ------------------------------------------------------------------ writes

  /** Single-writer FIFO: concurrent writers serialize, so no lost updates. */
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.writeLock.then(fn);
    this.writeLock = next.catch(() => undefined);
    return next;
  }

  private provenance(source: Provenance | undefined): StoredProvenance {
    if (!source || !source.kind || source.at === undefined || source.at === null || source.at === "") {
      throw new Error("World Model: every write carries provenance (kind + at). No provenance, no write.");
    }
    const at = source.at instanceof Date ? source.at.toISOString() : String(source.at);
    if (Number.isNaN(Date.parse(at))) throw new Error(`World Model: provenance.at is not a timestamp: ${at}`);
    return { ...source, at: new Date(at).toISOString() };
  }

  upsertEntity(input: UpsertEntityInput): Promise<Entity> {
    return this.enqueue(() => this.upsertEntitySync(input).entity);
  }

  /** Same as upsertEntity but also reports the resolution decision. */
  upsertEntityResolved(input: UpsertEntityInput): Promise<UpsertResult> {
    return this.enqueue(() => this.upsertEntitySync(input));
  }

  private upsertEntitySync(input: UpsertEntityInput): UpsertResult {
    const source = this.provenance(input.source);
    const name = input.name ?? (input.attrs?.name as string | undefined);
    if (!input.externalKey && !name) {
      throw new Error("World Model: name-keyed entities need a name (or provide an externalKey)");
    }
    const id = input.externalKey
      ? externalId(input.type, input.externalKey.system, input.externalKey.id)
      : entityIdFromName(input.type, input.matchKey ?? name!);

    let result: UpsertResult | undefined;
    const known = this.store.state.entities.has(this.store.resolveAlias(id));

    // Resolution pass for new name-keyed entities: near-duplicates of the
    // same type auto-merge (alias event) or queue for operator review.
    if (!input.externalKey && name && !known) {
      const key = input.matchKey ?? name;
      let best: { other: Entity; similarity: number } | undefined;
      for (const other of this.store.state.entities.values()) {
        if (other.type !== input.type || other.id === id || !other.name) continue;
        const otherKey = (other.attrs.matchKey as string | undefined) ?? other.name;
        const similarity = nameSimilarity(key, otherKey);
        if (!best || similarity > best.similarity) best = { other, similarity };
      }
      if (best) {
        const decision = decide(best.similarity, this.opts.resolver?.autoMergeAt ?? 0.85, this.opts.resolver?.reviewAt ?? 0.82);
        if (decision === "auto-merge") {
          this.store.append("alias", { aliasId: id, primaryId: best.other.id, mergedAt: source.at, mergedBy: "resolver", reason: `similarity ${best.similarity.toFixed(3)}` }, source.at);
          this.store.logAudit("auto-merge", "resolver", `${name} -> ${best.other.name} (${best.similarity.toFixed(3)})`, source.at, undefined, source.runId);
          result = { entity: this.foldEntity(best.other.id, input, source, name), decision: "auto-merge", similarity: best.similarity, matchedId: best.other.id };
        } else if (decision === "review") {
          const dup = this.store.mergeQueue.some(
            (p) => p.status === "pending" && ((p.leftId === id && p.rightId === best!.other.id) || (p.leftId === best!.other.id && p.rightId === id)),
          );
          if (!dup) {
            const proposal: MergeProposal = {
              id: `merge_${sha256Hex(`${id}|${best.other.id}`).slice(0, 8)}`,
              leftId: id, rightId: best.other.id, leftName: name, rightName: best.other.name ?? best.other.id,
              similarity: best.similarity, reason: "name similarity in review band [0.82, 0.85)",
              status: "pending", proposedAt: source.at,
            };
            this.store.mergeQueue.push(proposal);
            this.store.logAudit("merge-proposed", "resolver", `${name} ~ ${best.other.name} (${best.similarity.toFixed(3)}) queued for review`, source.at, undefined, source.runId);
          }
          result = { entity: this.foldEntity(id, input, source, name), decision: "review", similarity: best.similarity, matchedId: best.other.id };
        }
      }
    }
    if (!result) {
      result = { entity: this.foldEntity(id, input, source, name), decision: known ? "existing" : "new" };
    }
    this.store.persist();
    this.lastResolution = result;
    return result;
  }

  private foldEntity(id: string, input: UpsertEntityInput, source: StoredProvenance, name?: string): Entity {
    const resolved = this.store.resolveAlias(id);
    const attrs: Record<string, unknown> = { ...(input.attrs ?? {}) };
    // Keep the primary's comparison key when merging into another entity.
    if (input.matchKey && resolved === id) attrs.matchKey = input.matchKey;

    // Re-asserting an unchanged record is a no-op: no event, no audit entry.
    const current = this.store.state.entities.get(resolved);
    if (current) {
      const sameAttrs = Object.entries(attrs).every(([k, v]) => canonicalJson(current.attrs[k]) === canonicalJson(v));
      const namesKnown = [name, ...(input.aliases ?? [])].every((n) => !n || current.aliases.includes(n));
      const sameState = (input.state ?? "active") === current.state;
      if (sameAttrs && namesKnown && sameState) return current;
    }
    const entity: Entity = {
      id: resolved,
      type: input.type,
      name,
      aliases: [...new Set([...(name ? [name] : []), ...(input.aliases ?? [])])].sort(),
      attrs,
      state: input.state ?? "active",
      schemaVersion: SCHEMA_VERSION,
      source,
      createdAt: source.at,
      updatedAt: source.at,
    };
    const event = this.store.append("upsertEntity", entity, source.at);
    this.store.logAudit("upsertEntity", source.by ?? source.kind, `${resolved} (${input.type})`, source.at, event.id, source.runId);
    return this.store.state.entities.get(resolved)!;
  }

  upsertContext(input: UpsertContextInput): Promise<Context> {
    return this.enqueue(() => {
      const source = this.provenance(input.source);
      const id = input.externalKey
        ? externalId(input.type, input.externalKey.system, input.externalKey.id)
        : contextIdFromAttrs(input.type, input.attrs ?? {}, input.parent);
      const context: Context = {
        id, type: input.type, attrs: { ...(input.attrs ?? {}) }, parent: input.parent,
        schemaVersion: SCHEMA_VERSION, source, createdAt: source.at, updatedAt: source.at,
      };
      const event = this.store.append("upsertContext", context, source.at);
      this.store.logAudit("upsertContext", source.by ?? source.kind, `${id} (${input.type})`, source.at, event.id, source.runId);
      this.store.persist();
      return this.store.state.contexts.get(id)!;
    });
  }

  /**
   * Add a bitemporal edge. Re-adding the same edge is a no-op (content
   * addressed). For functional relationship types, a new open edge with the
   * same (from, type, context) and a different target closes the previous
   * open edge (validTo + supersededBy). Nothing is deleted.
   */
  relate(input: RelateInput): Promise<Relationship> {
    return this.enqueue(() => {
      const source = this.provenance(input.source);
      const from = this.store.resolveAlias(input.from);
      const to = this.store.resolveAlias(input.to);
      const validFrom = input.validFrom ? new Date(input.validFrom).toISOString() : source.at;
      const id = relationshipId(from, input.type, to, input.context, validFrom);
      const existing = this.store.state.relationships.get(id);
      if (existing) return existing;

      // An identical open edge (same endpoints and type) already exists: no-op.
      for (const rel of this.store.state.relationships.values()) {
        if (!rel.validTo && rel.type === input.type && rel.context === input.context
          && this.store.resolveAlias(rel.from) === from && this.store.resolveAlias(rel.to) === to) {
          return rel;
        }
      }

      if (!this.multiValued.has(input.type)) {
        for (const rel of this.store.state.relationships.values()) {
          if (rel.validTo || rel.type !== input.type || rel.context !== input.context) continue;
          if (this.store.resolveAlias(rel.from) !== from || this.store.resolveAlias(rel.to) === to) continue;
          if (rel.validFrom > validFrom) continue; // a later edge is not superseded by an earlier one
          this.store.append("closeEdge", { id: rel.id, validTo: validFrom, supersededBy: id }, source.at);
          this.store.logAudit("closeEdge", source.by ?? source.kind, `${rel.from} -[${rel.type}]-> ${rel.to} closed at ${validFrom}`, source.at, undefined, source.runId);
        }
      }

      const rel: Relationship = {
        id, from, type: input.type, to, context: input.context, attrs: input.attrs,
        validFrom, validTo: input.validTo, schemaVersion: SCHEMA_VERSION, source, createdAt: source.at,
      };
      const event = this.store.append("relate", rel, source.at);
      this.store.logAudit("relate", source.by ?? source.kind, `${from} -[${input.type}]-> ${to}`, source.at, event.id, source.runId);
      this.store.persist();
      return this.store.state.relationships.get(id)!;
    });
  }

  /** Assert a fact with provenance. The conflict policy picks the winning value. */
  assertFact(input: AssertFactInput): Promise<Fact> {
    return this.enqueue(() => {
      const source = this.provenance(input.source);
      const about = this.store.resolveAlias(input.about);
      const id = factId(about, input.predicate, input.value, source.at, source.kind, source.url ?? source.ref);
      const existing = this.store.state.facts.get(id);
      if (existing) return existing;

      const fact: Fact = {
        id, about, predicate: input.predicate, value: input.value,
        confidence: input.confidence ?? 0.5, context: input.context, source, assertedAt: source.at,
      };
      const policy = this.opts.conflictPolicy ?? "most-recent-wins";
      const rivals = [...this.store.state.facts.values()].filter(
        (f) => this.store.resolveAlias(f.about) === about && f.predicate === input.predicate && !f.supersededBy,
      );
      let winner: Fact = fact;
      for (const rival of rivals) {
        const rivalWins =
          policy === "highest-confidence-wins" ? rival.confidence > winner.confidence
          : policy === "source-priority" ? priority(rival.source.kind, this.opts.sourcePriority) < priority(winner.source.kind, this.opts.sourcePriority)
          : rival.assertedAt > winner.assertedAt;
        if (rivalWins) winner = rival;
      }
      const losers = [fact, ...rivals].filter((f) => f.id !== winner.id).map((f) => f.id);
      const event = this.store.append("assertFact", { fact, winnerId: winner.id, losers }, source.at);
      this.store.logAudit("assertFact", source.by ?? source.kind, `${about}.${input.predicate} = ${short(winner.value)} (${policy})`, source.at, event.id, source.runId);
      this.store.persist();
      return this.store.state.facts.get(id)!;
    });
  }

  // ------------------------------------------------------------------ ingest

  /**
   * Idempotent observation ingest (spec section 4). The same batch twice
   * produces an empty diff; an edited observation changes the state.
   */
  ingest(observations: IngestObservation[]): Promise<IngestReport> {
    return this.enqueue(() => {
      const timings: { step: string; ms: number }[] = [];
      const time = <T>(step: string, fn: () => T): T => {
        const t0 = performance.now();
        const out = fn();
        timings.push({ step, ms: Math.round((performance.now() - t0) * 1000) / 1000 });
        return out;
      };
      const runId = `ingest_${sha256Hex(canonicalJson(observations.map((o) => o.externalId))).slice(0, 12)}`;
      const before = this.stateShapeCanonicalSync();
      const eventsBefore = this.store.events.length;

      const fresh: { obs: IngestObservation; checksum: string }[] = [];
      let skipped = 0;
      time("classify-changed", () => {
        for (const obs of observations) {
          const checksum = sha256Hex(canonicalJson({ externalId: obs.externalId, title: obs.title, text: obs.text ?? "", at: obs.at, entities: obs.entities ?? [] }));
          const prior = this.store.state.observations.get(obs.externalId);
          if (prior && prior.checksum === checksum) skipped++;
          else fresh.push({ obs, checksum });
        }
      });

      time("persist-observations", () => {
        for (const { obs, checksum } of fresh) {
          const source = this.provenance({ ...obs.source, at: obs.at, runId });
          const type = obs.type ?? "item";
          const item = this.foldEntity(externalId(type, "ingest", obs.externalId), {
            type, externalKey: { system: "ingest", id: obs.externalId },
            attrs: { title: obs.title, ...(obs.text ? { text: obs.text } : {}) }, source,
          }, source, obs.title);
          const entityIds: string[] = [];
          for (const mention of obs.entities ?? []) {
            const mid = this.store.resolveAlias(entityIdFromName(mention.type, mention.name));
            this.foldEntity(mid, { type: mention.type, name: mention.name, source }, source, mention.name);
            entityIds.push(mid);
            const rid = relationshipId(item.id, "mentions", mid, undefined, source.at);
            if (!this.store.state.relationships.has(rid)) {
              this.store.append("relate", {
                id: rid, from: item.id, type: "mentions", to: mid, validFrom: source.at,
                schemaVersion: SCHEMA_VERSION, source, createdAt: source.at,
              } satisfies Relationship, source.at);
            }
          }
          const record: ObservationRecord = { externalId: obs.externalId, entityId: item.id, checksum, at: source.at, entityIds: [...new Set(entityIds)].sort() };
          this.store.append("observation", record, source.at);
        }
      });

      time("rebuild-aggregates", () => {
        const byEntity = new Map<string, string[]>();
        for (const rec of this.store.state.observations.values()) {
          for (const eid of rec.entityIds) {
            const list = byEntity.get(eid) ?? [];
            list.push(rec.at);
            byEntity.set(eid, list);
          }
        }
        for (const [eid, times] of byEntity) {
          const entity = this.store.state.entities.get(this.store.resolveAlias(eid));
          if (!entity) continue;
          times.sort();
          entity.aggregates = { mentionCount: times.length, firstSeenAt: times[0], lastSeenAt: times[times.length - 1] };
        }
      });

      this.store.persist();
      const changed = before !== this.stateShapeCanonicalSync();
      const report: IngestReport = {
        runId, processed: fresh.length, skippedUnchanged: skipped,
        eventsAppended: this.store.events.length - eventsBefore, changed, stepTimingsMs: timings,
      };
      const at = observations[0]?.at ? new Date(observations[0].at).toISOString() : this.clock().toISOString();
      this.store.logAudit("ingest", "pipeline", `run ${runId}: ${fresh.length} processed, ${skipped} unchanged`, at, undefined, runId);
      return report;
    });
  }

  // ------------------------------------------------------------------ reads

  view(name: "graph"): GraphView;
  view(name: "facts"): FactsView;
  view(name: "snapshot"): SnapshotView;
  view(name: "timeline"): TimelineView;
  view(name: string): GraphView | FactsView | SnapshotView | TimelineView;
  view(name: string): GraphView | FactsView | SnapshotView | TimelineView {
    switch (name) {
      case "graph": return new GraphView(this.store);
      case "facts": return new FactsView(this.store);
      case "snapshot": return new SnapshotView(this.store);
      case "timeline": return new TimelineView(this.store);
      default: throw new Error(`World Model: unknown view "${name}"`);
    }
  }

  entity(id: string): Entity | undefined {
    return this.store.state.entities.get(this.store.resolveAlias(id));
  }

  resolveId(id: string): string {
    return this.store.resolveAlias(id);
  }

  /** Current winning value of a predicate on an entity, with its fact. */
  currentFact(about: string, predicate: string): Fact | undefined {
    const id = this.store.resolveAlias(about);
    return [...this.store.state.facts.values()].find(
      (f) => this.store.resolveAlias(f.about) === id && f.predicate === predicate && !f.supersededBy,
    );
  }

  // --------------------------------------------------------------- operator

  mergeQueue(): readonly MergeProposal[] {
    return this.store.mergeQueue;
  }

  approveMerge(proposalId: string, by: string): Promise<void> {
    return this.enqueue(() => {
      const p = this.store.mergeQueue.find((m) => m.id === proposalId && m.status === "pending");
      if (!p) throw new Error(`World Model: no pending merge proposal ${proposalId}`);
      const at = this.clock().toISOString();
      p.status = "approved";
      p.resolvedAt = at;
      p.resolvedBy = by;
      this.store.append("alias", { aliasId: p.leftId, primaryId: p.rightId, mergedAt: at, mergedBy: by, reason: p.reason }, at);
      this.store.logAudit("merge-approved", by, `${p.leftName} -> ${p.rightName}`, at);
      this.store.persist();
    });
  }

  rejectMerge(proposalId: string, by: string): Promise<void> {
    return this.enqueue(() => {
      const p = this.store.mergeQueue.find((m) => m.id === proposalId && m.status === "pending");
      if (!p) throw new Error(`World Model: no pending merge proposal ${proposalId}`);
      const at = this.clock().toISOString();
      p.status = "rejected";
      p.resolvedAt = at;
      p.resolvedBy = by;
      this.store.logAudit("merge-rejected", by, `${p.leftName} stays separate from ${p.rightName}`, at);
      this.store.persist();
    });
  }

  /** Rebuild all derived state from the log. Returns elapsed ms. */
  rebuild(): number {
    return this.store.rebuild();
  }

  /** Replay the log into a fresh fold and confirm it matches current state. */
  verifyReplay(): { ok: boolean; events: number } {
    const replayed = EventStore.fold(this.store.events);
    const current = canonicalJson(shapeOf(this.store.state, this.store));
    const fromLog = canonicalJson(shapeOf(replayed, this.store));
    return { ok: current === fromLog, events: this.store.events.length };
  }

  audit(): readonly AuditEntry[] {
    return this.store.audit;
  }

  events(): readonly WorldEvent[] {
    return this.store.events;
  }

  stats(): Record<string, number> {
    const s = this.store.state;
    const byType: Record<string, number> = {};
    for (const e of s.entities.values()) byType[`entities.${e.type}`] = (byType[`entities.${e.type}`] ?? 0) + 1;
    return {
      schemaVersion: SCHEMA_VERSION,
      events: this.store.events.length,
      entities: s.entities.size,
      relationships: s.relationships.size,
      openRelationships: [...s.relationships.values()].filter((r) => !r.validTo).length,
      facts: s.facts.size,
      aliases: s.aliases.size,
      pendingMerges: this.store.mergeQueue.filter((m) => m.status === "pending").length,
      ...byType,
    };
  }

  stateShape(): unknown {
    return shapeOf(this.store.state, this.store);
  }

  stateShapeCanonical(): string {
    return this.stateShapeCanonicalSync();
  }

  private stateShapeCanonicalSync(): string {
    return canonicalJson(shapeOf(this.store.state, this.store));
  }

  subscribeEvents(fn: (e: WorldEvent) => void): () => void {
    return this.store.subscribe(fn);
  }

  /** Wait for queued writes to finish. */
  async flush(): Promise<void> {
    await this.writeLock;
  }
}

function shapeOf(state: EventStore["state"], _store: EventStore): unknown {
  const sortById = <T extends { id: string }>(xs: Iterable<T>) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  return {
    entities: sortById(state.entities.values()),
    contexts: sortById(state.contexts.values()),
    relationships: sortById(state.relationships.values()),
    facts: sortById(state.facts.values()),
    observations: [...state.observations.values()].sort((a, b) => a.externalId.localeCompare(b.externalId)),
  };
}

// ------------------------------------------------------------------- views

function validAt(rel: Relationship, at: string): boolean {
  if (rel.validFrom && at < rel.validFrom) return false;
  if (rel.validTo && at >= rel.validTo) return false;
  return true;
}

export class GraphView {
  constructor(private store: EventStore) {}

  private ends(rel: Relationship): [string, string] {
    return [this.store.resolveAlias(rel.from), this.store.resolveAlias(rel.to)];
  }

  entity(id: string): Entity | undefined {
    return this.store.state.entities.get(this.store.resolveAlias(id));
  }

  /** Neighbours over open edges, or edges valid at a point in time when `at` is given. */
  neighborsOf(id: string, opts?: { via?: string; inContext?: string; at?: string; direction?: "out" | "in" | "both" }): Entity[] {
    const rid = this.store.resolveAlias(id);
    const at = opts?.at ? new Date(opts.at).toISOString() : undefined;
    const dir = opts?.direction ?? "both";
    const seen = new Map<string, Entity>();
    for (const rel of this.store.state.relationships.values()) {
      if (opts?.via && rel.type !== opts.via) continue;
      if (opts?.inContext && rel.context !== opts.inContext) continue;
      if (at ? !validAt(rel, at) : rel.validTo) continue;
      const [from, to] = this.ends(rel);
      const other = from === rid && dir !== "in" ? to : to === rid && dir !== "out" ? from : undefined;
      if (!other) continue;
      const entity = this.store.state.entities.get(other);
      if (entity) seen.set(entity.id, entity);
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Open edges touching an entity, with the edge records (for evidence panels). */
  edgesOf(id: string, opts?: { via?: string; includeClosed?: boolean }): Relationship[] {
    const rid = this.store.resolveAlias(id);
    return [...this.store.state.relationships.values()]
      .filter((r) => (!opts?.via || r.type === opts.via) && (opts?.includeClosed || !r.validTo))
      .filter((r) => {
        const [from, to] = this.ends(r);
        return from === rid || to === rid;
      })
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id));
  }

  query(opts: { type?: string; where?: (e: Entity) => boolean }): Entity[] {
    return [...this.store.state.entities.values()]
      .filter((e) => (!opts.type || e.type === opts.type) && (!opts.where || opts.where(e)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

export class FactsView {
  constructor(private store: EventStore) {}

  /** Every fact about an entity, oldest first, including superseded ones. */
  about(id: string, predicate?: string): Fact[] {
    const rid = this.store.resolveAlias(id);
    return [...this.store.state.facts.values()]
      .filter((f) => this.store.resolveAlias(f.about) === rid && (!predicate || f.predicate === predicate))
      .sort((a, b) => a.assertedAt.localeCompare(b.assertedAt) || a.id.localeCompare(b.id));
  }

  get(id: string): Fact | undefined {
    return this.store.state.facts.get(id);
  }

  all(): Fact[] {
    return [...this.store.state.facts.values()];
  }
}

export class SnapshotView {
  constructor(private store: EventStore) {}

  /** Entity state as of a timestamp: replay events with at <= timestamp. */
  entityAt(id: string, at: string): Entity | undefined {
    const iso = at.length === 10 ? `${at}T23:59:59.999Z` : new Date(at).toISOString();
    const state = this.store.foldUntil(iso);
    return state.entities.get(this.store.resolveAlias(id, state.aliases));
  }
}

export class TimelineView {
  constructor(private store: EventStore) {}

  get(): WorldEvent[] {
    return [...this.store.events];
  }

  subscribe(fn: (e: WorldEvent) => void): () => void {
    return this.store.subscribe(fn);
  }
}

function priority(kind: string, ranking?: string[]): number {
  const idx = (ranking ?? []).indexOf(kind);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function short(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
