/**
 * Minimal global test declarations for TypeScript (lightweight AVA-like)
 *
 * This file provides ambient declarations for the `test` function and the
 * test `t` context used in the repository's tests. It's intentionally small
 * and covers the commonly-used assertion helpers so test files don't need the
 * actual test runner types installed while we removed the test tooling.
 *
 * Note: keep this file as an ambient declaration (.d.ts) so these symbols
 * are visible to the test sources.
 */

/* Basic assertion test context used by tests (a light subset) */
declare interface TestContext {
  is(actual: any, expected: any, message?: string): void;
  true(value: any, message?: string): void;
  false(value: any, message?: string): void;
  pass(message?: string): void;
  fail(message?: string): void;
  // allow other assertion helpers without strict typing
  [key: string]: any;
}

/* `test` function signature */
declare function test(title: string, fn?: (t: TestContext) => any): void;

/* Attach commonly used helpers to the `test` function */
declare namespace test {
  function before(fn: (t?: TestContext) => any): void;
  function after(fn: (t?: TestContext) => any): void;
  function beforeEach(fn: (t?: TestContext) => any): void;
  function afterEach(fn: (t?: TestContext) => any): void;

  function only(title: string, fn?: (t: TestContext) => any): void;
  function serial(title: string, fn?: (t: TestContext) => any): void;
  function cb(title: string, fn?: (t: TestContext) => any): void;
}
