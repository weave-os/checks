// Splits a stream-json stdout blob into the per-event JSONL lines AND the
// terminal "result" event the verdict pipeline reads.
//
// Stream-json emits one JSON object per line over the lifetime of an
// invocation: system init/hook events, every assistant turn, every tool call
// and its result, and finally one terminal `{"type":"result", ...}` event
// carrying the same fields the verdict parser used to read off the single
// `--output-format json` JSON blob (`subtype`, `is_error`, `result`,
// `structured_output`). The terminal event is parsed out here so the verdict
// path can keep reading the same fields it always did, while the full line
// stream is what the diagnostics artifact flushes as the invocation's
// transcript.
//
// Returns:
//   - transcript: string[] of non-empty raw JSONL lines, including any that
//     failed to parse. The artifact is more useful with a corrupt line
//     visible than with it silently dropped -- finding the bad bytes
//     matters when debugging a check that ended neutral.
//   - resultEvent: the parsed terminal `result` event, or null when the CLI
//     crashed before emitting one
//   - sessionId: the session_id on the first event that carried one. Every
//     event in the stream has it, so the first is fine. Reading the
//     pre-stream JSON required a successful parse of the structured blob,
//     which sometimes failed for budgeted-out runs -- the session id is now
//     recoverable even from a crashed invocation, which is what the cost
//     endpoint needs to price it.

// Renders the Claude transcript(s) for one check as a single <details> block
// suitable for embedding in a GitHub check-run summary. The diagnostics
// artifact keeps the complete raw JSONL stream; this summary deliberately
// renders only a compact, human-readable projection so a reviewer can follow
// the agent's text, tool calls, and results without scanning transport data.
//
// The whole section is byte-capped at TRANSCRIPT_SECTION_MAX_BYTES so a
// multi-megabyte transcript can't blow past GitHub's check-run
// output.summary limit of 65535 UTF-8 bytes (the documented maxLength on
// POST/PATCH /repos/.../check-runs; github/docs issue #35252 of Nov 2024
// confirms the limit is in bytes, not characters, despite the field's
// "max characters" docs text). When truncation kicks in, the truncated
// block ends with a clear "see workflow artifact" marker so the reader
// knows there is more on disk.
export const TRANSCRIPT_SECTION_MAX_BYTES = 10240;

const MAX_EVENT_CHARS = 500;

// Fixed vocabularies read off the stream-json events. Single source of truth
// for every comparison site below -- a typo in a raw string literal would
// silently fall through to the generic display branch instead of being
// caught statically.
const STREAM_EVENT_TYPE = {
  SYSTEM: "system",
  ASSISTANT: "assistant",
  USER: "user",
  RESULT: "result",
};
const SYSTEM_SUBTYPE = { INIT: "init", THINKING_TOKENS: "thinking_tokens" };
const CONTENT_BLOCK_TYPE = {
  TEXT: "text",
  THINKING: "thinking",
  TOOL_USE: "tool_use",
  TOOL_RESULT: "tool_result",
};

export function formatTranscriptSection(phase, sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return "";
  const summaryLabel =
    sessions.length === 1
      ? `${phase} transcript`
      : `${phase} transcripts (${sessions.length} attempts)`;
  const lines = [`<details><summary>${summaryLabel}</summary>`, ""];
  // Each session gets an equal share of the section cap so a check that ran
  // all four phases doesn't put the last phase's transcript into a 0-byte
  // allowance. The framing cost (details/summary tags + per-block headers)
  // is bounded because each block has roughly the same shape.
  const perSessionBudget = Math.floor(
    TRANSCRIPT_SECTION_MAX_BYTES / sessions.length,
  );
  let renderedPhase = false;
  for (const session of sessions) {
    const rendered = renderSessionBlock(session, perSessionBudget);
    if (rendered === null) continue;
    lines.push(...rendered);
    lines.push("");
    renderedPhase = true;
  }
  if (!renderedPhase) return "";
  // Replace the trailing blank line we just pushed with the closing tag.
  lines.pop();
  lines.push("</details>");
  return lines.join("\n");
}

