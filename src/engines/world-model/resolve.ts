// Entity resolution bands from the World Model spec:
//   similarity >= 0.85          auto-merge (0.85 exactly merges)
//   0.82 <= similarity < 0.85   operator review queue (0.82 exactly queues)
//   below 0.82                  new entity
// Similarity is 1 - levenshtein / max(len) on normalized names.
import { normalizeName } from "./stableIds.ts";

export type ResolutionDecision = "auto-merge" | "review" | "new";

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export function nameSimilarity(rawA: string, rawB: string): number {
  const a = normalizeName(rawA);
  const b = normalizeName(rawB);
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

export function decide(similarity: number, autoMergeAt = 0.85, reviewAt = 0.82): ResolutionDecision {
  // Round to avoid floating error at the exact boundaries (0.85 must merge).
  const s = Math.round(similarity * 1e9) / 1e9;
  if (s >= autoMergeAt) return "auto-merge";
  if (s >= reviewAt) return "review";
  return "new";
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}
