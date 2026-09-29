// Discovers <checks-dir>/*.md and builds the check matrix.
//
// discoverChecks() is what the CLI's `list`/`prepare`/`run` share. Run as a
// script (`node src/discover.mjs <checks-dir>`), it writes `matrix` and
// `count` to $GITHUB_OUTPUT (or stdout) with today's strict Weave policy.
// Either way a malformed check throws, so discovery fails loudly rather than
// silently running a smaller set of checks than the repo declares.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WEAVE_POLICY, buildMatrix, isCheckFile } from "./parse.mjs";

export const DEFAULT_CHECKS_DIR = ".weave-checks";

// Reads and validates every check in `checksDir`, resolved against `repoDir`.
// `checksDir` is recorded in each entry's `path` as given, so a repo-relative
// directory yields repo-relative paths the runner can join onto the repo root.
export function discoverChecks(
  checksDir,
  { repoDir = ".", policy = WEAVE_POLICY } = {},
) {
  const dir = path.resolve(repoDir, checksDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    throw new Error(`failed to read ${checksDir}: ${err.message}`);
  }
  const files = entries
    .filter((name) => isCheckFile(name, policy.docFiles))
    .sort()
    .map((name) => ({
      path: path.posix.join(checksDir.split(path.sep).join("/"), name),
      text: fs.readFileSync(path.join(dir, name), "utf8"),
    }));
  const matrix = buildMatrix(files, policy);
  if (matrix.length === 0) {
    throw new Error(`no checks found in ${checksDir}`);
  }
  return matrix;
}

// One human-readable line per check, shared by the script below and the CLI.
export function describeEntry(entry) {
  return `${entry.slug}: "${entry.name}" (intelligence ${entry.intelligence} → ${entry.model})`;
}

function main() {
  const checksDir = process.argv[2] ?? DEFAULT_CHECKS_DIR;
  let matrix;
  try {
    matrix = discoverChecks(checksDir);
  } catch (err) {
    console.error(`check discovery failed: ${err.message}`);
    process.exit(1);
  }
  for (const entry of matrix) {
    console.error(`discovered ${describeEntry(entry)}`);
  }
  const output = [
    `matrix=${JSON.stringify({ check: matrix })}`,
    `count=${matrix.length}`,
  ].join("\n");
  if (process.env.GITHUB_OUTPUT === undefined) {
    console.log(output);
  } else {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
