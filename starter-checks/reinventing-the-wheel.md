---
name: Reinventing the Wheel
description: Flags custom implementations of well-solved problems where established libraries or platform APIs should be used instead
intelligence: medium
---

Review the changed lines for **reinventing the wheel** — custom implementations of functionality that has robust, well-tested solutions available as standard libraries, language built-ins, or packages already in the dependency tree. Apply this to the languages and layers represented by the changed code.

This check is inspired by [Shriram Krishnamurthi's analysis](https://gist.github.com/shriram/064756c61ca98774c2a509aa3893d941) of AI-generated code that hand-rolls CSV parsers, normalization logic, and data formatting instead of using standard tools.

## Context

AI-generated code defaults to writing everything from scratch. It doesn't know what's already in Go's standard library, Node built-ins, or the project's existing dependencies. The result: custom implementations that miss edge cases the established solutions handle — encoding quirks, locale differences, timezone bugs, security gotchas.

## What to Check

### 1. Custom Parsing (CSV, JSON, YAML, TOML, XML, URL, Markdown)

Hand-written parsers for structured data formats. These always miss edge cases (quoted fields in CSV, escape sequences, Unicode, BOM markers).

**BAD (TypeScript):**

```typescript
function parseCsv(text: string): string[][] {
  return text.split("\n").map(line => line.split(","));
  // Breaks on: quoted fields, commas in values, newlines in values, empty lines
}

function parseQueryString(url: string): Record<string, string> {
  return url
    .split("?")[1]
    ?.split("&")
    .reduce(
      (acc, pair) => {
        const [key, value] = pair.split("=");
        acc[key] = decodeURIComponent(value);
        return acc;
      },
      {} as Record<string, string>,
    );
  // Breaks on: encoded &, multiple values for same key, no value, fragment
}
```

**BAD (Go):**

```go
func parseCSV(text string) [][]string {
 var rows [][]string
 for _, line := range strings.Split(text, "\n") {
  rows = append(rows, strings.Split(line, ","))
 }
 return rows
 // Breaks on: quoted fields, commas in values, newlines in values, empty lines
}

func parseQueryString(rawURL string) map[string]string {
 result := make(map[string]string)
 parts := strings.SplitN(rawURL, "?", 2)
 if len(parts) < 2 {
  return result
 }
 for _, pair := range strings.Split(parts[1], "&") {
  kv := strings.SplitN(pair, "=", 2)
  result[kv[0]] = kv[1]
 }
 return result
 // Breaks on: encoded values, multiple values for same key, fragment
}
```

**GOOD (TypeScript):**

```typescript
// If a CSV package (e.g. csv-parse) is already in deps, use it:
import { parse } from "csv-parse/sync";
const rows = parse(text, { columns: true });

const url = new URL(rawUrl);
const value = url.searchParams.get("key");
```

**GOOD (Go):**

```go
r := csv.NewReader(strings.NewReader(text))
rows, err := r.ReadAll()

u, err := url.Parse(rawURL)
value := u.Query().Get("key")
```

**What to look for:** `strings.Split()` chains on structured data; regex-based parsers for known formats; any function named `parse*` or `decode*` that doesn't use `encoding/csv`, `encoding/json`, `encoding/xml`, `net/url`, or similar stdlib packages.

### 2. Custom Date/Time Manipulation

Hand-rolling date arithmetic, timezone conversions, or formatting. JavaScript's Date is notoriously tricky and `date-fns` handles edge cases. Go's `time` package is solid but still easy to misuse (manual second arithmetic instead of `AddDate`, wrong format strings).

**BAD (TypeScript):**

```typescript
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days); // Breaks across DST transitions
  return result;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  // No zero-padding, getMonth() is 0-indexed (easy to forget)
}

function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt) < new Date(); // Timezone-dependent, parsing varies by engine
}
```

**BAD (Go):**

```go
func addDays(t time.Time, days int) time.Time {
 return t.Add(time.Duration(days) * 24 * time.Hour) // Wrong across DST transitions
}

func parseDate(s string) (time.Time, error) {
 parts := strings.Split(s, "-")
 year, _ := strconv.Atoi(parts[0])
 month, _ := strconv.Atoi(parts[1])
 day, _ := strconv.Atoi(parts[2])
 return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC), nil
 // Breaks on: invalid input, missing parts, no validation
}
```

**GOOD (TypeScript):**

```typescript
import { addDays, format, isPast, parseISO } from "date-fns";

const nextWeek = addDays(date, 7);
const display = format(date, "yyyy-MM-dd");
const expired = isPast(parseISO(expiresAt));
```

**GOOD (Go):**

```go
nextWeek := t.AddDate(0, 0, 7) // Handles DST correctly

parsed, err := time.Parse(time.RFC3339, s) // Or time.DateOnly for "2006-01-02"

expired := time.Now().After(expiresAt)
```

Before adding a date/time dependency, check whether the language's standard library or an existing project utility already provides the required behavior.

**Exception:** Simple `time.Now()` for timestamps or `t.Format(time.RFC3339)` are fine — these use the standard library correctly.

### 3. Custom String Normalization / Comparison

Writing ad-hoc lowercase/trim/normalize logic instead of using consistent utility functions or `Intl` APIs.

**BAD:**

```typescript
function searchByName(items: Item[], query: string): Item[] {
  const normalizedQuery = query.toLowerCase().trim();
  return items.filter(item => item.name.toLowerCase().trim().includes(normalizedQuery));
}

function searchByEmail(users: User[], query: string): User[] {
  const normalizedQuery = query.toLowerCase().trim();
  return users.filter(user => user.email.toLowerCase().trim().includes(normalizedQuery));
}
// Same normalization logic duplicated — will drift when one adds .normalize("NFC")
```

**GOOD:**

```typescript
const normalize = (s: string) => s.toLowerCase().trim().normalize("NFC");

function searchBy<T>(items: T[], query: string, accessor: (item: T) => string): T[] {
  const normalizedQuery = normalize(query);
  return items.filter(item => normalize(accessor(item)).includes(normalizedQuery));
}

// Or for locale-aware comparison:
const collator = new Intl.Collator("en", { sensitivity: "base" });
```

### 4. Custom Retry / Backoff Logic

Hand-written retry loops with sleep. These miss: jitter, exponential backoff, max timeout, abort signals, and error classification (retryable vs. not).

**BAD (TypeScript):**

```typescript
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url);
    } catch {
      if (i === retries - 1) throw new Error("Failed after retries");
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("unreachable");
}
```

**BAD (Go):**

```go
func fetchWithRetry(ctx context.Context, url string, retries int) (*http.Response, error) {
 for i := 0; i < retries; i++ {
  resp, err := http.Get(url)
  if err == nil {
   return resp, nil
  }
  time.Sleep(time.Duration(i+1) * time.Second) // No jitter, no exponential backoff, blocks on context cancel
 }
 return nil, fmt.Errorf("failed after %d retries", retries)
}
```

**GOOD (TypeScript):**

```typescript
// Check if the codebase already has a retry utility (or a dependency like
// p-retry) before writing one. If not present in deps, a hand-written retry
// with exponential backoff and jitter is fine -- the point is not skipping
// backoff/jitter, not mandating a specific package.
```

**GOOD (Go):**

```go
// Check if the codebase already has a retry utility before writing one.
// Common patterns: cenkalti/backoff, hashicorp/go-retryablehttp, or a project-local helper.
b := backoff.NewExponentialBackOff()
err := backoff.Retry(func() error {
 resp, err = http.Get(url)
 return err
}, backoff.WithContext(b, ctx))
```

**What to look for:** `for` loops wrapping error checks with `time.Sleep`; any function named `*WithRetry` or `*WithBackoff`; retry loops that ignore context cancellation.

### 5. Custom Slug / ID Generation

Hand-writing slug generation or unique ID creation instead of using `crypto.randomUUID()`, `nanoid`, `uuid.New()`, or `slugify`.

**BAD (TypeScript):**

```typescript
function generateId(): string {
  return Math.random().toString(36).substring(2, 15); // Not crypto-safe, collisions
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  // Breaks on: accented chars, CJK, emoji, multiple consecutive hyphens
}
```

**BAD (Go):**

```go
func generateID() string {
 b := make([]byte, 16)
 rand.Read(b) // crypto/rand is correct, but then formatting by hand...
 return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
 // Wrong UUID version bits, not RFC 4122 compliant
}
```

**GOOD (TypeScript):**

```typescript
import { randomUUID } from "crypto";
const id = randomUUID();

// Or for short IDs, if a slug/short-id package is already in deps:
import { nanoid } from "nanoid";
const id = nanoid();
```

**GOOD (Go):**

```go
id := uuid.New().String() // Use a maintained UUID library already available to the project.
```

### 6. Custom Deep Clone / Deep Merge / Deep Equal

Hand-written recursive object operations. These break on: circular references, Dates, RegExps, Maps, Sets, Buffers, class instances.

**BAD (TypeScript):**

```typescript
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)); // Drops functions, undefined, Dates, Maps, Sets
}

function deepMerge(target: any, source: any): any {
  // 30 lines of recursive merging that misses edge cases
}
```

**GOOD (TypeScript):**

```typescript
const clone = structuredClone(obj); // Built-in, handles most types

// For deep merge, check if lodash or a dedicated utility is already in deps
// before adding one -- structuredClone alone doesn't merge.
import { merge } from "lodash";
```

**First check:** Is `structuredClone`, `lodash`, or another utility already available in the project's dependencies before flagging?

### 7. Custom HTTP Client Behavior (Go)

Hand-writing HTTP timeout handling, header manipulation, or response body processing instead of using `http.Client` configuration and `io` utilities properly.

**BAD:**

```go
func fetchJSON(url string, target any) error {
 resp, err := http.Get(url) // No timeout, uses DefaultClient
 if err != nil {
  return err
 }
 body, err := ioutil.ReadAll(resp.Body) // Deprecated, no size limit
 resp.Body.Close()
 return json.Unmarshal(body, target)
}
```

**GOOD:**

```go
client := &http.Client{Timeout: 30 * time.Second}
resp, err := client.Get(url)
if err != nil {
 return err
}
defer resp.Body.Close()
return json.NewDecoder(io.LimitReader(resp.Body, maxBytes)).Decode(target)
```

**What to look for:** `http.Get()` / `http.Post()` (uses `DefaultClient` with no timeout); `ioutil.ReadAll` (deprecated since Go 1.16, use `io.ReadAll`); missing `defer resp.Body.Close()`; unbounded body reads.

### 8. Custom Concurrency Primitives (Go)

Hand-writing worker pools, fan-out/fan-in, or semaphore patterns instead of using `errgroup` or `sync` utilities.

**BAD:**

```go
results := make(chan result, len(items))
var wg sync.WaitGroup
for _, item := range items {
 wg.Add(1)
 go func(item Item) {
  defer wg.Done()
  r, err := process(item)
  if err != nil {
   // Error silently dropped
   return
  }
  results <- r
 }(item)
}
wg.Wait()
close(results)
```

**GOOD:**

```go
g, ctx := errgroup.WithContext(ctx)
g.SetLimit(10) // Built-in concurrency limiting
results := make([]result, len(items))
for i, item := range items {
 g.Go(func() error {
  r, err := process(ctx, item)
  if err != nil {
   return err
  }
  results[i] = r
  return nil
 })
}
if err := g.Wait(); err != nil {
 return err
}
```

**What to look for:** Manual `sync.WaitGroup` + channel + goroutine patterns where `errgroup` would be cleaner; hand-written semaphores using buffered channels when `g.SetLimit()` exists.

## Where to Look

- Follow the changed code's imports, callers, and nearby utilities to see whether the capability already exists.
- Inspect the relevant package manifests or dependency declarations before recommending a new package.
- Search for established wrappers or platform APIs used by adjacent code; prefer those when they cover the same behavior.

## Exclusions

- Test files — custom test helpers and fixtures are fine
- Code that intentionally avoids a dependency for bundle size (should have a comment explaining why)
- Simple one-liners that are clearer than a library import (e.g., `strings.TrimSpace()` or `str.trim()` don't need a library)
- `node_modules/`, `dist/`, `out/`, `vendor/`

## Severity

- **Error**: Custom CSV/structured-data parser; custom cryptographic operations; `Math.random()` or `math/rand` for IDs in production code; `JSON.parse(JSON.stringify())` for cloning objects with Dates or Maps; `http.Get()` with no timeout in production
- **Warning**: Custom date arithmetic without DST handling (e.g., `t.Add(24*time.Hour)` instead of `t.AddDate()`); duplicated normalization logic; custom retry without backoff/jitter; custom slug generation without Unicode handling; manual `WaitGroup` + channel where `errgroup` would work
- **Info**: Custom implementations that work but have a simpler standard equivalent (e.g., hand-written `groupBy` when lodash is in deps; manual `ioutil.ReadAll` instead of `io.ReadAll`)
