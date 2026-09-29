import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TRANSCRIPT_SECTION_MAX_BYTES,
  formatTranscriptSection,
  splitStreamJson,
  summarizeTranscript,
} from "./streamsplit.mjs";

const SESSION_ID = "a2c7f8a4-6bcb-4c17-a0c1-e2c3d0877fc1";

function event(type, fields) {
  return JSON.stringify({ type, session_id: SESSION_ID, ...fields });
}

describe("splitStreamJson", () => {
  it("returns the raw lines, the terminal result event, and the first session_id", () => {
    const stdout = [
      event("system", { subtype: "init" }),
      event("assistant", { message: { content: "hi" } }),
      event("result", { subtype: "success", result: "x" }),
      "",
    ].join("\n");
    const { transcript, resultEvent, sessionId } = splitStreamJson(stdout);
    assert.equal(transcript.length, 3);
    assert.deepEqual(resultEvent, {
      type: "result",
      session_id: SESSION_ID,
      subtype: "success",
      result: "x",
    });
    assert.equal(sessionId, SESSION_ID);
  });

  it("drops empty lines but keeps them out of the transcript count", () => {
    const stdout = ["", event("system", { subtype: "init" }), ""].join("\n");
    const { transcript, sessionId } = splitStreamJson(stdout);
    assert.equal(transcript.length, 1);
    assert.equal(sessionId, SESSION_ID);
  });

  it("returns a null result event when the stream carries no terminal result", () => {
    const stdout = event("system", { subtype: "init" });
    const { resultEvent, sessionId } = splitStreamJson(stdout);
    assert.equal(resultEvent, null);
    assert.equal(sessionId, SESSION_ID);
  });

  it("keeps an unparseable line in the transcript and continues scanning", () => {
    const stdout = [
      "not-json-bytes",
      event("result", { subtype: "success", result: "x" }),
      "",
    ].join("\n");
    const { transcript, resultEvent } = splitStreamJson(stdout);
    assert.equal(transcript.length, 2);
    assert.equal(resultEvent.subtype, "success");
  });

  it("returns a null session_id when no event in the stream carries one", () => {
    // The CLI emits session_id on every line of stream-json in practice;
    // the helper's only filter is "session_id must be a non-empty string",
    // which is the contract the router cost endpoint relies on.
    const stdout = '{"type":"user","content":"hi"}\n';
    const { sessionId } = splitStreamJson(stdout);
    assert.equal(sessionId, null);
  });

  it("records the FIRST session_id seen, not the last", () => {
    const stdout = [
      event("system", { subtype: "init", session_id: "first" }),
      event("result", { subtype: "success", session_id: "last" }),
      "",
    ].join("\n");
    const { sessionId } = splitStreamJson(stdout);
    assert.equal(sessionId, "first");
  });

  it("handles non-string input without throwing", () => {
    for (const bad of [undefined, null, 0, [], {}]) {
      const { transcript, resultEvent, sessionId } = splitStreamJson(bad);
      assert.deepEqual(transcript, []);
      assert.equal(resultEvent, null);
      assert.equal(sessionId, null);
    }
  });

  it("treats valid-JSON non-object values as not-an-event", () => {
    // Defensive: a stray `"foo"` line should not turn `foo` into a session id.
    const stdout = [
      '"just-a-string"',
      event("result", { subtype: "success" }),
      "",
    ].join("\n");
    const { resultEvent, sessionId } = splitStreamJson(stdout);
    assert.equal(resultEvent.subtype, "success");
    assert.equal(sessionId, SESSION_ID);
  });
});

