// Check-file parsing, diff parsing, and the fixed vocabularies Weave Checks
// shares between the GitHub action, the worker, and the local CLI.
//
// Kept as a plain ESM module with no dependencies so the action can run it
// with bare `node` before any install step, and so the parsing rules are unit
// testable (parse.test.mjs) rather than embedded in shell.

// Rolling Claude Code aliases, derived from the check's intelligence tier.
// These names intentionally track the latest model in each family rather
// than pinning check files to a dated or versioned model ID.
export const MODEL_HAIKU = "haiku";
export const MODEL_SONNET = "sonnet";
export const MODEL_OPUS = "opus";

// Routing clusters a check may declare in its `intelligence` frontmatter.
// In Router mode that one value both chooses the model family and becomes the
// X-Weave-Force-Cluster header, preventing a model/cluster mismatch.
export const CLUSTER_LOW = "low";
export const CLUSTER_MEDIUM = "medium";
export const CLUSTER_HIGH = "high";
export const CLUSTER_MAXIMUM = "maximum";
export const SUPPORTED_CLUSTERS = new Set([
  CLUSTER_LOW,
  CLUSTER_MEDIUM,
  CLUSTER_HIGH,
  CLUSTER_MAXIMUM,
]);
export const SUPPORTED_INTELLIGENCE = SUPPORTED_CLUSTERS;

// Every review invocation chooses its rolling alias from this mapping. The
// Router still uses the corresponding intelligence value as its force-cluster
// signal and may serve any currently eligible model within that cluster.
export const MODEL_FOR_INTELLIGENCE = Object.freeze({
  [CLUSTER_LOW]: MODEL_HAIKU,
  [CLUSTER_MEDIUM]: MODEL_SONNET,
  [CLUSTER_HIGH]: MODEL_OPUS,
  [CLUSTER_MAXIMUM]: MODEL_OPUS,
});

export function modelForIntelligence(intelligence) {
  return SUPPORTED_INTELLIGENCE.has(intelligence)
    ? MODEL_FOR_INTELLIGENCE[intelligence]
    : null;
}

// Files in a checks directory that are documentation, not checks, unless a
// policy names its own (`docFiles`).
export const DEFAULT_DOC_FILES = new Set(["README.md"]);

// Validation policy for a check's single `intelligence` frontmatter value.
// Both providers accept the same four tier names; callers may restrict that
// set for a particular repository. The tier is required for every provider.
export const WEAVE_POLICY = Object.freeze({
  allowedIntelligence: SUPPORTED_INTELLIGENCE,
  docFiles: DEFAULT_DOC_FILES,
});

export const GENERIC_POLICY = Object.freeze({
  allowedIntelligence: SUPPORTED_INTELLIGENCE,
  docFiles: DEFAULT_DOC_FILES,
});

// A check's slug (its filename without `.md`) is written into every comment
// marker and matched back by history.mjs's marker regex. A slug outside this
// vocabulary would post comments the next run can never recognize.
export const SLUG_PATTERN = /^[a-z0-9-]+$/;

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

// Frontmatter is a fixed three-key contract (name, description, and
// intelligence), so a line-oriented reader is enough -- no YAML dependency,
// and anything that doesn't fit the contract is rejected instead of
// half-understood.
// Keys the contract permits in a check's frontmatter. Anything else is
// rejected so a misspelled or made-up field fails discovery loudly.
const FRONTMATTER_KEYS = new Set(["name", "description", "intelligence"]);

