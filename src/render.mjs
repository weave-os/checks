// Renders a local run's summary (local.mjs's output contract) for a terminal
// or as Markdown. Pure string functions, so the output is testable without a
// TTY.

import { formatDuration, formatUsd } from "./runner.mjs";

const ANSI = {
  bold: [1, 22],
  dim: [2, 22],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
};

function styler(color) {
  return (text, ...styles) =>
    color ?
      styles.reduce(
        (out, style) => `\u001b[${ANSI[style][0]}m${out}\u001b[${ANSI[style][1]}m`,
        text,
      )
    : text;
}

function headline(summary, name) {
  const { totals } = summary;
  return (
    `${name} — ${totals.pass} passed · ${totals.flagged} flagged · ${totals.neutral} neutral — ` +
    `${formatUsd(totals.cost)} total (${summary.costLabel}), ${formatDuration(totals.durationMs)}`
  );
}

export function renderText(summary, { color = false, name = "Weave Checks" } = {}) {
  const style = styler(color);
  const label = outcome =>
    outcome === "pass" ? style("✓ pass", "green")
    : outcome === "flagged" ? style("✗ flagged", "yellow")
    : style("· neutral", "dim");
  const width = Math.max(5, ...summary.checks.map(check => check.name.length));
  const lines = ["", style(headline(summary, name), "bold"), ""];
  for (const check of summary.checks) {
    lines.push(
      `  ${check.name.padEnd(width)}  ${label(check.outcome)}  ${formatUsd(check.cost)}  ${formatDuration(check.durationMs)}`,
    );
  }
  for (const check of summary.checks) {
    if (check.outcome === "pass") continue;
    lines.push("", style(check.name, "bold"));
    if (check.outcome === "neutral") {
      lines.push(`  ${style("error:", "dim")} ${check.error}`);
      continue;
    }
    lines.push(`  ${check.reason}`);
    for (const suggestion of check.suggestions) {
      lines.push(
        `  ${style(`${suggestion.file}:${suggestion.line}`, "cyan", "bold")} ${suggestion.comment}`,
      );
      if (suggestion.replacement !== null) {
        for (const line of suggestion.replacement.split("\n"))
          lines.push(`      ${style(line, "green")}`);
      }
    }
    for (const entry of check.rejected) lines.push(`  ${style("dropped:", "dim")} ${entry.why}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderMarkdown(summary, { name = "Weave Checks" } = {}) {
  const cell = value =>
    String(value ?? "")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
  const lines = [
    headline(summary, `**${name}**`),
    "",
    "| Check | Outcome | Cost | Duration | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...summary.checks.map(
      check =>
        `| ${cell(check.name)} | ${check.outcome} | ${formatUsd(check.cost)} | ${formatDuration(check.durationMs)} | ${cell(check.outcome === "neutral" ? check.error : check.reason)} |`,
    ),
  ];
  for (const check of summary.checks) {
    if (check.suggestions.length === 0) continue;
    lines.push("", `### ${check.name}`);
    for (const suggestion of check.suggestions) {
      lines.push("", `- \`${suggestion.file}:${suggestion.line}\` — ${suggestion.comment}`);
      if (suggestion.replacement !== null) {
        lines.push(
          "",
          "  ```suggestion",
          ...suggestion.replacement.split("\n").map(line => `  ${line}`),
          "  ```",
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
