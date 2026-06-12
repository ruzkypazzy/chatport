// Vitest tests for the AC-17 "no-mocks-in-prod" production-purity contract.
//
// Mirrors the plan's verification matrix verbatim:
//
//   | AC-17 | `src/` (grep) | `! grep -rE "TODO|FIXME|placeholder|mock" src/` | No matches |
//
// and adds a stricter static check that catches the spirit of the
// contract (not just the literal substrings): exactly one
// `new OpenAI(...)` instantiation in `src/`, and it lives inside
// `src/llm/openai-client.ts`'s `buildOpenAIClient`. Anywhere else
// (e.g. a tool bypassing the factory and constructing a client
// directly) would be a regression.
//
// The test runs `grep` and in-process file scans against the
// on-disk working tree (not the compiled dist/), so a future
// comment edit that reintroduces a forbidden word fails the suite
// immediately.
import { describe, test, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(process.cwd(), "src");
const FACTORY_PATH = "src/llm/openai-client.ts";

function listSrcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") || entry.endsWith(".mts")) {
        out.push(full);
      }
    }
  };
  walk(SRC_ROOT);
  return out.sort();
}

/**
 * Strip line comments, block comments, and backtick-quoted strings
 * from a TypeScript source file. This is intentionally simple — we
 * don't need a full TS parser, just enough to skip:
 *   - single-line `//` comments (whole line + inline)
 *   - multi-line `/*` ... `*​/` blocks
 *   - backtick-quoted template strings (e.g. `` `new OpenAI(...)` ``
 *     inside docstring code samples)
 * so docstring references to `new OpenAI(...)` don't trip the
 * static check while real code does.
 */
function stripCommentsAndStrings(content: string): string {
  // Strip block comments first (greedy, no nesting in TS).
  const noBlocks = content.replace(/\/\*[\s\S]*?\*\//g, "");
  // Then strip single-line comments (everything from `//` to end of
  // line), and backtick-quoted template strings.
  return noBlocks
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf("//");
      let code = idx === -1 ? line : line.slice(0, idx);
      // Strip backtick-quoted strings (whole-line or trailing).
      code = code.replace(/`[^`]*`/g, '""');
      return code;
    })
    .join("\n");
}

describe("AC-17: production-purity guard (mirrors plan verification matrix)", () => {
  test("plan grep: no TODO/FIXME/placeholder/mock substring in any src/ file", () => {
    // The plan's verification matrix runs the literal command
    //   ! grep -rE "TODO|FIXME|placeholder|mock" src/
    // from the project root. We re-implement the scan in-process
    // (no shell) and assert the same property: zero matches. This
    // includes comments, so a follow-up docstring edit that
    // reintroduces a forbidden word fails the suite immediately.
    const files = listSrcFiles();
    const violations: Array<{ file: string; line: number; text: string }> = [];
    const re = /TODO|FIXME|placeholder|mock/i;
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (re.test(line)) {
          violations.push({
            file: file.replace(process.cwd() + "/", ""),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }
    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
        .join("\n");
      throw new Error(
        `AC-17 violation: forbidden substring in src/.\n` +
          `The plan's verification matrix says:\n` +
          `  ! grep -rE "TODO|FIXME|placeholder|mock" src/\n` +
          `Match this rule for ALL of src/ (comments + code).\n` +
          `Offenders:\n${formatted}`,
      );
    }
    expect(violations).toEqual([]);
  });

  test("shell: the plan's exact grep command exits 0 against the working tree", () => {
    // Re-run the literal shell command from the plan. The plan
    // uses `! grep -rE "..."` which inverts the exit code:
    //   - grep exit 0 = matches found (BAD; the `!` flips to exit 1)
    //   - grep exit 1 = no matches (GOOD; the `!` flips to exit 0)
    // We assert the post-inversion exit code (the one the plan
    // actually checks) is 0, meaning "no matches anywhere in src/".
    let postInversion = 0;
    try {
      execSync("grep -rE 'TODO|FIXME|placeholder|mock' src/", {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      // grep exited 0 = matches found -> post-inversion is 1 (bad).
      postInversion = 1;
    } catch (err) {
      // grep exited 1 (no matches) or 2 (usage error). execSync
      // throws on non-zero exit. Capture the code and invert.
      const e = err as { status?: number };
      const raw = e.status ?? 1;
      // Post-inversion: raw 1 -> 0 (good); raw 2 -> 1 (bad, usage).
      postInversion = raw === 1 ? 0 : 1;
    }
    expect(postInversion).toBe(0);
  });

  test("no `new OpenAI(` instantiation outside the factory file", () => {
    // The AC-17 contract says `createOpenAIClient(env, overrides?)`
    // is the single construction point. A tool bypassing the
    // factory and constructing a real `OpenAI` directly would
    // defeat the override hook and silently reach the network.
    // Comments are stripped so docstring references to
    // `new OpenAI(...)` don't trip the check.
    const files = listSrcFiles();
    const direct = new RegExp("\\bnew\\s+OpenAI\\s*\\(");
    const violations: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const rel = file.replace(process.cwd() + "/", "");
      // The factory is the only allowed site.
      if (rel === FACTORY_PATH) continue;
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      const codeLines = code.split(/\r?\n/);
      for (let i = 0; i < codeLines.length; i++) {
        const line = codeLines[i] ?? "";
        if (direct.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("exactly one `new OpenAI(` instantiation in src/ (the factory)", () => {
    // And conversely, the factory MUST contain exactly one. Zero
    // would mean the factory doesn't actually construct anything
    // (a silent stub). Two or more would mean it's been duplicated.
    const file = join(SRC_ROOT, "llm/openai-client.ts");
    const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
    const matches = code.match(/\bnew\s+OpenAI\s*\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  test("src/index.ts calls createOpenAIClient with no overrides (production path is live)", () => {
    // The production boot path must call the factory with no
    // overrides (or `undefined` / `{}`). If a future refactor
    // accidentally adds overrides at the call site, the production
    // boot would receive a fake and the AC-17 contract is broken.
    const file = join(SRC_ROOT, "index.ts");
    const content = readFileSync(file, "utf8");
    // Match `createOpenAIClient(env)` or `createOpenAIClient(env, {})`
    // but NOT `createOpenAIClient(env, { openai: ... })`.
    const m = /createOpenAIClient\s*\(\s*env\s*(?:,\s*\{\s*\})?\s*\)/.exec(content);
    expect(m).not.toBeNull();
    // And there must be no other call site that passes a non-empty
    // overrides object (openai or minimax keys present).
    const bad = /createOpenAIClient\s*\(\s*env\s*,\s*\{\s*(?:openai|minimax)\s*:/i.exec(content);
    expect(bad).toBeNull();
  });

  test("no vitest/jest mock helpers in src/ (code only)", () => {
    // Belt-and-braces: vitest's mock helpers and jest's mock
    // helpers are runtime-only and would never compile in `src/`
    // (they're declared under `devDependencies`), but a static
    // check catches the intent. This guards against future
    // imports of `vi.mock(...)`, `jest.mock(...)`, `vi.fn(...)`,
    // etc. — code only (comments allowed to discuss the helpers).
    const files = listSrcFiles();
    const re = /\bvi\.(?:mock|fn|spyOn|useFakeTimers)\b|\bjest\.(?:mock|fn|spyOn)\b/;
    const violations: string[] = [];
    for (const file of files) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      const lines = code.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (re.test(line)) {
          violations.push(`${file.replace(process.cwd() + "/", "")}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
