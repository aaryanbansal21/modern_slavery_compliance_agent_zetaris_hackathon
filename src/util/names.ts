// Company and person name normalization for identity resolution and sanctions
// screening. Normalization runs when data is prepared (seed and fetch
// scripts), so the federated SQL in Zetaris only needs levenshtein() on
// pre-normalized columns. That keeps the SQL identical in Spark SQL (Zetaris)
// and DuckDB (the offline stand-in).

const LEGAL_SUFFIXES = new Set([
  "pty", "ltd", "limited", "co", "company", "inc", "incorporated", "llc", "llp", "lp",
  "sdn", "bhd", "berhad", "gmbh", "plc", "corp", "corporation", "jsc", "ojsc", "pjsc", "cjsc",
  "sa", "ag", "bv", "nv", "srl", "spa", "pte", "kk", "oy", "ab", "sarl", "sas",
  "the", "ooo", "zao", "tov", "fze", "fzco", "fzc", "pvt", "private",
]);

const ABBREVIATIONS: Record<string, string> = {
  ind: "industries", inds: "industries", indus: "industries", intl: "international",
  mfg: "manufacturing", mfr: "manufacturer", bros: "brothers", svc: "services", svcs: "services",
  dist: "distribution", tradg: "trading", engg: "engineering", aust: "australia", aus: "australia",
};

// Geographic descriptors that companies add to their names ("Uniform Hub
// Australia"). Dropped from the matching key only when at least two other
// tokens remain, so the key still identifies the business.
const GEO_TOKENS = new Set([
  "australia", "australian", "malaysia", "china", "bangladesh", "germany", "japan", "nsw", "vic", "qld",
]);

function baseTokens(raw: string): string[] {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t);
}

/** Lowercase, ASCII, legal suffixes removed, abbreviations expanded. Used for sanctions screening. */
export function normalizeEntityName(raw: string | null | undefined): string {
  if (!raw) return "";
  return baseTokens(raw).filter((t) => !LEGAL_SUFFIXES.has(t) && t !== "and").join(" ");
}

/** Matching key for linking records about the same company across systems. */
export function companyKey(raw: string | null | undefined): string {
  const tokens = normalizeEntityName(raw).split(" ").filter(Boolean);
  const core = tokens.filter((t) => !GEO_TOKENS.has(t));
  // Keep country words when removing them would leave fewer than two tokens.
  return (core.length >= 2 ? core : tokens).join(" ");
}

/** Tokens sorted alphabetically, to catch word-order differences ("SMITH John" vs "John Smith"). */
export function sortedTokens(norm: string): string {
  return norm.split(" ").filter(Boolean).sort().join(" ");
}

export function emailDomain(email: string | null | undefined): string {
  if (!email || !email.includes("@")) return "";
  return email.split("@")[1].trim().toLowerCase();
}

export function slug(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

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

export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/** Split a free-text list such as "Malaysia; Australia" or "A, B and C". */
export function splitList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