function parseFrontmatter(text) {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    throw new Error("missing frontmatter block (file must start with ---)");
  }

  const fields = new Map();
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      throw new Error(`malformed frontmatter line: ${rawLine}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "") {
      throw new Error(`malformed frontmatter line: ${rawLine}`);
    }
    if (!FRONTMATTER_KEYS.has(key)) {
      throw new Error(`unknown frontmatter key "${key}" (allowed: ${[...FRONTMATTER_KEYS].sort().join(", ")})`);
    }
    if (fields.has(key)) {
      throw new Error(`duplicate frontmatter key: ${key}`);
    }
    fields.set(key, value);
  }

  return { fields, body: text.slice(match[0].length) };
}

export function slugFromPath(filePath) {
  return filePath.slice(filePath.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

export function isCheckFile(filePath, docFiles = DEFAULT_DOC_FILES) {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  return base.endsWith(".md") && !docFiles.has(base);
}

// Optional file inside the checks directory listing paths the review never
// sees. Excluded from the diff itself rather than from each check's prompt, so
// the exclusion holds for every check at once and costs no tokens to enforce.
export const IGNORE_FILENAME = ".ignore";

// Parses the ignore file into bare git pathspecs: one per line, `#` comments
// and blank lines skipped, trailing slashes trimmed (git matches a directory
// and everything under it either way).
//
// Wildcards must sit below a literal directory prefix. Git pathspecs are
// fnmatch-matched even without `:(glob)` magic, so unanchored patterns such as
// `*`, `*.go`, `?*`, `[a-z]*`, and root-relative `./*` can exclude the whole
// tree and make an empty diff indistinguishable from a clean review. An
// anchored wildcard can only exclude paths beneath its literal prefix,
// preserving the same boundary as a literal directory entry. Without
// `:(glob)`, `*` crosses `/`, so an anchored pattern intentionally covers
// matching files at every depth in that subtree.
//
// The same boundary rejects a pattern that names the whole tree (`.`, `/`),
// escapes it (`..`), or uses backslashes as separators or escapes.
export function parseIgnoreList(text) {
  const patterns = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const pattern = line.replace(/\/+$/, "");
    if (pattern === "" || pattern === ".") {
      throw new Error(`"${line}" would exclude the entire repository`);
    }
    if (pattern.startsWith("/")) {
      throw new Error(`"${line}" must be relative to the repository root`);
    }
    if (pattern.split("/").includes("..")) {
      throw new Error(`"${line}" escapes the repository root`);
    }
    if (pattern.includes("\\")) {
      throw new Error(`"${line}" must use forward slashes without escapes`);
    }
    const wildcard = /[*?[\]]/.exec(pattern);
    if (wildcard !== null) {
      const prefix = pattern.slice(0, wildcard.index);
      // `.` and `./` name the repository root, so `./*` is still an
      // unanchored wildcard even though the prefix contains a slash.
      const prefixSegments = prefix.split("/").filter((segment) => segment !== "" && segment !== ".");
      if (prefixSegments.length === 0 || !prefix.includes("/")) {
        throw new Error(
          `"${line}" contains an unanchored wildcard: wildcards require a literal directory prefix`,
        );
      }
    }
    // `:(exclude)` is the only pathspec magic this file's output carries. A
    // pattern that opens its own magic would be nested inside that one, where
    // git reads it literally rather than honouring it -- but a leading `:` is
    // still a sign the author expected pathspec syntax to work here, so reject
    // it rather than silently excluding a path named `:(glob)**`.
    if (pattern.startsWith(":")) {
      throw new Error(`"${line}" must be a plain path, not a git pathspec`);
    }
    patterns.push(pattern);
  }
  return patterns;
}

// git pathspec arguments for parseIgnoreList()'s output. Callers append these
// after a `-- .` pathspec, which is what narrows the diff to "the whole tree
// except these".
export function ignorePathspecs(patterns) {
  return patterns.map((pattern) => `:(exclude)${pattern}`);
}

// Parses one check file into a matrix entry. Throws with the offending path so
// a bad check fails discovery loudly instead of being skipped.
//
// The source frontmatter has one tier field, `intelligence`. The normalized
// entry carries `model` (its rolling CLI alias) and `cluster` (the same tier,
// for Router routing) so the runner and provider boundary stay explicit.
export function parseCheckFile(text, filePath, policy = WEAVE_POLICY) {
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (err) {
    throw new Error(`${filePath}: ${err.message}`);
  }

  const slug = slugFromPath(filePath);
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `${filePath}: check file name "${slug}" must use only lowercase letters, digits, and hyphens`,
    );
  }

  const { fields, body } = parsed;
  for (const key of ["name", "description", "intelligence"]) {
    const value = fields.get(key);
    if (value === undefined || value === "") {
      throw new Error(`${filePath}: frontmatter is missing required key "${key}"`);
    }
  }

  const intelligence = fields.get("intelligence");
  const allowed = policy.allowedIntelligence ?? SUPPORTED_INTELLIGENCE;
  if (!SUPPORTED_INTELLIGENCE.has(intelligence) || !allowed.has(intelligence)) {
    throw new Error(
      `${filePath}: unsupported intelligence "${intelligence}" (allowed: ${[...allowed].sort().join(", ")})`,
    );
  }

  if (body.trim() === "") {
    throw new Error(`${filePath}: check body is empty`);
  }

  return {
    slug,
    name: fields.get("name"),
    description: fields.get("description"),
    intelligence,
    model: modelForIntelligence(intelligence),
    cluster: intelligence,
    path: filePath,
    body,
  };
}

