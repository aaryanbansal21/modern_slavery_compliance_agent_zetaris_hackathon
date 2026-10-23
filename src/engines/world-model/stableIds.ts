// Stable, content-addressed IDs (World Model spec, docs/stable-ids.md).
// Same input gives the same ID on every machine and every replay.
import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Deterministic JSON: sorted keys, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/**
 * NFKD, strip combining marks, strip zero-width characters, lowercase,
 * collapse whitespace, trim. Never abbreviates or drops word characters, so
 * "Acme Corp" and "Acme Corporation" stay distinct.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[​-‍﻿]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function externalId(type: string, system: string, id: string): string {
  return `${type}:${system}:${id}`;
}

export function entityIdFromName(type: string, name: string): string {
  return `ent_${sha256Hex(`${type}:${normalizeName(name)}`).slice(0, 16)}`;
}

export function contextIdFromAttrs(type: string, attrs: Record<string, unknown>, parent?: string): string {
  return `ctx_${sha256Hex(`${type}:${canonicalJson(attrs)}:${parent ?? ""}`).slice(0, 16)}`;
}

export function relationshipId(from: string, type: string, to: string, context?: string, validFrom?: string): string {
  return `rel_${sha256Hex(`${from}|${type}|${to}|${context ?? ""}|${validFrom ?? ""}`).slice(0, 16)}`;
}

export function factId(about: string, predicate: string, value: unknown, at: string, kind: string, url?: string): string {
  return `fact_${sha256Hex(`${about}|${predicate}|${canonicalJson(value)}|${at}|${kind}|${url ?? ""}`).slice(0, 16)}`;
}
