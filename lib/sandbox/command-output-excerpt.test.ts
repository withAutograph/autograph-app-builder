import { expect, it, vi } from "vitest";
import { runSandboxCommandWithExcerpt } from "./command-output-excerpt";

it("drops oversized secret lines completely before retaining a redacted diagnostic tail", async () => {
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
  const suffix = "credential-suffix-must-never-remain";
  const spawn = vi.fn().mockResolvedValue({
    kill: async () => {},
    stderr: stream([
      `https://user:password@private.example/${"x".repeat(5900)}`,
      `${"x".repeat(900) + suffix}\nThe recorded Auth origin cannot change\n`,
    ]),
    stdout: stream([]),
    wait: async () => ({ exitCode: 1 }),
  });
  const result = await runSandboxCommandWithExcerpt({
    options: { command: "approved setup" },
    sandbox: { run: vi.fn(), spawn },
    sanitize: (value) => value.replaceAll(/https?:\/\/\S+/gu, "[URL REDACTED]"),
  });
  expect(result.stderr).toContain("Long diagnostic line omitted");
  expect(result.stderr).toContain("The recorded Auth origin cannot change");
  expect(result.stderr).not.toContain(suffix);
  expect(result.stderr).not.toContain("password");
});
