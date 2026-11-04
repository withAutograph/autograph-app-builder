import { expect, it } from "vitest";
import { createValidationToolingFailureObserver } from "./validation-tooling-failure";

const panic =
  "@autograph/custom:check: thread 'tokio-rt-worker' (14920) panicked at crates/oxc_allocator/src/pool/fixed_size.rs:112:67:\ncalled `Result::unwrap()` on an `Err` value: ()";
it("recognizes the observed native checker panic across streamed chunks without retaining raw logs", () => {
  const observer = createValidationToolingFailureObserver();
  observer.observe("stderr", panic.slice(0, 77));
  observer.observe("stderr", panic.slice(77));
  expect(observer.classification()).toBe("native-tool-panic");
});
it("does not infer a fatal tool crash or memory cause from ordinary validation output", () => {
  for (const content of [
    "exit 134",
    "apps/app/page.tsx: error TS2322",
    "Formatting issues found",
    "test assertions failed",
    "thread 'test' panicked at apps/app/src/main.rs:1:1:",
  ]) {
    const observer = createValidationToolingFailureObserver();
    observer.observe("stderr", content);
    expect(observer.classification()).toBeUndefined();
  }
});

it("classifies only the exact selected app check task's native mise failure, including chunk splits", () => {
  const observer = createValidationToolingFailureObserver("//apps/supplier-spend:check");
  observer.observe("stderr", "mise ERROR no task //apps/supplier-spend:che");
  observer.observe("stderr", "ck found\n");
  expect(observer.classification()).toBe("missing-app-task");
});
it("accepts a final unterminated mise diagnostic without mistaking partial or unrelated output", () => {
  const observer = createValidationToolingFailureObserver("//apps/example:check");
  observer.observe("stderr", "mise ERROR no task //apps/example:check found");
  expect(observer.classification()).toBe("missing-app-task");
  for (const output of [
    "mise ERROR no task //apps/foreign:check found\n",
    "mise ERROR no task //apps/example:check-extra found\n",
    "mise ERROR no task //apps/example:test found\n",
    "Error: expected mise ERROR no task //apps/example:check found\n",
    "apps/example/app/page.tsx: error TS2322\n",
    "mise ERROR task check failed\n",
    "no task //apps/example:check found\n",
    "mise ERROR no task //apps/example:check found but test asserted it\n",
  ]) {
    const ordinary = createValidationToolingFailureObserver("//apps/example:check");
    ordinary.observe("stderr", output);
    expect(ordinary.classification()).toBeUndefined();
  }
  const split = createValidationToolingFailureObserver("//apps/example:check");
  split.observe("stderr", "mise ERROR no task //apps/example:check found");
  split.observe("stderr", " but test asserted it\n");
  expect(split.classification()).toBeUndefined();
});
