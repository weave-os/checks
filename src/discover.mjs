// Discovers .weave-checks/*.md and emits the check list for weave-checks.yml.
//
// Usage: node .github/checks/discover.mjs <checks-dir>
//
// Writes `matrix` and `count` to $GITHUB_OUTPUT (or stdout when run locally).
// Exits non-zero on any malformed check so discovery fails loudly rather than
// silently running a smaller set of checks than the repo declares.

import fs from "node:fs";
import path from "node:path";

import { buildMatrix, isCheckFile } from "./parse.mjs";

const checksDir = process.argv[2] ?? ".weave-checks";

let entries;
try {
  entries = fs.readdirSync(checksDir);
} catch (err) {
  console.error(`failed to read ${checksDir}: ${err.message}`);
  process.exit(1);
}

const files = entries
  .filter((name) => isCheckFile(name))
  .map((name) => ({
    path: `${checksDir}/${name}`,
    text: fs.readFileSync(path.join(checksDir, name), "utf8"),
  }));

let matrix;
try {
  matrix = buildMatrix(files);
} catch (err) {
  console.error(`check discovery failed: ${err.message}`);
  process.exit(1);
}

if (matrix.length === 0) {
  console.error(`no checks found in ${checksDir}`);
  process.exit(1);
}

for (const entry of matrix) {
  console.error(`discovered ${entry.slug}: "${entry.name}" (${entry.model}, ${entry.cluster})`);
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
