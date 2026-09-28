// Prints the git pathspec exclusions for the checks directory's ignore file,
// one per line, so the diff every check reviews never contains an ignored path.
//
// Usage: node .github/checks/ignore.mjs [checks-dir]
//
// The single parser both callers share: .github/workflows/weave-checks.yml
// feeds the output to `git diff`, and `wv checks run`
// (cli/wv/commands/checks.py) feeds it to the diff it builds from the working
// tree. Neither reparses the file, so CI and a local run can never disagree
// about what is reviewed.
//
// A missing ignore file is not an error -- it means review everything. A
// malformed one is: exiting non-zero fails the caller rather than silently
// dropping the exclusions and reviewing paths the repo declared off-limits.

import fs from "node:fs";
import path from "node:path";

import { IGNORE_FILENAME, ignorePathspecs, parseIgnoreList } from "./parse.mjs";

const checksDir = process.argv[2] ?? ".weave-checks";
const ignorePath = path.join(checksDir, IGNORE_FILENAME);

let text;
try {
  text = fs.readFileSync(ignorePath, "utf8");
} catch (err) {
  if (err.code !== "ENOENT") {
    console.error(`failed to read ${ignorePath}: ${err.message}`);
    process.exit(1);
  }
  text = "";
}

let pathspecs;
try {
  pathspecs = ignorePathspecs(parseIgnoreList(text));
} catch (err) {
  console.error(`${ignorePath}: ${err.message}`);
  process.exit(1);
}

// Diagnostics on stderr: stdout is consumed as the pathspec list itself.
console.error(
  pathspecs.length === 0
    ? `no ignored paths in ${ignorePath}`
    : `ignoring ${pathspecs.length} path(s) from ${ignorePath}: ${pathspecs.join(" ")}`,
);

for (const pathspec of pathspecs) {
  console.log(pathspec);
}
