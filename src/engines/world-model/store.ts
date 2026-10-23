// Append-only event store. The event log is the single source of truth; the
// in-memory state is a fold over it and can be rebuilt at any time. Every
// mutation also writes an audit entry with a strictly increasing sequence.
import fs from "node:fs";
import path from "node:path";
import type {
  AuditEntry, Context, Entity, EventKind, Fact, MergeProposal, ObservationRecord, Relationship, WorldEvent,
} from "./types.ts";

export const SCHEMA_VERSION = 1;

export interface WorldState {
  entities: Map<string, Entity>;
  contexts: Map<string, Context>;
  relationships: Map<string, Relationship>;
  facts: Map<string, Fact>;
  aliases: Map<string, string>;
  observations: Map<string, ObservationRecord>;
}

const emptyState = (): WorldState => ({
  entities: new Map(),
  contexts: new Map(),
  relationships: new Map(),
  facts: new Map(),
  aliases: new Map(),
  observations: new Map(),
});

interface PersistedWorld {
  schemaVersion: number;
  namespace: string;
  events: WorldEvent[];
  audit: AuditEntry[];
  mergeQueue: MergeProposal[];
}

export class EventStore {
  events: WorldEvent[] = [];
  audit: AuditEntry[] = [];
  mergeQueue: MergeProposal[] = [];
  state: WorldState = emptyState();
  private listeners = new Set<(e: WorldEvent) => void>();
  private file?: string;

  constructor(readonly namespace: string, storage: "memory" | "file", directory?: string) {
    if (storage === "file") {
      const dir = directory ?? path.resolve(".data", "world");
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, `${namespace.replace(/[^a-z0-9_-]/gi, "_")}.json`);
      this.load();
    }
  }

  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as PersistedWorld;
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`World Model: stored schema v${raw.schemaVersion} needs a migration to v${SCHEMA_VERSION}`);
    }
    this.events = raw.events ?? [];
    this.audit = raw.audit ?? [];
    this.mergeQueue = raw.mergeQueue ?? [];
    this.state = EventStore.fold(this.events);
  }

  persist(): void {
    if (!this.file) return;
    const body: PersistedWorld = {
      schemaVersion: SCHEMA_VERSION,
      namespace: this.namespace,
      events: this.events,
      audit: this.audit,
      mergeQueue: this.mergeQueue,
    };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, this.file);
  }

  append(kind: EventKind, payload: unknown, at: string): WorldEvent {
    const seq = (this.events.at(-1)?.seq ?? 0) + 1;
    const event: WorldEvent = { seq, id: `evt_${seq}`, kind, at, payload: structuredClone(payload) };
    this.events.push(event);
    EventStore.apply(this.state, event);
    for (const fn of this.listeners) fn(event);
    return event;
  }

  logAudit(action: string, actor: string, detail: string, at: string, eventId?: string, runId?: string): void {
    const seq = (this.audit.at(-1)?.seq ?? 0) + 1;
    this.audit.push({ seq, at, action, actor, detail, eventId, runId });
  }

  subscribe(fn: (e: WorldEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  resolveAlias(id: string, aliases: Map<string, string> = this.state.aliases): string {
    let cur = id;
    const seen = new Set<string>();
    while (aliases.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = aliases.get(cur)!;
    }
    return cur;
  }

  /** Rebuild every derived structure from the log. Bug fixes need no migration. */
  rebuild(): number {
    const t0 = performance.now();
    this.state = EventStore.fold(this.events);
    return performance.now() - t0;
  }

  /** Fold events up to and including an ISO timestamp (point-in-time view). */
  foldUntil(at: string): WorldState {
    return EventStore.fold(this.events.filter((e) => e.at <= at));
  }

  static fold(events: WorldEvent[]): WorldState {
    const state = emptyState();
    for (const e of events) EventStore.apply(state, e);
    return state;
  }

  static apply(state: WorldState, event: WorldEvent): void {
    const resolve = (id: string) => {
      let cur = id;
      const seen = new Set<string>();
      while (state.aliases.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = state.aliases.get(cur)!;
      }
      return cur;
    };
    switch (event.kind) {
      case "upsertEntity": {
        const incoming = structuredClone(event.payload as Entity);
        const id = resolve(incoming.id);
        const existing = state.entities.get(id);
        if (!existing) {
          state.entities.set(id, { ...incoming, id });
        } else {
          existing.attrs = { ...existing.attrs, ...incoming.attrs };
          existing.aliases = [...new Set([...existing.aliases, ...incoming.aliases])].sort();
          existing.name = existing.name ?? incoming.name;
          existing.state = incoming.state ?? existing.state;
          existing.source = incoming.source;
          existing.updatedAt = incoming.updatedAt > existing.updatedAt ? incoming.updatedAt : existing.updatedAt;
        }
        break;
      }
      case "upsertContext": {
        const incoming = structuredClone(event.payload as Context);
        const existing = state.contexts.get(incoming.id);
        if (!existing) state.contexts.set(incoming.id, incoming);
        else {
          existing.attrs = { ...existing.attrs, ...incoming.attrs };
          existing.source = incoming.source;
          existing.updatedAt = incoming.updatedAt > existing.updatedAt ? incoming.updatedAt : existing.updatedAt;
        }
        break;
      }
      case "relate": {
        const rel = structuredClone(event.payload as Relationship);
        if (!state.relationships.has(rel.id)) state.relationships.set(rel.id, rel);
        break;
      }
      case "closeEdge": {
        const p = event.payload as { id: string; validTo: string; supersededBy?: string };
        const rel = state.relationships.get(p.id);
        if (rel && !rel.validTo) {
          rel.validTo = p.validTo;
          rel.supersededBy = p.supersededBy;
        }
        break;
      }
      case "assertFact": {
        const p = event.payload as { fact: Fact; winnerId: string; losers: string[] };
        state.facts.set(p.fact.id, structuredClone(p.fact));
        for (const id of p.losers) {
          const f = state.facts.get(id);
          if (f) f.supersededBy = p.winnerId;
        }
        const winner = state.facts.get(p.winnerId);
        const about = resolve(p.fact.about);
        let entity = state.entities.get(about);
        if (!entity) {
          const inferredType = about.includes(":") ? about.split(":")[0] : "entity";
          entity = {
            id: about, type: inferredType, aliases: [], attrs: {}, state: "emerging", schemaVersion: SCHEMA_VERSION,
            source: p.fact.source, createdAt: p.fact.assertedAt, updatedAt: p.fact.assertedAt,
          };
          state.entities.set(about, entity);
        }
        if (winner) entity.attrs[p.fact.predicate] = winner.value;
        if (p.fact.assertedAt > entity.updatedAt) entity.updatedAt = p.fact.assertedAt;
        break;
      }
      case "alias": {
        const p = event.payload as { aliasId: string; primaryId: string };
        const primary = resolve(p.primaryId);
        if (p.aliasId === primary) break;
        state.aliases.set(p.aliasId, primary);
        const dup = state.entities.get(p.aliasId);
        const target = state.entities.get(primary);
        if (dup && target) {
          target.aliases = [...new Set([...target.aliases, ...dup.aliases])].sort();
          target.attrs = { ...dup.attrs, ...target.attrs };
          state.entities.delete(p.aliasId);
        }
        break;
      }
      case "observation": {
        const rec = event.payload as ObservationRecord;
        state.observations.set(rec.externalId, structuredClone(rec));
        break;
      }
    }
  }
}
