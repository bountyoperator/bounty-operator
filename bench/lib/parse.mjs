// Paydirt parsing: the answer sheet out of a model's final message, omp's JSON event
// stream, and the request bodies written by harness/dump-ext.ts. Pure functions only.

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'unrated'];
export const VERDICTS = ['supported', 'overclaimed', 'unsupported', 'n/a'];
const SHEET_KEYS = ['findings', 'rejected', 'verdict', 'max_severity'];
const LOOKS_LIKE_SHEET = /"(?:findings|verdict|rejected)"/;

// ---------------------------------------------------------------- answer sheet

export function normSeverity(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[^a-z/]/g, '');
  if (!s) return 'unrated';
  if (s.startsWith('crit')) return 'critical';
  if (s.startsWith('high')) return 'high';
  if (s.startsWith('med') || s === 'moderate') return 'medium';
  if (s.startsWith('low') || s === 'minor') return 'low';
  if (s.startsWith('info') || s === 'note' || s === 'none' || s === 'gas' || s === 'qa' || s === 'nc') return 'info';
  return 'unrated'; // unknown labels count as unrated, which is treated like medium-or-above on a fixed twin
}

export function normVerdict(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'supported' || s === 'support') return 'supported';
  if (s === 'overclaimed' || s === 'overclaim' || s === 'overstated') return 'overclaimed';
  if (s === 'unsupported' || s === 'notsupported') return 'unsupported';
  if (s === '' || s === 'n/a' || s === 'na' || s === 'none' || s === 'null') return 'n/a';
  return 'invalid';
}

function toLine(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string') {
    const m = /\d+/.exec(value);
    if (m) return Number(m[0]);
  }
  return 0;
}

function text(value, limit) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  return s.length > limit ? s.slice(0, limit) : s;
}

/** Coerce any parsed JSON object into the canonical answer-sheet shape. Never throws. */
export function normalizeSheet(obj) {
  const src = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const findings = [];
  for (const f of Array.isArray(src.findings) ? src.findings : []) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const start = toLine(f.line_start ?? f.lineStart ?? f.line ?? f.start);
    const endRaw = toLine(f.line_end ?? f.lineEnd ?? f.end);
    findings.push({
      file: text(f.file ?? f.path, 400),
      function: text(f.function ?? f.func ?? f.fn, 400),
      line_start: start,
      line_end: endRaw >= start ? endRaw : start,
      severity: normSeverity(f.severity),
      claim: text(f.claim ?? f.description ?? f.title, 4000),
    });
  }
  const rejected = [];
  for (const r of Array.isArray(src.rejected) ? src.rejected : []) {
    const quote = typeof r === 'string' ? r : r && typeof r === 'object' ? text(r.quote ?? r.text, 4000) : '';
    if (quote.trim()) rejected.push({ quote });
  }
  return {
    findings,
    rejected,
    verdict: normVerdict(src.verdict),
    max_severity: normSeverity(src.max_severity ?? src.maxSeverity),
  };
}

/** Remove comments and trailing commas that sit outside string literals. */
function repairJson(source) {
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += source[++i] ?? ''; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 1; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] === '}' || source[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function tryParse(candidate) {
  const body = candidate.replace(/^﻿/, '').trim();
  if (!body.startsWith('{')) return null;
  for (const [attempt, repaired] of [[body, false], [repairJson(body), true]]) {
    try {
      const value = JSON.parse(attempt);
      if (value && typeof value === 'object' && !Array.isArray(value) && SHEET_KEYS.some((k) => k in value)) return { value, repaired };
    } catch { /* try the next form */ }
  }
  return null;
}

/** Every balanced top-level {...} span in `source`, in order (string-aware). */
function balancedObjects(source) {
  const spans = [];
  let depth = 0, start = -1, inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { if (depth > 0) inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) { depth--; if (depth === 0) spans.push(source.slice(start, i + 1)); }
  }
  return spans;
}

/**
 * Find the answer sheet in a model's final message.
 * Order: the last fenced block that parses as a sheet; then an unterminated trailing fence;
 * then the last bare JSON object in the text that looks like a sheet.
 * Returns { ok: true, sheet, repaired, source } or { ok: false, reason: 'empty'|'no_sheet'|'bad_json' }.
 */