// Builds the job matrix. Display names must be unique: the check-run name is
// derived from them, and two runs sharing a name would overwrite each other's
// status on the PR.
//
// `validateCheck`, when given, is a provider's own requirement on a parsed
// check (Weave Router rejects a check with no cluster); it returns an error
// string or null.
export function buildMatrix(files, policy = WEAVE_POLICY, validateCheck = null) {
  const checks = files
    .filter((file) => isCheckFile(file.path, policy.docFiles ?? DEFAULT_DOC_FILES))
    .map((file) => parseCheckFile(file.text, file.path, policy))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const seen = new Map();
  for (const check of checks) {
    const existing = seen.get(check.name);
    if (existing !== undefined) {
      throw new Error(
        `duplicate check name "${check.name}" in ${existing} and ${check.path}`,
      );
    }
    seen.set(check.name, check.path);
    const providerError = validateCheck?.(check) ?? null;
    if (providerError !== null) {
      throw new Error(`${check.path}: ${providerError}`);
    }
  }

  // `body` is read from disk by the runner, not carried through the matrix --
  // GitHub caps matrix payload size and check bodies are large.
  return checks.map(({ body: _body, ...entry }) => entry);
}

// Builds a policy from caller-supplied intelligence values (the action's
// input and CLI's flag). An empty or absent list accepts all four tiers.
export function policyFrom({ allowedIntelligence = [], docFiles = [] } = {}) {
  const unknown = allowedIntelligence.filter((value) => !SUPPORTED_INTELLIGENCE.has(value));
  if (unknown.length > 0) {
    throw new Error(
      `unsupported intelligence in allowlist: ${unknown.join(", ")} (allowed: ${[...SUPPORTED_INTELLIGENCE].sort().join(", ")})`,
    );
  }
  return Object.freeze({
    allowedIntelligence:
      allowedIntelligence.length === 0
        ? SUPPORTED_INTELLIGENCE
        : new Set(allowedIntelligence),
    docFiles: docFiles.length === 0 ? DEFAULT_DOC_FILES : new Set(docFiles),
  });
}

// JSON Schema handed to `claude -p --json-schema`. additionalProperties:false
// matters: a permissive schema lets the CLI smuggle in non-conforming keys and
// dodge required-field validation. Values must be exactly string/integer; all
// returned fields stay narrow.
export const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    reason: { type: "string" },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          start_line: { type: "integer" },
          line: { type: "integer" },
          replacement: { type: "string" },
          comment: { type: "string" },
        },
        required: ["file", "line", "comment"],
      },
    },
  },
  required: ["verdict", "reason"],
};

// Schema for the separate resolution judge (see worker.mjs). This agent has
// exactly one job: decide whether each previous open finding remains
// applicable at the PR's current HEAD. It returns an explicit row for every
// thread, with evidence required even when it resolves one; worker.mjs then
// validates resolved rows against the actual open set before touching GitHub.
export const RESOLUTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    resolutions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          thread_id: { type: "string" },
          resolved: { type: "boolean" },
          evidence: { type: "string" },
        },
        required: ["thread_id", "resolved", "evidence"],
      },
    },
  },
  required: ["resolutions"],
};

// Schema for the cheap second-pass duplicate judge (see worker.mjs
// judgeDuplicates). Kept separate from RESULT_SCHEMA: it answers a narrower
// question and is run on a cheap fixed model regardless of the check's own.
export const DEDUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    duplicate_indices: { type: "array", items: { type: "integer" } },
  },
  required: ["duplicate_indices"],
};

// Parses `git diff -U0` output into the set of line numbers actually added or
// modified per file. Review comments may only anchor to these lines: GitHub
// rejects a comment outside the diff hunks with a 422, which would turn an
// otherwise-valid FAIL into an operational error.
export function parseAddedLines(diffText) {
  const byFile = new Map();
  let current = null;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      current = line.slice("+++ b/".length).trim();
      if (!byFile.has(current)) {
        byFile.set(current, new Set());
      }
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      current = null;
      continue;
    }
    if (!line.startsWith("@@") || current === null) {
      continue;
    }
    // @@ -old,oldCount +new,newCount @@
    const hunk = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (hunk === null) {
      continue;
    }
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = byFile.get(current);
    for (let n = start; n < start + count; n += 1) {
      lines.add(n);
    }
  }

  return byFile;
}

