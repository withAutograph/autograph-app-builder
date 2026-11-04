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