export function extractSheet(message) {
  const source = typeof message === 'string' ? message.replace(/\r\n?/g, '\n') : '';
  if (!source.trim()) return { ok: false, reason: 'empty' };
  const fences = [];
  const re = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  let m;
  while ((m = re.exec(source))) fences.push({ lang: m[3].toLowerCase(), body: m[4] });
  let sawJsonLike = false;
  for (let i = fences.length - 1; i >= 0; i--) {
    const f = fences[i];
    if (f.lang && !['json', 'json5', 'jsonc', 'javascript', 'js'].includes(f.lang)) continue;
    if (LOOKS_LIKE_SHEET.test(f.body)) sawJsonLike = true;
    const parsed = tryParse(f.body);
    if (parsed) return { ok: true, sheet: normalizeSheet(parsed.value), repaired: parsed.repaired, source: 'fence' };
  }
  const open = /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[ \t]*(?:json[a-z0-9]*)?[ \t]*\n(?![\s\S]*\n[ \t]*(?:`{3,}|~{3,}))([\s\S]*)$/i.exec(source);
  if (open) {
    if (LOOKS_LIKE_SHEET.test(open[1])) sawJsonLike = true;
    const parsed = tryParse(open[1]);
    if (parsed) return { ok: true, sheet: normalizeSheet(parsed.value), repaired: parsed.repaired, source: 'open-fence' };
  }
  const spans = balancedObjects(source);
  for (let i = spans.length - 1; i >= 0; i--) {
    if (!LOOKS_LIKE_SHEET.test(spans[i])) continue;
    sawJsonLike = true;
    const parsed = tryParse(spans[i]);
    if (parsed) return { ok: true, sheet: normalizeSheet(parsed.value), repaired: parsed.repaired, source: 'bare' };
  }
  // last resort: prose with stray quotes or braces can derail the scan above, so start
  // fresh from each `{` that precedes the last "findings" key (nearest first)
  const key = source.lastIndexOf('"findings"');
  if (key >= 0) {
    sawJsonLike = true;
    let from = key, tries = 0;
    while (tries++ < 40 && (from = source.lastIndexOf('{', from - 1)) >= 0) {
      const span = balancedObjects(source.slice(from))[0];
      if (!span || from + span.length < key) continue;
      const parsed = tryParse(span);
      if (parsed) return { ok: true, sheet: normalizeSheet(parsed.value), repaired: parsed.repaired, source: 'bare' };
    }
  }
  return { ok: false, reason: sawJsonLike ? 'bad_json' : 'no_sheet' };
}

// ---------------------------------------------------------------- omp event stream

function messageText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
}

const FILE_TOOLS = ['read', 'grep', 'glob'];
// How models spell a tool call in their own token format, when a host leaves it unparsed.
const CALL_OPENERS = /<tool_call>|<function_calls?>|<invoke\s+name\s*=|<function\s*=|<\|tool_calls?[^|]*\|>|\[TOOL_CALLS\]|to=functions\./gi;

/**
 * True when a message ends in an unparsed tool call instead of an answer. Some hosts fail to
 * parse a model's native tool-call format and hand the call back as text: no tool call is
 * made and no answer exists. Two shapes are recognised, both at the very end of the text:
 *   - the arguments of a file tool, as a JSON object with a string `path` or `pattern`
 *     (or a `{"name": "<tool>", "arguments": {...}}` wrapper around them);
 *   - call markup that names one of the three tools, e.g. `<invoke name="read">...</invoke>`.
 */
export function endsInToolArguments(reasoning) {
  const text = String(reasoning ?? '').trimEnd();
  if (endsInCallMarkup(text)) return true;
  if (!text.endsWith('}')) return false;
  // the last balanced {...}: walk back from the end, skipping braces inside strings
  let depth = 0, start = -1, inString = false;
  for (let i = text.length - 1; i >= 0 && text.length - i <= 2000; i--) {
    const ch = text[i];
    if (ch === '"') { let slashes = 0; for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) slashes++; if (slashes % 2 === 0) inString = !inString; continue; }
    if (inString) continue;
    if (ch === '}') depth++;
    else if (ch === '{' && --depth === 0) { start = i; break; }
  }
  if (start < 0) return false;
  let args;
  try { args = JSON.parse(text.slice(start)); } catch { return false; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const inner = args.arguments ?? args.parameters ?? args.input;
  if (typeof args.name === 'string' && FILE_TOOLS.includes(args.name) && inner && typeof inner === 'object') return true;
  return typeof args.path === 'string' || typeof args.pattern === 'string';
}

/** The text ends with tool-call markup that names read, grep or glob, and nothing follows it. */
function endsInCallMarkup(text) {
  const tail = text.slice(-3000);
  let last = -1;
  for (const m of tail.matchAll(CALL_OPENERS)) last = m.index;
  if (last < 0) return false;
  const block = tail.slice(last);
  if (!new RegExp(`\\b(?:${FILE_TOOLS.join('|')})\\b`).test(block)) return false;
  // the block runs to the end of the message: it closes with a tag, a brace or a bracket
  return /[>}\]]$/.test(block);
}

function messageReasoning(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.filter((p) => p && p.type === 'thinking' && typeof p.thinking === 'string').map((p) => p.thinking).join('\n');
}

/**
 * Reduce one stdout event to what is worth storing. Streaming deltas are dropped (the
 * complete message arrives in `message_end`); `turn_end` and `agent_end` only repeat
 * earlier messages, so they are kept as stubs. Returns the object to store, or null.
 */
export function compactEvent(event) {
  if (!event || typeof event !== 'object') return null;
  switch (event.type) {
    case 'message_update':
    case 'message_start':
    case 'tool_execution_update':
      return null;
    case 'turn_end':
      return { type: 'turn_end', stub: true, toolResults: Array.isArray(event.toolResults) ? event.toolResults.length : 0 };
    case 'agent_end':
      return { type: 'agent_end', stub: true, messages: Array.isArray(event.messages) ? event.messages.length : 0, isTerminal: event.isTerminal ?? null, yielded: event.yielded ?? null };
    default:
      return event;
  }
}

/** Parse a stored (or raw) events JSONL text into the facts the harness and scorer use. */
export function parseEvents(jsonl) {
  const out = {
    events: 0, bad: 0, cwd: null, assistant: [], tools: [], autoRetries: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    costReported: null, final: null, finalText: '', stopReason: null, models: [], providers: [], responseIds: [],
  };
  const models = new Set(), providers = new Set();
  let cost = 0, sawCost = false;
  for (const line of String(jsonl ?? '').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { out.bad++; continue; }
    out.events++;
    if (ev.type === 'session') out.cwd = ev.cwd ?? null;
    else if (ev.type === 'auto_retry_start') out.autoRetries++;
    else if (ev.type === 'tool_execution_end') {
      const body = Array.isArray(ev.result?.content) ? ev.result.content.map((c) => c?.text ?? '').join('') : '';
      out.tools.push({ name: ev.toolName ?? null, isError: ev.isError === true, blocked: /^Blocked by benchmark sandbox|is not permitted in this benchmark/.test(body), id: ev.toolCallId ?? null });
    } else if (ev.type === 'tool_execution_start') {
      const args = ev.args && typeof ev.args === 'object' ? ev.args : {};
      out.tools.push({ start: true, name: ev.toolName ?? null, path: typeof args.path === 'string' ? args.path : null, id: ev.toolCallId ?? null });
    } else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      const msg = ev.message;
      const u = msg.usage ?? {};
      out.usage.input += Number(u.input) || 0;
      out.usage.output += Number(u.output) || 0;
      out.usage.cacheRead += Number(u.cacheRead) || 0;
      out.usage.cacheWrite += Number(u.cacheWrite) || 0;
      out.usage.reasoning += Number(u.reasoningTokens) || 0;
      if (typeof u.cost?.total === 'number') { cost += u.cost.total; if (u.cost.total > 0) sawCost = true; }
      if (msg.model) models.add(msg.model);
      if (msg.provider) providers.add(msg.provider);
      if (msg.responseId) out.responseIds.push(msg.responseId);
      const entry = {
        model: msg.model ?? null, provider: msg.provider ?? null, stopReason: msg.stopReason ?? null,
        errorStatus: msg.errorStatus ?? null, errorMessage: typeof msg.errorMessage === 'string' ? msg.errorMessage.slice(0, 2000) : null,
        responseId: msg.responseId ?? null, text: messageText(msg),
        toolCalls: Array.isArray(msg.content) ? msg.content.filter((c) => c?.type === 'toolCall').length : 0,
        output: Number(u.output) || 0,
      };
      // no tool call, no answer sheet, and the message ends in an unparsed tool call: the host returned the call as text
      entry.strayToolCall = entry.toolCalls === 0 && !extractSheet(entry.text).ok && endsInToolArguments(entry.text.trim() ? entry.text : messageReasoning(msg));
      out.assistant.push(entry);
      out.final = entry;
    }
  }
  // tool calls: pair starts with ends so each record carries the requested path and the outcome
  const starts = new Map(out.tools.filter((t) => t.start).map((t) => [t.id, t]));
  out.tools = out.tools.filter((t) => !t.start).map((t) => ({ name: t.name, path: starts.get(t.id)?.path ?? null, isError: t.isError, blocked: t.blocked }));
  out.models = [...models];
  out.providers = [...providers];
  out.costReported = sawCost ? cost : null;
  if (out.final) {
    out.finalText = out.final.text;
    out.stopReason = out.final.stopReason;
  }
  return out;
}

// ---------------------------------------------------------------- dumped request bodies

function partsText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

/** The system prompt as the provider received it, whatever wire format omp used. */
export function requestSystem(payload) {
  const chunks = [];
  if (typeof payload?.instructions === 'string') chunks.push(payload.instructions);
  if (payload?.system !== undefined) chunks.push(partsText(payload.system));
  for (const key of ['messages', 'input']) {
    if (!Array.isArray(payload?.[key])) continue;
    for (const m of payload[key]) if (m && (m.role === 'system' || m.role === 'developer')) chunks.push(partsText(m.content));
  }
  if (payload?.systemInstruction?.parts) chunks.push(partsText(payload.systemInstruction.parts));
  return chunks.join('\n\n');
}

export function requestTools(payload) {
  const names = [];
  for (const t of Array.isArray(payload?.tools) ? payload.tools : []) {
    if (typeof t?.name === 'string') names.push(t.name);
    else if (typeof t?.function?.name === 'string') names.push(t.function.name);
    else if (Array.isArray(t?.functionDeclarations)) {
      for (const d of t.functionDeclarations) if (typeof d?.name === 'string') names.push(d.name);
    } else if (typeof t?.type === 'string') names.push(`<${t.type}>`); // provider built-in tool: must never appear
  }
  return names;
}

/** The reasoning effort actually sent. omp clamps `--thinking max` per model without warning. */
export function requestEffort(payload) {
  const r = payload?.reasoning;
  if (r && typeof r === 'object') {
    if (typeof r.effort === 'string') return r.effort;
    if (r.enabled === false) return 'disabled';
    if (typeof r.max_tokens === 'number') return `budget:${r.max_tokens}`;
    if (r.enabled === true) return 'enabled';
  }
  if (typeof payload?.reasoning_effort === 'string') return payload.reasoning_effort;
  if (typeof payload?.output_config?.effort === 'string') return payload.output_config.effort;
  const t = payload?.thinking;
  if (t && typeof t === 'object') {
    if (t.type === 'disabled') return 'disabled';
    if (typeof t.budget_tokens === 'number') return `budget:${t.budget_tokens}`;
    if (typeof t.type === 'string') return t.type;
  }
  const g = payload?.generationConfig?.thinkingConfig;
  if (g && typeof g === 'object') {
    if (typeof g.thinkingLevel === 'string') return g.thinkingLevel.toLowerCase();
    if (typeof g.thinkingBudget === 'number') return `budget:${g.thinkingBudget}`;
  }
  if (typeof payload?.enable_thinking === 'boolean') return payload.enable_thinking ? 'enabled' : 'disabled';
  return 'none';
}

/** One-line summary of a dumped request body (what is kept for every turn). */
export function summarizeRequest(payload) {
  const conversation = Array.isArray(payload?.messages) ? payload.messages : Array.isArray(payload?.input) ? payload.input : [];
  return {
    model: typeof payload?.model === 'string' ? payload.model : null,
    effort: requestEffort(payload),
    reasoning: payload?.reasoning ?? payload?.thinking ?? null,
    tools: requestTools(payload),
    provider: payload?.provider ?? null,
    items: conversation.length,
    max_tokens: payload?.max_tokens ?? payload?.max_completion_tokens ?? payload?.max_output_tokens ?? null,
    temperature: payload?.temperature ?? null,
    wire: Array.isArray(payload?.input) ? 'responses' : Array.isArray(payload?.messages) ? 'chat' : 'other',
  };
}

/** Parse requests.jsonl (one body per line). `first` is the full first body. */
export function parseRequests(jsonl) {
  const bodies = [];
  let bad = 0;
  for (const line of String(jsonl ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { bodies.push(JSON.parse(line)); } catch { bad++; }
  }
  const summaries = bodies.map(summarizeRequest);
  const uniq = (list) => [...new Set(list)];
  return {
    count: bodies.length,
    bad,
    first: bodies[0] ?? null,
    system: bodies[0] ? requestSystem(bodies[0]) : '',
    summaries,
    models: uniq(summaries.map((s) => s.model).filter(Boolean)),
    efforts: uniq(summaries.map((s) => s.effort)),
    toolsets: uniq(summaries.map((s) => [...s.tools].sort().join(','))),
    routing: uniq(summaries.map((s) => (s.provider ? JSON.stringify(s.provider) : '')).filter(Boolean)),
  };
}