// Validates the agent's structured output against the diff. Returns the
// verdict plus the findings safe to post, findings dropped because their
// anchor is invalid, and findings reduced to prose because only their range
// or replacement is unsafe. The latter remains actionable instead of turning
// a correct diagnosis into an operational miss.
export function validateResult(result, addedLines) {
  if (result === null || typeof result !== "object") {
    throw new Error("result is not an object");
  }
  if (result.verdict !== "PASS" && result.verdict !== "FAIL") {
    throw new Error(`invalid verdict: ${JSON.stringify(result.verdict)}`);
  }
  if (typeof result.reason !== "string" || result.reason.trim() === "") {
    throw new Error("result is missing a reason");
  }

  const accepted = [];
  const proseFallbacks = [];
  const rejected = [];

  for (const suggestion of result.suggestions ?? []) {
    const lines = addedLines.get(suggestion.file);
    if (lines === undefined) {
      rejected.push({ suggestion, why: `file not in diff: ${suggestion.file}` });
      continue;
    }

    const end = suggestion.line;
    const start = suggestion.start_line ?? end;
    if (!Number.isInteger(end)) {
      rejected.push({ suggestion, why: `invalid line range ${start}-${end}` });
      continue;
    }
    if (!lines.has(end)) {
      rejected.push({
        suggestion,
        why: `anchor line ${end} of ${suggestion.file} is not in the diff`,
      });
      continue;
    }
    if (typeof suggestion.comment !== "string" || suggestion.comment.trim() === "") {
      rejected.push({ suggestion, why: "empty comment" });
      continue;
    }

    // Every line in the range must be part of the diff, or GitHub 422s the
    // whole review. The end line is independently validated above and is a
    // safe single-line anchor, so a bad start/range drops only the replacement
    // block and preserves the diagnosis as prose on that anchor.
    let rangeIsValid = Number.isInteger(start) && start <= end;
    if (rangeIsValid) {
      for (let n = start; n <= end; n += 1) {
        if (!lines.has(n)) {
          rangeIsValid = false;
          break;
        }
      }
    }
    if (!rangeIsValid) {
      proseFallbacks.push({
        suggestion,
        why: `range ${start}-${end} of ${suggestion.file} is not fully in the diff; posted prose at line ${end} without a replacement`,
      });
      accepted.push({
        file: suggestion.file,
        start_line: end,
        line: end,
        comment: suggestion.comment,
      });
      continue;
    }

    accepted.push({ ...suggestion, start_line: start, line: end });
  }

  return {
    verdict: result.verdict,
    reason: result.reason,
    accepted,
    proseFallbacks,
    rejected,
  };
}

// Formats a suggestion as a GitHub review comment. A `replacement` becomes a
// committable ```suggestion block; without one the comment is advisory prose.
export function formatReviewComment(suggestion) {
  const body =
    suggestion.replacement === undefined || suggestion.replacement === null
      ? suggestion.comment
      : `${suggestion.comment}\n\n\`\`\`suggestion\n${suggestion.replacement}\n\`\`\``;

  const comment = { path: suggestion.file, line: suggestion.line, body };
  if (suggestion.start_line < suggestion.line) {
    comment.start_line = suggestion.start_line;
  }
  return comment;
}

// Fixed sets used across worker.mjs, so the magic strings that travel to the
// GitHub API and into check-run summary tables are derived from one place
// rather than scattered as string literals through the worker.
export const STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETE: "complete",
});

// Why the coordinator stopped, written to the workflow's COMPLETE_PATH marker
// file. Distinct from STATUS (one check's lifecycle) and CHECK_RUN_STATUS (the
// value GitHub's API takes): this vocabulary describes the whole run's exit.
//
// The workflow's fallback step only tests the file for existence, never its
// contents, so these strings are diagnostics for whoever opens the artifact --
// but they are a closed set all the same, and naming them keeps a typo from
// inventing a fourth outcome nobody can grep for.
export const RUN_MARKER = Object.freeze({
  COMPLETED: "completed",
  CRASHED: "crashed",
  NO_REVIEWABLE_CHANGES: "no-reviewable-changes",
});

export const OUTCOME = Object.freeze({
  NEUTRAL: "neutral",
  PASS: "pass",
  FAIL: "fail",
});

// The outcome names published in JSON results and action outputs. Internally
// a FAIL verdict is OUTCOME.FAIL, but it never publishes as a failed check
// (see worker.mjs's header), so the public vocabulary says what it is: the
// check flagged something.
export const PUBLIC_OUTCOME = Object.freeze({
  [OUTCOME.PASS]: "pass",
  [OUTCOME.FAIL]: "flagged",
  [OUTCOME.NEUTRAL]: "neutral",
});

