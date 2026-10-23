// Small text helpers for client-facing wording.

const TYPE_PLAIN: Record<string, string> = {
  "Forced Labor": "forced labour",
  "Forced Child Labor": "forced child labour",
  "Child Labor": "child labour",
  "Inputs Produced with Forced Labor": "inputs made with forced labour",
  "Inputs Produced with Child Labor": "inputs made with child labour",
};

const TYPE_ORDER = ["Forced Labor", "Forced Child Labor", "Child Labor", "Inputs Produced with Forced Labor", "Inputs Produced with Child Labor"];

export function sortTypes(types: string[]): string[] {
  return [...new Set(types)].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
}

/** DOL exploitation types in plain Australian English. */
export function plainTypes(types: string[]): string[] {
  return sortTypes(types).map((t) => TYPE_PLAIN[t] ?? t.toLowerCase());
}

const LEGAL_TAIL = /[\s,]+(Pty\.?\s+Ltd\.?|Pty\.?\s+Limited|Ltd\.?|Limited|Sdn\.?\s*Bhd\.?|Co\.?,?\s+Ltd\.?|Co\.?|Inc\.?|LLC)$/i;

/** "CleanPro Supplies Pty Ltd" -> "CleanPro Supplies", "Yiwu Bright Textile Co., Ltd" -> "Yiwu Bright Textile". */
export function shortName(name: string): string {
  let out = name.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEGAL_TAIL, "").trim();
    if (next === out || next.length < 3) break;
    out = next;
  }
  return out;
}

/** Lowercase DOL good names for prose and pick the verb: "rubber gloves are", "cotton is". */
export function goodsPhrase(goods: string[]): { text: string; verb: "is" | "are" } {
  const uniq = [...new Set(goods)];
  const lower = uniq.map((g) => g.toLowerCase());
  const text = lower.length > 1 ? `${lower.slice(0, -1).join(", ")} and ${lower.at(-1)}` : (lower[0] ?? "");
  return { text, verb: uniq.length > 1 || /s$/i.test(uniq[0] ?? "") ? "are" : "is" };
}

/** "Nitrile examination gloves, powder-free, size L (box of 100)" -> "nitrile examination gloves". */
export function productName(description: string): string {
  const base = description
    .replace(/\s*\(.*?\)\s*/g, " ")
    .split(",")[0]
    .replace(/\b\d+(?:x\d+)?\s?(?:cm|mm|g|kg|kw|l|ml)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return base.length > 1 && base[1] === base[1].toLowerCase() ? base.charAt(0).toLowerCase() + base.slice(1) : base;
}

export function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "Lithium-Ion Batteries from China" -> "lithium-ion batteries from China". */
export function pairText(pair: string): string {
  return pair.replace(/^(.*?) from /, (_m, good: string) => `${good.toLowerCase()} from `);
}