describe("summarizeTranscript", () => {
  it("returns the empty string for empty or non-string input", () => {
    assert.equal(summarizeTranscript(""), "");
    assert.equal(summarizeTranscript(undefined), "");
    assert.equal(summarizeTranscript(null), "");
  });

  it("renders a system init line with model, session id, and tool count", () => {
    const line = event("system", {
      subtype: "init",
      model: "claude-sonnet-5",
      tools: ["Bash", "Read"],
    });
    const summary = summarizeTranscript(line);
    assert.match(summary, /^System init · model claude-sonnet-5 · session .* · 2 tools$/);
  });

  it("renders assistant text as a single labeled line", () => {
    const line = event("assistant", {
      message: { content: [{ type: "text", text: "Here is my answer." }] },
    });
    assert.equal(summarizeTranscript(line), "Assistant: Here is my answer.");
  });

  it("renders an assistant tool_use block with its name and input", () => {
    const line = event("assistant", {
      message: {
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
      },
    });
    assert.equal(summarizeTranscript(line), 'Assistant: Bash {"command":"ls"}');
  });

  it("labels a tool result with the tool name recorded from the preceding tool_use", () => {
    const stdout = [
      event("assistant", {
        message: {
          content: [{ type: "tool_use", id: "toolu_1", name: "Grep", input: { pattern: "x" } }],
        },
      }),
      event("user", {
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "1 match" }],
        },
      }),
    ].join("\n");
    const summary = summarizeTranscript(stdout);
    assert.match(summary, /^Assistant: Grep/m);
    assert.match(summary, /^Grep result: 1 match$/m);
  });

  it("falls back to a generic 'Tool' label when no tool_use was recorded for the id", () => {
    const line = event("user", {
      message: {
        content: [{ type: "tool_result", tool_use_id: "unknown", content: "ok" }],
      },
    });
    assert.equal(summarizeTranscript(line), "Tool result: ok");
  });

  it("coalesces consecutive thinking_tokens events into one line with the latest estimate", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }),
      JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 150 }),
      JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 300 }),
    ].join("\n");
    const summary = summarizeTranscript(stdout);
    assert.equal(summary, "System thinking · 3 updates · ~300 tokens");
  });

  it("flushes a coalesced thinking run before the next non-thinking event", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }),
      JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 100 }),
      event("assistant", { message: { content: [{ type: "text", text: "done" }] } }),
    ].join("\n");
    const lines = summarizeTranscript(stdout).split("\n");
    assert.equal(lines[0], "System thinking · 2 updates · ~100 tokens");
    assert.equal(lines[1], "Assistant: done");
  });

  it("shows thinking-block presence and size without the signature bytes", () => {
    const line = event("assistant", {
      message: {
        content: [{ type: "thinking", thinking: "abcde", signature: "sig-bytes-here" }],
      },
    });
    const summary = summarizeTranscript(line);
    assert.match(summary, /^Assistant thinking · 5 chars · \d+(\.\d+)? (B|KB) signature$/);
    assert.doesNotMatch(summary, /sig-bytes-here/);
  });

  it("renders the terminal result event without the CLI-reported cost", () => {
    // The CLI's local cost accounting is intentionally omitted here -- its
    // value disagrees with the router-reported cost on the check-run title
    // row, so showing it next to usage data would mislead a reader
    // comparing the two numbers.
    const line = event("result", {
      subtype: "success",
      total_cost_usd: 0.42,
      num_turns: 6,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000 },
    });
    const summary = summarizeTranscript(line);
    assert.equal(
      summary,
      "Result · success · 6 turns · 100 input · 20 output · 5,000 cache read",
    );
  });

  it("renders a minimal terminal result without the cost field", () => {
    const line = event("result", {
      subtype: "success",
      total_cost_usd: 0.12,
      num_turns: 2,
      usage: { input_tokens: 2, output_tokens: 302, cache_read_input_tokens: 0 },
    });
    const summary = summarizeTranscript(line);
    assert.equal(
      summary,
      "Result · success · 2 turns · 2 input · 302 output",
    );
  });

  it("keeps an unparseable line visible rather than silently dropping it", () => {
    const summary = summarizeTranscript("not-json-bytes");
    assert.match(summary, /^Unparseable event: not-json-bytes$/);
  });

  it("truncates an overlong assistant text block with a char-count marker", () => {
    const longText = "x".repeat(600);
    const line = event("assistant", {
      message: { content: [{ type: "text", text: longText }] },
    });
    const summary = summarizeTranscript(line);
    assert.match(summary, /^Assistant: x+… \(100 more chars\)$/);
  });
});

