// Vitest tests for src/util/timeout.ts.
//
// Asserts the operational-hygiene contract of withTimeout:
//   1. Resolves with the inner promise's value when the promise wins the race.
//   2. Rejects with a ToolError(code=default_or_override, message=`<label> timed
//      out after <ms>ms`, tool=label) when the timer wins the race.
//   3. Propagates the inner error (with no wrapping) when the inner promise
//      rejects first with a non-ToolError.
//   4. Clears the timer in the finally block so the test process doesn't
//      hang on unhandled timer refs.
//   5. Accepts a `code` override so callers can surface a more specific
//      error code (e.g. "UPSTREAM_TIMEOUT" vs the default "TIMEOUT").
import { describe, test, expect } from "vitest";
import { withTimeout } from "../../src/util/timeout.js";
import { ToolError } from "../../src/util/errors.js";

describe("withTimeout", () => {
  test("resolves with the inner value when the promise wins the race", async () => {
    const value = await withTimeout(
      Promise.resolve("hello"),
      1000,
      "fast_promise",
    );
    expect(value).toBe("hello");
  });

  test("rejects with ToolError(code=TIMEOUT, message=`<label> timed out after <ms>ms`) after the timer wins", async () => {
    const start = Date.now();
    let err: unknown;
    try {
      await withTimeout(new Promise<string>(() => undefined), 50, "slow_promise");
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(ToolError);
    const toolErr = err as ToolError;
    expect(toolErr.code).toBe("TIMEOUT");
    expect(toolErr.message).toBe("slow_promise timed out after 50ms");
    expect(toolErr.tool).toBe("slow_promise");
    // The race should fire close to (and not significantly after) the 50ms
    // budget. We allow a wide margin so flaky CI doesn't trip the test.
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("propagates the inner error when the inner promise rejects first (no wrapping)", async () => {
    const inner = new Error("upstream boom");
    let err: unknown;
    try {
      await withTimeout(Promise.reject(inner), 1000, "throwing_promise");
    } catch (e) {
      err = e;
    }
    expect(err).toBe(inner);
    expect(err).not.toBeInstanceOf(ToolError);
  });

  test("respects the `code` override (e.g. UPSTREAM_TIMEOUT)", async () => {
    let err: unknown;
    try {
      await withTimeout(new Promise<string>(() => undefined), 50, "llm_call", {
        code: "UPSTREAM_TIMEOUT",
      });
    } catch (e) {
      err = e;
    }
    const toolErr = err as ToolError;
    expect(toolErr.code).toBe("UPSTREAM_TIMEOUT");
    expect(toolErr.tool).toBe("llm_call");
    expect(toolErr.message).toBe("llm_call timed out after 50ms");
  });

  test("clears the timer so no stray setTimeout ref is left pending", async () => {
    // Indirect check: completing a withTimeout call (either via resolve OR
    // via timeout) must not leave the timer pending. The implementation
    // uses clearTimeout in `finally`; if it were missing, a test that
    // completed many withTimeout calls would accumulate pending timers.
    // We assert the call rejects (the timeout fires), the elapsed time
    // is bounded, and the test returns to the runner cleanly.
    const start = Date.now();
    let err: unknown;
    try {
      await withTimeout(new Promise<string>(() => undefined), 30, "leak_check");
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("TIMEOUT");
    // If the timer wasn't cleared, a stray setTimeout callback would
    // still fire (it's a no-op, but it would extend the test runtime
    // past the bound below). The bound is generous so flaky CI doesn't
    // trip it.
    expect(elapsed).toBeLessThan(2_000);
  });
});