export function publicOutcome(outcome) {
  return PUBLIC_OUTCOME[outcome] ?? PUBLIC_OUTCOME[OUTCOME.NEUTRAL];
}

// "Every check on this sha finished a review." Written by the worker onto the
// aggregate check run's external_id, read back by the workflow before it
// narrows the next run's diff to `<that sha>..HEAD`.
//
// It cannot be inferred from the check run's conclusion. The PASS-or-neutral
// contract (see worker.mjs's header) publishes a FAIL verdict and a crashed
// CLI as the same `neutral`, so the conclusion cannot tell "reviewed and found
// something" from "never ran" -- and narrowing the diff past a range a check
// never read would skip it permanently. OUTCOME does carry the distinction:
// PASS and FAIL are both completed reviews, NEUTRAL is the operational miss.
//
// The sha rides inside the marker so the reader verifies identity rather than
// trusting that it looked the value up on the right commit.
const REVIEWED_MARKER_PREFIX = "reviewed:";

export function formatReviewedMarker(sha) {
  return `${REVIEWED_MARKER_PREFIX}${sha}`;
}

// True when every check state completed a review, whatever it concluded.
// Empty is false on purpose: "no checks ran" is the coordinator-crashed case,
// which is precisely what must not advance the base.
export function everyCheckReviewed(states) {
  if (states.length === 0) return false;
  return states.every(
    (state) => state.outcome === OUTCOME.PASS || state.outcome === OUTCOME.FAIL,
  );
}

// Closed set of `cli.subtype` values the Claude CLI emits on a terminal
// `result` event. The only one we treat as "the agent finished cleanly" is
// SUCCESS; every other value (error_during_execution, error_max_turns, ...)
// is a definite miss. Named so callers cannot typo "succes" into a silent
// false-negative.
export const CLI_RESULT_SUBTYPE = Object.freeze({
  SUCCESS: "success",
});

// Closed set of interpretResult() outcomes. OK means the verdict object is
// ready to validate; RETRYABLE means the CLI succeeded but skipped
// structured output (worth one more ask); DEFINITE is a crash or parse
// error that would just repeat.
export const INTERPRET_OUTCOME = Object.freeze({
  OK: "ok",
  RETRYABLE: "retryable",
  DEFINITE: "definite",
});

export const GITHUB_CONCLUSION = Object.freeze({
  SUCCESS: "success",
  NEUTRAL: "neutral",
});

// HTTP verbs the worker's GitHub REST wrapper actually sends. Kept next to
// GITHUB_CONCLUSION so callers (worker.mjs's github()) restate nothing as
// raw strings -- a typo "GETT" would silently 404 instead of failing loudly.
//
// GITHUB_CONCLUSION deliberate singles: the check-run contract is now
// `success` or `neutral` only. A FAIL verdict, an operational miss, or
// a coordinator crash all publish as `neutral`. The const set is
// deliberately a frozen pair so adding `FAILURE` here won't sneak the
// red conclusion back in -- the worker reads `SUCCESS`/`NEUTRAL` and
// maps every `!= SUCCESS` outcome to `NEUTRAL`.
export const HTTP_METHOD = Object.freeze({
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
});

// States review can be in. The set is closed (GitHub rejects any value it
// doesn't recognize), so a raw-string switch would silently route unknown
// values into the default branch instead of failing closed. REVIEW_STATE
// names what the API actually returns; REVIEW_EVENT names the user-facing
// `event` field on the POST/PUT review body and carries the *values sent*
// half of the same vocabulary (DISMISS is POST/PUT only; COMMENT/APPROVED/
// REQUEST_CHANGES are POST only).
export const REVIEW_STATE = Object.freeze({
  APPROVED: "APPROVED",
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  COMMENTED: "COMMENTED",
  DISMISSED: "DISMISSED",
});

export const REVIEW_EVENT = Object.freeze({
  APPROVE: "APPROVE",
  REQUEST_CHANGES: "REQUEST_CHANGES",
  COMMENT: "COMMENT",
  DISMISS: "DISMISS",
});

// Check-run lifecycle as posted on `status` / read back from completed runs.
// Distinct from STATUS (the worker's own internal lifecycle); CHECK_RUN_STATUS
// is the value that travels on the GitHub API and into check-run summaries.
export const CHECK_RUN_STATUS = Object.freeze({
  QUEUED: "queued",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
});

