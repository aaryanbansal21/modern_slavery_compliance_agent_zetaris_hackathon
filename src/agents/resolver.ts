// Resolver agent. The supplier portal has no internal supplier IDs: suppliers
// type their own names. This agent links portal records and manufacturer
// names to ERP records through the World Model:
//   1. ABN, then email domain (deterministic, confirmed links)
//   2. World Model resolution on a company matching key:
//      >= 0.85 auto-merge, [0.82, 0.85) human review queue, below that new
//   3. A model reviews queued pairs against corroborating signals and
//      recommends, but only a person approves a merge (never auto-destructive)
// Approved merges persist in the World Model, so the next run links the
// record automatically.
import { z } from "zod";
import { companyKey, emailDomain, splitList } from "../util/names.ts";
import { shortName } from "../util/text.ts";
import { RESOLVER_SYSTEM } from "./prompts.ts";
import { aud, listJoin, type DeclarationInfo, type LineInfo, type RunContext } from "./context.ts";
import type { Evidence } from "./types.ts";
import { ids, prov } from "./world.ts";

const GENERIC_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "bigpond.com", "icloud.com", "live.com"]);

type RecordFn = (ctx: RunContext, e: Omit<Evidence, "id" | "iteration" | "tables" | "systems">) => Promise<Evidence>;

export async function linkDeclarationsDeterministic(ctx: RunContext, queryId: string): Promise<number> {
  let linked = 0;
  for (const d of ctx.state.declarations) {
    const sup = [...ctx.state.suppliers.values()];
    const byAbn = d.abn ? sup.find((x) => x.abn && x.abn === d.abn) : undefined;
    const domain = emailDomain(d.email);
    const byDomain = !byAbn && domain && !GENERIC_DOMAINS.has(domain) ? sup.find((x) => x.emailDomain && x.emailDomain === domain) : undefined;
    const match = byAbn ?? byDomain;
    if (!match) continue;
    d.link = { supplierId: match.supplierId, method: byAbn ? "abn" : "email_domain", confirmed: true };
    linked++;
    const source = prov(ctx, "zetaris", { ref: queryId, by: "resolver" });
    await ctx.world.upsertEntity({ type: "supplier", externalKey: { system: "erp", id: match.supplierId }, name: match.name, aliases: [d.supplierName], source });
    await ctx.world.relate({ from: ids.declaration(d.declId), type: "declared-by", to: match.entityId, attrs: { method: d.link.method }, source });
  }
  return linked;
}

const ResolverOut = z.object({
  recommendation: z.enum(["approve", "reject", "unsure"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).min(1),
});

function corroboration(ctx: RunContext, d: DeclarationInfo, supplierId: string, lines: LineInfo[]) {
  const supLines = lines.filter((l) => l.supplierId === supplierId);
  const declMakers = parseManufacturers(d.manufacturers).map((m) => companyKey(m.name));
  const longest = new Map<string, string>();
  for (const m of supLines.map((l) => l.manufacturer).filter((x) => x && declMakers.includes(companyKey(x)))) {
    const key = companyKey(m);
    if ((longest.get(key)?.length ?? 0) < m.length) longest.set(key, m);
  }
  const sharedMakers = [...longest.values()].map(shortName);
  const declCountries = splitList(d.originCountries).map((c) => c.toLowerCase());
  const sharedCountries = [...new Set(supLines.map((l) => l.originCountry).filter((c) => c && declCountries.includes(c.toLowerCase())))];
  const sup = ctx.state.suppliers.get(supplierId)!;
  const dTokens = emailDomain(d.email).split(/[.-]/);
  const domainOverlap = sup.emailDomain.split(/[.-]/).filter((t) => t.length > 3 && t !== "example" && dTokens.includes(t));
  return { sharedMakers, sharedCountries, domainOverlap, supplier: sup };
}

/** Pull manufacturer names (and a country in brackets) out of free text such as "A Sdn Bhd (Malaysia); B GmbH". */
export function parseManufacturers(text: string): { name: string; country?: string }[] {
  return splitList(text)
    .filter((part) => !/not specified|unspecified|unknown|n\/a|^none$/i.test(part))
    .filter((part) => !/\b(from|suppliers?|cells?|products?|components?)\b/.test(part) || /\b(Ltd|Bhd|GmbH|Inc|LLC|Co\.?)\b/.test(part))
    .map((part) => {
      const country = part.match(/\(([^)]+)\)/)?.[1];
      return { name: part.replace(/\([^)]*\)/g, "").trim(), country };
    })
    .filter((m) => m.name.length > 2);
}