// Produces a line-oriented projection of a stream-json transcript. It keeps
// the important control-plane events (init, thinking, tools, tool results,
// and terminal result) while hiding IDs, timestamps, signatures, and usage
// blobs that are only useful when inspecting the raw diagnostics artifact.
export function summarizeTranscript(text) {
  if (typeof text !== "string" || text === "") return "";
  const lines = [];
  const toolNames = new Map();
  let thinkingUpdates = 0;
  let latestThinkingTokens = null;

  function flushThinking() {
    if (thinkingUpdates === 0) return;
    const details = [`${thinkingUpdates} update${thinkingUpdates === 1 ? "" : "s"}`];
    if (latestThinkingTokens !== null) {
      details.push(`~${latestThinkingTokens.toLocaleString()} tokens`);
    }
    lines.push(`System thinking · ${details.join(" · ")}`);
    thinkingUpdates = 0;
    latestThinkingTokens = null;
  }

  for (const rawLine of text.split("\n")) {
    if (rawLine === "") continue;
    let event;
    try {
      event = JSON.parse(rawLine);
    } catch {
      flushThinking();
      lines.push(`Unparseable event: ${shorten(rawLine)}`);
      continue;
    }
    if (!isRecord(event)) {
      flushThinking();
      lines.push(`Unexpected event: ${shorten(rawLine)}`);
      continue;
    }
    if (
      event.type === STREAM_EVENT_TYPE.SYSTEM &&
      event.subtype === SYSTEM_SUBTYPE.THINKING_TOKENS
    ) {
      thinkingUpdates += 1;
      if (Number.isFinite(event.estimated_tokens)) {
        latestThinkingTokens = event.estimated_tokens;
      }
      continue;
    }

    flushThinking();
    lines.push(...summarizeEvent(event, toolNames));
  }
  flushThinking();
  return lines.join("\n");
}

function renderSessionBlock(session, byteBudget) {
  const text = typeof session.text === "string" ? session.text : "";
  if (text === "" && (typeof session.sessionId !== "string" || session.sessionId === "")) {
    return null;
  }
  // The session header always shows the router-reported cost for this
  // attempt, when one was captured. This is the authoritative number --
  // distinct from `total_cost_usd` on the terminal result event, which
  // is the CLI's local accounting.
  const costFragment = Number.isFinite(session.cost)
    ? ` · router cost $${session.cost.toFixed(2)}`
    : "";
  const header = `**${session.label}** · session \`${session.sessionId ?? "unknown"}\`${costFragment}`;
  const summary = summarizeTranscript(text);
  const { preview, truncated, omitted } = truncateText(summary, byteBudget);
  if (preview === "") {
    // `truncated` can still be true here: the first summarized line alone
    // exceeded byteBudget, so truncateText() kept nothing even though the
    // transcript had content. Saying "No transcript events" in that case
    // would tell the reviewer the run produced nothing, when the truth is
    // "produced something, cut entirely by the byte budget."
    return truncated
      ? [header, "", formatTruncationNote(omitted)]
      : [header, "", "_No transcript events were recorded._"];
  }
  // The parser produces one display line per event. A text fence preserves
  // that alignment without presenting the stream as raw JSONL, and escaping
  // fence delimiters keeps a model-produced code sample inside the block.
  const trailingResult = truncated ? terminalResultLine(summary) : null;
  const resultWasOmitted =
    trailingResult !== null && !preview.endsWith(trailingResult);
  const tail = [];
  // Reinstating the trailing result line below can bring the adjusted omit
  // count down to 0 -- e.g. truncation dropped only the terminal `Result`
  // line, which is then reinstated. A "0 steps omitted" marker in that case
  // would contradict the fully-visible transcript right above it, so only
  // show the note when something is genuinely still missing.
  const adjustedOmitted = Math.max(0, omitted - (resultWasOmitted ? 1 : 0));
  if (truncated && adjustedOmitted > 0) {
    tail.push(formatTruncationNote(adjustedOmitted));
  }
  if (trailingResult !== null) tail.push(trailingResult);
  return [
    header,
    "",
    "```text",
    tail.length > 0 ? `${preview}\n${tail.join("\n")}` : preview,
    "```",
  ];
}