// Single source of truth for the verdict values the agents return in the
// RESULT_SCHEMA contract. JSON Schema already enforces this enum, but the
// caller side (worker.mjs) re-branches on the same strings to pick the
// OUTCOME -- a typo here would silently flip a FAIL into a PASS at runtime.
export const VERDICT = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
});

// Names the duplicate judge explicitly. It is a narrow yes/no judgment and
// never inherits a check's intelligence tier, so it uses the rolling Haiku
// alias unless action/CLI configuration overrides it.
export const DEDUP_MODEL = MODEL_HAIKU;
// Same posture for routing: dedup always uses the lowest intelligence tier,
// regardless of the check under judgment.
export const DEDUP_CLUSTER = CLUSTER_LOW;

// Parses `cli.structured_output` into a useable object, JSON-parsing it when
// the CLI returned it as a string. Throws on invalid JSON so each caller
// wraps it in its own try/catch and decides what to do on failure (the
// duplicate judge fails open; the main agent and the resolution judge both
// fail closed).
export function parseStructuredOutput(cli) {
  const out = cli.structured_output;
  return typeof out === "string" ? JSON.parse(out) : out;
}

// Reads the CLI JSON the agent wrapper writes and decides whether the main
// review agent produced a usable structured result, a recoverable miss worth
// retrying, or a hard non-result. Split out from worker.mjs's normalize() so
// the retry semantics can be unit tested without standing up the full Claude
// invocation harness.
//
//   outcome: INTERPRET_OUTCOME.OK        -> value is the result object ready for validateResult
//   outcome: INTERPRET_OUTCOME.RETRYABLE -> value is {error, rawResult?}; CLI succeeded but the
//                          model skipped the structured-output tool (subtype=success
//                          with only prose). The session was healthy, so a second
//                          attempt usually succeeds outright -- worker.mjs retries once.
//   outcome: INTERPRET_OUTCOME.DEFINITE  -> value is {error, rawResult?}; CLI crashed or the schema
//                          was violated. Retrying would repeat the same miss.
//
// The verdict-regex fallback serves the rare model that does emit a
// `{"verdict":"FAIL",...}` literal inside its prose: treat that as a normal
// `ok` rather than a retry, since the model's intent is unambiguous. The
// `rawResult` field rides along on the non-ok branches so a human reading
// the diagnostic artifact can still see what the model said.
const VERDICT_START_REGEX = /\{\s*"verdict":\s*"(PASS|FAIL)"/;

// Finds the `{"verdict":...}` object starting at `startIndex` and returns its
// full, balanced text -- scanning brace depth (and skipping over braces
// inside quoted strings) rather than stopping at the first `}`, which would
// truncate a pretty-printed object or one whose `reason` string itself
// contains a `}`. Returns null if the object never closes.
function extractBalancedJsonObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

export function interpretResult(cli) {
  if (!cli || typeof cli !== "object" || cli.is_error === true || cli.subtype !== CLI_RESULT_SUBTYPE.SUCCESS) {
    return { outcome: INTERPRET_OUTCOME.DEFINITE, value: { error: `Claude reported ${cli?.subtype ?? cli?.api_error_status ?? "an error"}` } };
  }

  let resultObject;
  try {
    resultObject = parseStructuredOutput(cli);
  } catch (error) {
    return { outcome: INTERPRET_OUTCOME.DEFINITE, value: { error: `structured_output was a string but was not valid JSON: ${error.message}` } };
  }

  if (resultObject && typeof resultObject === "object" && !Array.isArray(resultObject)) {
    return { outcome: INTERPRET_OUTCOME.OK, value: resultObject };
  }

  const matchedStart = typeof cli.result === "string" ? cli.result.match(VERDICT_START_REGEX) : null;
  const matched = matchedStart !== null ? extractBalancedJsonObject(cli.result, matchedStart.index) : null;
  if (matched !== null) {
    try {
      return { outcome: INTERPRET_OUTCOME.OK, value: JSON.parse(matched) };
    } catch {
      return {
        outcome: INTERPRET_OUTCOME.RETRYABLE,
        value: {
          error: "structured_output was missing and the prose result did not contain a verdict JSON object",
          rawResult: cli.result,
        },
      };
    }
  }

  return {
    outcome: INTERPRET_OUTCOME.RETRYABLE,
    value: {
      error: "structured_output was missing and the prose result had no verdict",
      rawResult: cli.result,
    },
  };
}
