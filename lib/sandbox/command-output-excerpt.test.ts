import { expect, it, vi } from "vitest";
import { runSandboxCommandWithExcerpt } from "./command-output-excerpt";

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

it("drops oversized secret lines completely before retaining a redacted diagnostic tail", async () => {
  const suffix = "credential-suffix-must-never-remain";
  const spawn = vi.fn().mockResolvedValue({
    stdout: stream([]),
    stderr: stream([
      `https://user:password@private.example/${"x".repeat(5900)}`,
      `${"x".repeat(900) + suffix}\nThe recorded Auth origin cannot change\n`,
    ]),
    wait: () => Promise.resolve({ exitCode: 1 }),
    kill: () => Promise.resolve(),
  });
  const result = await runSandboxCommandWithExcerpt({
    sandbox: { spawn, run: vi.fn() },
    options: { command: "approved setup" },
    sanitize: (value) => value.replaceAll(/https?:\/\/\S+/gu, "[URL REDACTED]"),
  });
  expect(result.stderr).toContain("Long diagnostic line omitted");
  expect(result.stderr).toContain("The recorded Auth origin cannot change");
  expect(result.stderr).not.toContain(suffix);
  expect(result.stderr).not.toContain("password");
});