function terminalResultLine(summary) {
  // Pick the last summary line that is or begins with "Result " so a
  // truncated block still tells the reviewer what the final outcome was --
  // summarizeResult() returns the bare "Result" when the event carried no
  // detail fields, so that exact line must match too, not just the
  // detailed ("Result · success · ...") form. Returning null when the
  // input had no result event at all (rare, but legal -- e.g. the CLI
  // crashed before emitting one) keeps the truncation marker honest about
  // what is and isn't known.
  const lines = summary.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] === "Result" || lines[index].startsWith("Result ")) return lines[index];
  }
  return null;
}

function formatTruncationNote(omitted) {
  // `omitted` is the count of summarized events that did not fit in the
  // byte budget and were not re-instated below the marker. Reporting it
  // lets a reader tell at a glance whether the truncation shaved off the
  // tail (single digits) or chopped the middle (hundreds). The full event
  // stream is on the diagnostics artifact.
  const word = omitted === 1 ? "step" : "steps";
  return `... truncated, ${omitted.toLocaleString()} ${word} omitted. Full transcript is in the workflow diagnostics artifact.`;
}

function summarizeEvent(event, toolNames) {
  if (
    event.type === STREAM_EVENT_TYPE.SYSTEM &&
    event.subtype === SYSTEM_SUBTYPE.INIT
  ) {
    const details = [];
    if (typeof event.model === "string") details.push(`model ${event.model}`);
    if (typeof event.session_id === "string") details.push(`session ${event.session_id}`);
    if (Array.isArray(event.tools)) details.push(`${event.tools.length} tools`);
    return [`System init${details.length === 0 ? "" : ` · ${details.join(" · ")}`}`];
  }
  if (event.type === STREAM_EVENT_TYPE.ASSISTANT) return summarizeAssistant(event, toolNames);
  if (event.type === STREAM_EVENT_TYPE.USER) return summarizeUser(event, toolNames);
  if (event.type === STREAM_EVENT_TYPE.RESULT) return [summarizeResult(event)];
  return [`${displayType(event.type)} event${event.subtype ? ` · ${event.subtype}` : ""}`];
}

function summarizeAssistant(event, toolNames) {
  const content = event.message?.content;
  if (!Array.isArray(content)) return ["Assistant event"];
  const lines = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === CONTENT_BLOCK_TYPE.TEXT) {
      lines.push(`Assistant: ${shorten(block.text)}`);
    } else if (block.type === CONTENT_BLOCK_TYPE.THINKING) {
      const thinkingChars = typeof block.thinking === "string" ? block.thinking.length : 0;
      const signatureBytes = typeof block.signature === "string"
        ? Buffer.byteLength(block.signature, "utf8")
        : 0;
      const details = [`${thinkingChars.toLocaleString()} chars`];
      if (signatureBytes > 0) details.push(`${formatBytes(signatureBytes)} signature`);
      lines.push(`Assistant thinking · ${details.join(" · ")}`);
    } else if (block.type === CONTENT_BLOCK_TYPE.TOOL_USE) {
      const name = typeof block.name === "string" ? block.name : "tool";
      if (typeof block.id === "string") toolNames.set(block.id, name);
      lines.push(`Assistant: ${name} ${shortenJson(block.input)}`);
    } else {
      lines.push(`Assistant: ${displayType(block.type)}`);
    }
  }
  return lines.length > 0 ? lines : ["Assistant event"];
}