export async function resolveEntities(
  ctx: RunContext,
  ensureLines: (ctx: RunContext) => Promise<LineInfo[]>,
  record: RecordFn,
): Promise<string[]> {
  const lines = await ensureLines(ctx);
  const out: string[] = [];
  const counts = { abn: 0, email_domain: 0, name: 0, review: 0, unmatched: 0 };
  const reviewNotes: string[] = [];
  const unmatchedNames: string[] = [];

  for (const d of ctx.state.declarations) {
    if (d.link?.confirmed && (d.link.method === "abn" || d.link.method === "email_domain")) {
      counts[d.link.method]++;
      continue;
    }
    const res = await ctx.world.upsertEntityResolved({
      type: "supplier",
      name: d.supplierName,
      matchKey: companyKey(d.supplierName),
      attrs: { selfReported: true, declId: d.declId },
      source: { kind: "portal", at: `${d.submittedAt}T00:00:00.000Z`, by: "resolver", runId: ctx.state.runId, ref: d.declId },
    });
    const resolvedId = ctx.world.resolveId(res.entity.id);
    const erpId = resolvedId.startsWith("supplier:erp:") ? resolvedId.split(":")[2] : undefined;
    if (erpId) {
      d.link = { supplierId: erpId, method: res.decision === "existing" ? "name_exact" : "name_auto_merge", confirmed: true, similarity: res.similarity };
      counts.name++;
      await ctx.world.relate({ from: ids.declaration(d.declId), type: "declared-by", to: resolvedId, attrs: { method: d.link.method, similarity: res.similarity }, source: prov(ctx, "agent", { by: "resolver" }) });
      ctx.trace.log("resolver", "memory", `Linked ${d.declId} "${d.supplierName}" to ${ctx.state.suppliers.get(erpId)?.name}`, {
        detail: res.decision === "existing" ? "Known identity in the World Model (linked or approved in an earlier run)" : `World Model auto-merge at similarity ${res.similarity?.toFixed(3)}`,
        data: { decision: res.decision, similarity: res.similarity, entityId: resolvedId },
      });
      continue;
    }
    const pending = ctx.world.mergeQueue().find((p) => p.status === "pending" && (p.leftId === res.entity.id || p.rightId === res.entity.id));
    if (pending) {
      const candidateId = pending.leftId === res.entity.id ? pending.rightId : pending.leftId;
      const supplierId = candidateId.split(":")[2];
      const c = corroboration(ctx, d, supplierId, lines);
      const policy = (): z.infer<typeof ResolverOut> => {
        const reasons = [`Name similarity ${pending.similarity.toFixed(2)} ("${d.supplierName}" vs "${c.supplier.name}"), inside the review band.`];
        if (c.sharedMakers.length) reasons.push(`The declaration names ${listJoin(c.sharedMakers)}, the same manufacturer recorded on ${c.supplier.name}'s invoices.`);
        if (c.sharedCountries.length) reasons.push(`Same origin countries as the invoices: ${listJoin(c.sharedCountries)}.`);
        if (c.domainOverlap.length) reasons.push(`Email domains share "${c.domainOverlap.join(", ")}" but are not identical.`);
        if (!d.abn) reasons.push("The declaration has no ABN, so it cannot be linked automatically.");
        const strong = c.sharedMakers.length > 0 || (c.sharedCountries.length > 0 && c.domainOverlap.length > 0);
        return { recommendation: strong ? "approve" : "unsure", confidence: strong ? 0.8 : 0.4, reasons };
      };
      const { value } = await ctx.llm.json(
        "resolver",
        `Review identity link: "${d.supplierName}" ~ "${c.supplier.name}"`,
        [
          { role: "system", content: RESOLVER_SYSTEM },
          {
            role: "user",
            content: JSON.stringify({
              portalRecord: { name: d.supplierName, abn: d.abn || null, email: d.email, origins: d.originCountries, manufacturers: d.manufacturers },
              erpSupplier: { name: c.supplier.name, abn: c.supplier.abn, emailDomain: c.supplier.emailDomain, category: c.supplier.category },
              similarity: pending.similarity,
              signals: { sharedManufacturers: c.sharedMakers, sharedOriginCountries: c.sharedCountries, emailDomainTokensInCommon: c.domainOverlap },
            }),
          },
        ],
        ResolverOut,
        policy,
        { temperature: 0 },
      );
      d.link = { supplierId, method: "name_review", confirmed: false, similarity: pending.similarity };
      counts.review++;
      ctx.state.pendingIdentity.push({ proposalId: pending.id, declId: d.declId, supplierId, similarity: pending.similarity, recommendation: value.recommendation, reasons: value.reasons });
      reviewNotes.push(`"${d.supplierName}" (${d.declId}) may be ${c.supplier.name} (similarity ${pending.similarity.toFixed(2)}); model recommendation: ${value.recommendation}`);
      if (!ctx.state.escalations.some((e) => e.action?.ref === pending.id)) {
        ctx.state.escalations.push({
          id: `X-${ctx.state.escalations.length + 1}`,
          type: "identity_review",
          title: `Confirm that "${d.supplierName}" is ${c.supplier.name}`,
          detail: `${value.reasons.join(" ")} Until a person confirms the link, evidence from declaration ${d.declId} is marked provisional.`,
          questionIds: [],
          supplierId,
          blocking: false,
          status: "open",
          action: { kind: "approve_merge", ref: pending.id },
        });
      }
      ctx.trace.log("resolver", "escalation", `Identity link queued for human review: ${d.declId}`, { detail: reviewNotes.at(-1), data: { proposalId: pending.id, recommendation: value.recommendation } });
      continue;
    }
    counts.unmatched++;
    unmatchedNames.push(`${d.supplierName} (${d.declId})`);
  }

  out.push((await record(ctx, {
    tool: "resolve_entities", title: "Identity resolution: ERP and supplier portal", topics: ["due_diligence"], queryIds: [], supplierIds: [],
    statement: `Linked ${ctx.state.declarations.length - counts.review - counts.unmatched} of ${ctx.state.declarations.length} portal declarations to ERP suppliers: ${counts.abn} by ABN, ${counts.email_domain} by email domain, ${counts.name} by company name.${counts.review ? ` ${counts.review} awaiting human review: ${reviewNotes.join("; ")}.` : ""}${counts.unmatched ? ` ${counts.unmatched} could not be matched: ${unmatchedNames.join(", ")}.` : ""}`,
    data: { ...counts },
  })).id);

  // Manufacturers from invoice lines and declarations, resolved in the World Model.
  type Variant = { raw: string; country?: string; lineId?: string; supplierId?: string; declId?: string };
  const variants: Variant[] = [];
  for (const l of lines) {
    if (l.manufacturer && !/not specified|unspecified/i.test(l.manufacturer)) variants.push({ raw: l.manufacturer, country: l.originCountry, lineId: l.lineId, supplierId: l.supplierId });
  }
  for (const d of ctx.state.declarations) {
    for (const m of parseManufacturers(d.manufacturers)) variants.push({ raw: m.name, country: m.country, declId: d.declId, supplierId: d.link?.supplierId });
  }
  const groups = new Map<string, { entityId: string; name: string; country: string; variants: Set<string>; lineIds: Set<string>; supplierIds: Set<string>; merges: string[] }>();
  for (const v of variants) {
    const res = await ctx.world.upsertEntityResolved({
      type: "manufacturer",
      name: v.raw.replace(/\s+/g, " ").trim(),
      matchKey: companyKey(v.raw),
      attrs: v.country ? { country: v.country } : {},
      source: prov(ctx, v.declId ? "portal" : "zetaris", { by: "resolver", ref: v.declId ?? v.lineId }),
    });
    const id = ctx.world.resolveId(res.entity.id);
    const ent = ctx.world.entity(id)!;
    const g = groups.get(id) ?? { entityId: id, name: ent.name ?? v.raw, country: (ent.attrs.country as string) ?? v.country ?? "", variants: new Set(), lineIds: new Set(), supplierIds: new Set(), merges: [] };
    g.variants.add(v.raw);
    if (v.lineId) g.lineIds.add(v.lineId);
    if (v.supplierId) g.supplierIds.add(v.supplierId);
    if (res.decision === "auto-merge") g.merges.push(`"${v.raw}" merged at similarity ${res.similarity?.toFixed(2)}`);
    groups.set(id, g);
    const source = prov(ctx, "agent", { by: "resolver" });
    if (v.lineId) await ctx.world.relate({ from: ids.line(v.lineId), type: "made-by", to: id, source });
    if (v.country) {
      const country = await ctx.world.upsertEntity({ type: "country", name: v.country, source });
      await ctx.world.relate({ from: id, type: "located-in", to: country.id, source });
    }
  }
  // A manufacturer can also be a supplier, or a supplier's parent company.
  for (const g of groups.values()) {
    const key = companyKey(g.name);
    for (const sup of ctx.state.suppliers.values()) {
      const source = prov(ctx, "agent", { by: "resolver" });
      if (sup.matchKey === key) await ctx.world.relate({ from: g.entityId, type: "same-business-as", to: sup.entityId, source });
      if (sup.parentCompany && companyKey(sup.parentCompany) === key) await ctx.world.relate({ from: g.entityId, type: "parent-of", to: sup.entityId, source });
    }
  }
  ctx.state.manufacturers = [...groups.values()].map((g) => ({
    entityId: g.entityId, name: g.name, country: g.country, variants: [...g.variants], lineIds: [...g.lineIds], supplierIds: [...g.supplierIds],
  }));
  const multi = [...groups.values()].filter((g) => g.variants.size > 1);
  out.push((await record(ctx, {
    tool: "resolve_entities", title: "Manufacturers", topics: ["due_diligence", "sanctions", "high_risk_goods"], queryIds: [], supplierIds: [],
    statement: `${variants.length} manufacturer name records from invoices and declarations resolve to ${groups.size} manufacturers in the World Model: ${listJoin([...groups.values()].map((g) => `${g.name}${g.country ? ` (${g.country})` : ""}`), 10)}.${multi.length ? ` Variants combined: ${multi.map((g) => `${g.name} from ${g.variants.size} spellings`).join("; ")}.` : ""}${[...groups.values()].flatMap((g) => g.merges).length ? ` Auto-merges: ${[...groups.values()].flatMap((g) => g.merges).join("; ")}.` : ""}`,
    data: { manufacturers: ctx.state.manufacturers.length, variants: variants.length },
  })).id);
  void aud;
  return out;
}
