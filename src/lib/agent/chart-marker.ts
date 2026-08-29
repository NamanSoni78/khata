/**
 * Shared [CHART:{...}] marker extraction.
 *
 * Agents (daily + dashboard) may append a single chart marker line AFTER their
 * textual reply. This module parses the marker out so:
 *   - the clean text renders in the chat bubble,
 *   - the UI shows a "Show as chart" reveal button with the parsed spec.
 *
 * Balanced-brace matching is required because chart specs contain nested JSON
 * (data:[{label,value},...]) — a non-greedy regex would stop at the first `}`.
 */

export interface ChartSpec {
  type: "bar" | "line" | "pie";
  title: string;
  data: Array<{ label: string; value: number }>;
  xLabel?: string;
  yLabel?: string;
}

export function extractChartMarker(raw: string): { cleanText: string; chartSpec: ChartSpec | null } {
  const startIdx = raw.indexOf("[CHART:");
  if (startIdx === -1) {
    return { cleanText: raw.trim(), chartSpec: null };
  }
  const afterBracket = startIdx + "[CHART:".length;
  if (raw[afterBracket] !== "{") {
    // Malformed marker; strip just the literal "[CHART:" and continue.
    return { cleanText: raw.replace("[CHART:", "").trim(), chartSpec: null };
  }

  // Balanced-brace scan
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;
  for (let i = afterBracket; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx === -1) {
    // Unbalanced — drop the whole tail so users never see a broken marker.
    return { cleanText: raw.slice(0, startIdx).trim(), chartSpec: null };
  }

  const fullMarker = raw.slice(startIdx, endIdx + 2); // "[CHART:{...}]"
  const jsonStr = raw.slice(afterBracket, endIdx + 1);

  try {
    const parsed = JSON.parse(jsonStr) as ChartSpec;
    if (!parsed || !Array.isArray(parsed.data) || !parsed.type) {
      return { cleanText: raw.replace(fullMarker, "").trim(), chartSpec: null };
    }
    return {
      cleanText: raw.replace(fullMarker, "").trim(),
      chartSpec: parsed,
    };
  } catch {
    return { cleanText: raw.replace(fullMarker, "").trim(), chartSpec: null };
  }
}