function summarizeUser(event, toolNames) {
  const content = event.message?.content;
  if (typeof content === "string") return [`User: ${shorten(content)}`];
  if (!Array.isArray(content)) return ["User event"];
  const lines = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === CONTENT_BLOCK_TYPE.TOOL_RESULT) {
      const toolName = toolNames.get(block.tool_use_id) ?? "Tool";
      lines.push(`${toolName} result: ${shorten(toolResultText(block.content))}`);
    } else if (block.type === CONTENT_BLOCK_TYPE.TEXT) {
      lines.push(`User: ${shorten(block.text)}`);
    } else {
      lines.push(`User: ${displayType(block.type)}`);
    }
  }
  return lines.length > 0 ? lines : ["User event"];
}

function summarizeResult(event) {
  // The CLI's local cost accounting disagrees with the Weave Router's
  // authoritative cost on the check-run title row, so we deliberately
  // leave it off this line. Cost lives on the summary footer, not here.
  const details = [];
  if (typeof event.subtype === "string") details.push(event.subtype);
  if (Number.isFinite(event.num_turns)) details.push(`${event.num_turns} turns`);
  if (isRecord(event.usage)) {
    const usage = [];
    if (Number.isFinite(event.usage.input_tokens)) usage.push(`${event.usage.input_tokens.toLocaleString()} input`);
    if (Number.isFinite(event.usage.output_tokens)) usage.push(`${event.usage.output_tokens.toLocaleString()} output`);
    if (Number.isFinite(event.usage.cache_read_input_tokens) && event.usage.cache_read_input_tokens > 0) {
      usage.push(`${event.usage.cache_read_input_tokens.toLocaleString()} cache read`);
    }
    if (usage.length > 0) details.push(usage.join(" · "));
  }
  return `Result${details.length === 0 ? "" : ` · ${details.join(" · ")}`}`;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return shortenJson(content);
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (isRecord(block) && typeof block.text === "string") return block.text;
      return shortenJson(block);
    })
    .join(" ");
}

function truncateText(text, byteBudget) {
  const total = text.split("\n").length;
  const kept = [];
  let bytes = 0;
  for (const line of text.split("\n")) {
    const lineCost = Buffer.byteLength(line, "utf8") + (kept.length === 0 ? 0 : 1);
    if (bytes + lineCost > byteBudget) break;
    kept.push(line);
    bytes += lineCost;
  }
  // The omitted count is what the truncation marker reports to the reader,
  // so it must reflect the dropped summarized EVENT LINES -- not the
  // dropped raw-JSONL lines the marker used to measure against. After
  // summary projection a 10k-event raw transcript becomes ~hundreds of
  // event lines; the marker should still read "5 steps omitted" instead
  // of "9,900 steps omitted" once we summarize.
  const omitted = Math.max(0, total - kept.length);
  return { preview: kept.join("\n"), truncated: omitted > 0, omitted };
}

function shorten(value) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/```/g, "\\`\\`\\`")
    .trim();
  if (normalized.length <= MAX_EVENT_CHARS) return normalized;
  return `${normalized.slice(0, MAX_EVENT_CHARS)}… (${normalized.length - MAX_EVENT_CHARS} more chars)`;
}

function shortenJson(value) {
  return shorten(JSON.stringify(value) ?? "null");
}

function displayType(value) {
  return typeof value === "string" && value !== "" ? value : "Unknown";
}

function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function splitStreamJson(stdout) {
  const lines = typeof stdout === "string" ? stdout.split("\n") : [];
  const transcript = [];
  let resultEvent = null;
  let sessionId = null;
  for (const line of lines) {
    if (line === "") continue;
    transcript.push(line);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // A corrupt line should not lose the rest of the transcript (already
      // pushed above) and should not stop the loop from finding the
      // terminal `result` later in the stream.
      continue;
    }
    if (!isRecord(event)) {
      continue;
    }
    if (
      typeof event.session_id === "string" &&
      event.session_id !== "" &&
      sessionId === null
    ) {
      sessionId = event.session_id;
    }
    if (event.type === "result") {
      resultEvent = event;
    }
  }
  return { transcript, resultEvent, sessionId };
}