describe("formatTranscriptSection", () => {
  it("returns the empty string when no sessions were recorded", () => {
    assert.equal(formatTranscriptSection("Reviewer", []), "");
  });

  it("renders a single-session block with a one-attempt summary label", () => {
    const block = formatTranscriptSection("Reviewer", [
      {
        label: "Main review",
        sessionId: SESSION_ID,
        text: event("result", { subtype: "success" }),
      },
    ]);
    assert.match(block, /^<details><summary>Reviewer transcript<\/summary>/);
    assert.match(block, /\*\*Main review\*\* · session `a2c7f8a4-6bcb-4c17-a0c1-e2c3d0877fc1`/);
    assert.match(block, /```text\nResult · success\n```/);
    assert.match(block, /<\/details>$/);
  });

  it("renders multiple sessions under one shared <details> block", () => {
    const block = formatTranscriptSection("Reviewer", [
      {
        label: "Main review",
        sessionId: "first",
        text: event("system", { subtype: "init" }),
      },
      {
        label: "Main review (retry)",
        sessionId: "second",
        text: event("result", { subtype: "success" }),
      },
    ]);
    assert.match(block, /^<details><summary>Reviewer transcripts \(2 attempts\)<\/summary>/);
    // Both sessions are present and ordered: initial first, retry last.
    assert.match(block, /`first`/);
    assert.match(block, /`second`/);
    const indexFirst = block.indexOf("`first`");
    const indexSecond = block.indexOf("`second`");
    assert.ok(indexFirst < indexSecond, "initial attempt renders before retry");
    // Single shared </details> closing -- exactly one, no per-session wrap.
    assert.equal(block.match(/<\/details>/g).length, 1);
  });

  it("uses 'unknown' verbatim when a session id is missing", () => {
    const block = formatTranscriptSection("Reviewer", [
      { label: "Main review", sessionId: null, text: event("result", { subtype: "success" }) },
    ]);
    assert.match(block, /`unknown`/);
  });

  it("omits a session with no transcript AND no session id", () => {
    // A crashed invocation that wrote nothing -- nothing to show.
    const block = formatTranscriptSection("Reviewer", [
      { label: "Main review", sessionId: null, text: "" },
    ]);
    assert.equal(block, "");
  });

  it("still renders a session that has no transcript but has a session id", () => {
    // An aborted invocation may still leave a session id on disk and an
    // empty transcript. Showing the session id is the pointer to the
    // diagnostics artifact; an empty body is the artifact's truth.
    const block = formatTranscriptSection("Reviewer", [
      { label: "Main review", sessionId: SESSION_ID, text: "" },
    ]);
    assert.match(block, /`a2c7f8a4-6bcb-4c17-a0c1-e2c3d0877fc1`/);
    assert.match(block, /_No transcript events were recorded\._/);
  });

  it("truncates a multi-megabyte transcript with the artifact marker", () => {
    const huge = Array.from({ length: 10_000 }, (_, index) =>
      // Long assistant text lines keep the synthetic transcript comfortably
      // over the byte cap with plenty of headroom.
      event("assistant", {
        message: { content: [{ type: "text", text: `turn ${index} ${"a".repeat(150)}` }] },
      }),
    ).join("\n");
    const block = formatTranscriptSection("Reviewer", [
      { label: "Main review", sessionId: SESSION_ID, text: huge },
    ]);
    assert.match(block, /... truncated, \d{1,3}(,\d{3})* steps? omitted\. Full transcript is in the workflow diagnostics artifact\./);
    // The capped block, when measured as UTF-8 bytes, fits under
    // TRANSCRIPT_SECTION_MAX_BYTES with a hard ceiling of its own --
    // overshoot means the helper is leaking through-the-budget lines.
    assert.ok(
      Buffer.byteLength(block, "utf8") <= TRANSCRIPT_SECTION_MAX_BYTES + 256,
      `block bytes=${Buffer.byteLength(block, "utf8")} exceed the cap plus 256-byte slack`,
    );
  });

  it("caps bytes per session when several are rendered", () => {
    // The byte budget is shared across renders in a multi-attempt block;
    // one chatty session cannot starve another of its share.
    const big = Array.from({ length: 50 }, (_, index) =>
      event("assistant", {
        message: { content: [{ type: "text", text: `line ${index} ${"x".repeat(80)}` }] },
      }),
    ).join("\n");
    const block = formatTranscriptSection("Reviewer", [
      { label: "First", sessionId: "first", text: big },
      { label: "Second", sessionId: "second", text: big },
    ]);
    assert.ok(
      Buffer.byteLength(block, "utf8") <= TRANSCRIPT_SECTION_MAX_BYTES + 256,
      `combined block bytes=${Buffer.byteLength(block, "utf8")} exceed cap plus slack`,
    );
    // Both attempts must still surface their session ids even when
    // truncated, so the diagnostics artifact remains findable.
    assert.match(block, /`first`/);
    assert.match(block, /`second`/);
  });

  it("does not double-close when truncation kicks in mid-stream", () => {
    // Guard against an off-by-one where a tailing truncation note adds
    // its own fence close above the </details>. The closing </details>
    // should always be the single trailing tag.
    const huge = Array.from({ length: 500 }, (_, index) =>
      event("assistant", {
        message: { content: [{ type: "text", text: `y ${index} ${"y".repeat(150)}` }] },
      }),
    ).join("\n");
    const block = formatTranscriptSection("Reviewer", [
      { label: "Main review", sessionId: SESSION_ID, text: huge },
    ]);
    assert.ok(block.endsWith("</details>"));
  });

  it("renders the provider-reported cost next to the session id when available", () => {
    // The provider-reported cost is the number on the check-run title row;
    // surfacing it on the session header lets a reader working from the
    // artifact match it to the per-attempt cost when something looks off.
    const block = formatTranscriptSection("Reviewer", [
      {
        label: "Main review",
        sessionId: SESSION_ID,
        cost: 0.27,
        costLabel: "router cost",
        text: event("result", { subtype: "success" }),
      },
    ]);
    assert.match(block, /\*\*Main review\*\* · session `[^`]+` · router cost \$0\.27/);
  });

  it("labels a client-reported cost as such, and an unlabelled one as plain cost", () => {
    const render = (costLabel) =>
      formatTranscriptSection("Reviewer", [
        { label: "Main review", sessionId: SESSION_ID, cost: 0.1, costLabel, text: event("result", { subtype: "success" }) },
      ]);
    assert.match(render("client-reported cost"), /· client-reported cost \$0\.10/);
    assert.match(render(undefined), /· cost \$0\.10/);
    assert.doesNotMatch(render(undefined), /router cost/);
  });

  it("omits the router-cost fragment when the session has no captured cost", () => {
    const block = formatTranscriptSection("Reviewer", [
      {
        label: "Main review",
        sessionId: SESSION_ID,
        // `cost` deliberately not set on this attempt -- a router telemetry
        // timeout during runClaude shouldn't add a misleading "$NaN" line.
        text: event("result", { subtype: "success" }),
      },
    ]);
    assert.match(block, /session `[^`]+`$/m);
    assert.doesNotMatch(block, /router cost/);
  });

  it("reports a singular 'step' when exactly one event was omitted by truncation", () => {
    // Build a transcript whose summary is just large enough that exactly
    // one trailing line is dropped. The per-session budget is
    // TRANSCRIPT_SECTION_MAX_BYTES (10240), applied to the **summary**
    // (not the raw JSONL), so this fixture must size itself against the
    // projected lines: each `Assistant: xxxx` summary line is ~130 bytes
    // regardless of how much JSON the raw event carried.
    const paddingLine = event("assistant", {
      message: { content: [{ type: "text", text: "x".repeat(120) }] },
    });
    const summaryLine = summarizeTranscript(paddingLine);
    const fitted = [];
    let acc = 0;
    while (true) {
      const nextCost = summaryLine.length + (fitted.length === 0 ? 0 : 1);
      if (acc + nextCost > TRANSCRIPT_SECTION_MAX_BYTES - 1) break;
      fitted.push(paddingLine);
      acc += nextCost;
    }
    fitted.push(paddingLine); // the line that forces truncation
    const block = formatTranscriptSection("Reviewer", [
      { label: "Main review", sessionId: SESSION_ID, text: fitted.join("\n") },
    ]);
    // One event was dropped. The marker must use the singular noun form.
    assert.match(block, /\b1 step omitted\. Full transcript is in the workflow diagnostics artifact\./);
    assert.doesNotMatch(block, /\b1 steps omitted/);
  });

  it("reports 'N steps omitted' when more than one event was truncated away", () => {
    // Same idea: pad against the summary's projected size, then add
    // many more lines that all get dropped. The marker must use the
    // plural noun form because the count exceeds 1.
    const paddingLine = event("assistant", {
      message: { content: [{ type: "text", text: "x".repeat(120) }] },
    });
    const summaryLine = summarizeTranscript(paddingLine);
    const fitted = [];
    let acc = 0;
    while (true) {
      const nextCost = summaryLine.length + (fitted.length === 0 ? 0 : 1);
      if (acc + nextCost > TRANSCRIPT_SECTION_MAX_BYTES - 1) break;
      fitted.push(paddingLine);
      acc += nextCost;
    }
    for (let i = 0; i < 50; i += 1) fitted.push(paddingLine);
    const block = formatTranscriptSection("Reviewer", [
      { label: "Main review", sessionId: SESSION_ID, text: fitted.join("\n") },
    ]);
    assert.match(block, /\b(\d{1,3}(,\d{3})*) steps omitted\. Full transcript is in the workflow diagnostics artifact\./);
    assert.doesNotMatch(block, /\b1 step omitted/);
  });

  it("includes the terminal result line after a truncation marker so a reviewer still sees the outcome", () => {
    // Build a transcript whose summary is long enough to force truncation
    // but whose terminal `Result` event is the natural last line -- that
    // line should appear after the truncation marker so the reader knows
    // whether the attempt ended cleanly before the artifact is consulted.
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      ...Array.from({ length: 200 }, () =>
        event("assistant", {
          message: { content: [{ type: "text", text: "x".repeat(120) }] },
        }),
      ),
      event("result", {
        subtype: "success",
        num_turns: 4,
        usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 0 },
      }),
    ].join("\n");
    const block = formatTranscriptSection("Reviewer", [
      { label: "Main review", sessionId: SESSION_ID, text: stdout },
    ]);
    // Truncation marker is present, with correct pluralization.
    assert.match(block, /steps omitted\. Full transcript is in the workflow diagnostics artifact\./);
    // The result line is rendered AFTER the marker on the same fenced code block.
    const markerIndex = block.indexOf("steps omitted. Full transcript");
    const resultIndex = block.indexOf("Result · success");
    assert.ok(resultIndex > markerIndex && resultIndex !== -1,
      `expected "Result · success" to appear after the truncation marker; marker at ${markerIndex}, result at ${resultIndex}`);
  });

  it("does not double-count the trailing result line in the omit total", () => {
    // The marker reports how many event lines were dropped FROM the
    // preview. When the terminal result line is itself among the dropped
    // lines, the helper re-instates it after the marker and the marker
    // must NOT count it again -- otherwise the same event shows up twice,
    // once silently dropped and once in the omit count.
    //
    // Force that case: a fitted prefix that sits near the cap, followed
    // by a Result event whose summary would push us over, then junk that
    // also drops. After dropping 2 lines (result + junk), the marker
    // must report only 1 step omitted because the result was re-instated.
    // The result line still appears below the marker.
    const paddingLine = event("assistant", {
      message: { content: [{ type: "text", text: "x".repeat(120) }] },
    });
    const summaryLine = summarizeTranscript(paddingLine);
    const fitted = [];
    let acc = 0;
    // Leave exactly enough room for one more summary line of size=summary
    // length -- the next line we add will be the line that pushes us
    // over the cap.
    while (true) {
      const nextCost = summaryLine.length + (fitted.length === 0 ? 0 : 1);
      if (acc + nextCost > TRANSCRIPT_SECTION_MAX_BYTES - summaryLine.length) break;
      fitted.push(paddingLine);
      acc += nextCost;
    }
    const resultLine = event("result", {
      subtype: "success",
      num_turns: 4,
      usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 0 },
    });
    // Two lines past the cap: the result, plus a junk line. Both should
    // be dropped from the preview, but the helper re-adds the result,
    // so the marker counts 1 (the junk), not 2.
    const finalText = [...fitted, resultLine, "z".repeat(12000)].join("\n");
    const block = formatTranscriptSection("Reviewer", [
      { label: "Main review", sessionId: SESSION_ID, text: finalText },
    ]);
    assert.match(block, /\b1 step omitted\. Full transcript is in the workflow diagnostics artifact\./);
    assert.match(block, /Result · success · 4 turns · 5 input · 6 output/);
  });

  it("omits the truncation marker entirely when only the reinstated result line was dropped", () => {
    // Same reinstatement mechanics as the test above, but sized so
    // truncateText() drops EXACTLY the result line and nothing else -- once
    // it's reinstated below the marker, the adjusted omit count is exactly
    // 0. Showing "0 steps omitted" there would contradict the fully-visible
    // transcript right above it, so the marker line must not render at all.
    const paddingLine = event("assistant", {
      message: { content: [{ type: "text", text: "x".repeat(50) }] },
    });
    const paddingBytes = Buffer.byteLength(summarizeTranscript(paddingLine), "utf8");
    const fitted = [];
    let acc = 0;
    // Fill to the full byte budget (not leaving headroom for the result
    // line) so the result line -- summarizeTranscript() renders it longer
    // than one padding line -- is the sole line that overflows.
    while (true) {
      const nextCost = paddingBytes + (fitted.length === 0 ? 0 : 1);
      if (acc + nextCost > TRANSCRIPT_SECTION_MAX_BYTES) break;
      fitted.push(paddingLine);
      acc += nextCost;
    }
    const resultLine = event("result", {
      subtype: "success",
      num_turns: 4,
      usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 0 },
    });
    const finalText = [...fitted, resultLine].join("\n");
    const block = formatTranscriptSection("Reviewer", [
      { label: "Main review", sessionId: SESSION_ID, text: finalText },
    ]);
    assert.doesNotMatch(block, /steps? omitted/);
    assert.match(block, /Result · success · 4 turns · 5 input · 6 output/);
  });
});
