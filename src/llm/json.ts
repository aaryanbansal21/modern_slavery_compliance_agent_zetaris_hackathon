// Robust JSON extraction from model output: strips reasoning blocks and code
// fences, then finds the first balanced JSON object or array.

export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "").trim();
}

export function extractJson(text: string): unknown {
  const cleaned = stripReasoning(text);
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], cleaned].filter((x): x is string => !!x);
  for (const candidate of candidates) {
    const direct = tryParse(candidate.trim());
    if (direct !== undefined) return direct;
    const balanced = firstBalanced(candidate);
    if (balanced) {
      const parsed = tryParse(balanced);
      if (parsed !== undefined) return parsed;
    }
  }
  throw new Error("No JSON object found in model output");
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function firstBalanced(s: string): string | undefined {
  const start = s.search(/[{[]/);
  if (start < 0) return undefined;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}
