// Reads the checks directory's ignore file into git pathspec exclusions, so
// the diff every check reviews never contains an ignored path.
//
// readIgnorePathspecs() is the single parser every caller shares: the
// action's PR preparation feeds its output to `git diff`, and the local CLI
// feeds it to the diff it builds from the working tree. Neither reparses the
// file, so CI and a local run can never disagree about what is reviewed. Run
// as a script (`node src/ignore.mjs [checks-dir]`), it prints one pathspec
// per line for shell callers.
//
// A missing ignore file is not an error -- it means review everything. A
// malformed one is: it throws (and the script exits non-zero), failing the
// caller rather than silently dropping the exclusions and reviewing paths the
// repo declared off-limits.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { IGNORE_FILENAME, ignorePathspecs, parseIgnoreList } from "./parse.mjs";

export function readIgnorePathspecs(checksDir) {
  const ignorePath = path.join(checksDir, IGNORE_FILENAME);
  let text;
  try {
    text = fs.readFileSync(ignorePath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`failed to read ${ignorePath}: ${err.message}`);
    }
    text = "";
  }
  try {
    return { ignorePath, pathspecs: ignorePathspecs(parseIgnoreList(text)) };
  } catch (err) {
    throw new Error(`${ignorePath}: ${err.message}`);
  }
}

function main() {
  let result;
  try {
    result = readIgnorePathspecs(process.argv[2] ?? ".weave-checks");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { ignorePath, pathspecs } = result;
  // Diagnostics on stderr: stdout is consumed as the pathspec list itself.
  console.error(
    pathspecs.length === 0 ?
      `no ignored paths in ${ignorePath}`
    : `ignoring ${pathspecs.length} path(s) from ${ignorePath}: ${pathspecs.join(" ")}`,
  );
  for (const pathspec of pathspecs) {
    console.log(pathspec);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
