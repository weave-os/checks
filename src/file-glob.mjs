// Per-check file glob matching and unified-diff scoping.
//
// Supported glob syntax: `*` matches within one path segment, `**` matches
// across path separators, `?` matches one non-separator character, and
// `[abc]`/`[!abc]` match one character. Paths and patterns use `/` separators.

function escapeRegex(character) {
  return character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function validateFileGlob(pattern) {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    throw new Error("files must be a non-empty glob pattern");
  }
  if (pattern.startsWith("/") || pattern.includes("\\")) {
    throw new Error("files glob must be repository-relative and use forward slashes");
  }
  if (pattern.split("/").includes("..")) {
    throw new Error("files glob must not escape the repository root");
  }
  let bracketStart = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "[") {
      if (bracketStart !== -1) throw new Error("files glob has an unclosed character class");
      bracketStart = index;
    } else if (pattern[index] === "]") {
      if (bracketStart === -1) throw new Error("files glob has an unmatched ]");
      const contents = pattern.slice(bracketStart + 1, index);
      if (contents === "" || contents === "!") {
        throw new Error("files glob has an empty character class");
      }
      bracketStart = -1;
    }
  }
  if (bracketStart !== -1) throw new Error("files glob has an unclosed character class");
  return pattern;
}

export function compileFileGlob(pattern) {
  validateFileGlob(pattern);
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const close = pattern.indexOf("]", index + 1);
      let chars = pattern.slice(index + 1, close);
      if (chars.startsWith("!")) chars = `^${chars.slice(1)}`;
      source += `[${chars.replaceAll("\\", "\\\\")}]`;
      index = close;
    } else {
      source += escapeRegex(character);
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesFileGlob(filePath, pattern) {
  return compileFileGlob(pattern).test(filePath);
}

function decodeGitQuotedPath(value) {
  if (!value.startsWith('"')) return value;
  let decoded = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const next = value[++index];
    if (/[0-7]/.test(next ?? "")) {
      const octal = `${next}${value[index + 1] ?? ""}${value[index + 2] ?? ""}`;
      decoded += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length - 1;
    } else {
      decoded +=
        { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", "\\": "\\", '"': '"' }[
          next
        ] ?? next;
    }
  }
  return decoded;
}

function pathFromHeader(line, prefix) {
  const decoded = decodeGitQuotedPath(line.trimEnd().slice(prefix.length));
  if (decoded === "/dev/null") return null;
  return decoded.startsWith("a/") || decoded.startsWith("b/") ? decoded.slice(2) : decoded;
}

function pathsFromDiffHeader(line) {
  const raw = line.slice("diff --git ".length);
  if (raw.startsWith('"')) {
    let escaped = false;
    let end = 1;
    for (; end < raw.length; end += 1) {
      if (!escaped && raw[end] === '"') break;
      if (!escaped && raw[end] === "\\") escaped = true;
      else escaped = false;
    }
    const oldPath = decodeGitQuotedPath(raw.slice(0, end + 1));
    const newPath = decodeGitQuotedPath(raw.slice(end + 2));
    return [
      oldPath.startsWith("a/") ? oldPath.slice(2) : oldPath,
      newPath.startsWith("b/") ? newPath.slice(2) : newPath,
    ];
  }
  const separator = raw.indexOf(" b/");
  if (separator === -1) return [null, null];
  return [raw.slice(2, separator), raw.slice(separator + 3)];
}

function diffSections(diff) {
  const sections = [];
  let current = null;
  for (const line of diff.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git ")) {
      if (current !== null) sections.push(current);
      const [oldPath, newPath] = pathsFromDiffHeader(line.trimEnd());
      current = { lines: [line], oldPath, newPath };
    } else if (current !== null) {
      current.lines.push(line);
      if (line.startsWith("rename from ")) current.oldPath = pathFromHeader(line, "rename from ");
      if (line.startsWith("rename to ")) current.newPath = pathFromHeader(line, "rename to ");
      if (line.startsWith("--- ")) current.oldPath = pathFromHeader(line, "--- ");
      if (line.startsWith("+++ ")) current.newPath = pathFromHeader(line, "+++ ");
    }
  }
  if (current !== null) sections.push(current);
  return sections;
}

function statForSection(section, filePath) {
  let additions = 0;
  let deletions = 0;
  for (const line of section.lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  const changes = additions + deletions;
  return `${filePath} | ${changes} ${"+".repeat(additions)}${"-".repeat(deletions)}\n`;
}

export function filterDiffByGlob(diff, pattern) {
  const matcher = compileFileGlob(pattern);
  const sections = diffSections(diff).filter(section => {
    const paths = [section.oldPath, section.newPath].filter(Boolean);
    return paths.some(filePath => matcher.test(filePath));
  });
  const scopedDiff = sections.map(section => section.lines.join("")).join("");
  const stat = sections
    .map(section => statForSection(section, section.newPath ?? section.oldPath))
    .join("");
  return {
    diff: scopedDiff,
    stat,
    paths: sections.map(section => section.newPath ?? section.oldPath),
  };
}
