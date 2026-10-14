import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ensureProductionNavigationImage,
  PRODUCTION_NAVIGATION_POSTGRES_IMAGE as image,
  PRODUCTION_NAVIGATION_POSTGRES_FALLBACK_IMAGE as fallbackImage,
} from "./production-navigation-image";

const success = { exitCode: 0, stderr: "" };
const missing = { exitCode: 1, stderr: `Error response from daemon: No such image: ${image}\n` };
const throttled = { exitCode: 1, stderr: "docker: toomanyrequests: Rate exceeded" };
const fixture = () => {
  let time = 0;
  const controller = new AbortController();
  const runCommand = vi.fn(
    async (_args: string[], _options: { signal: AbortSignal; timeoutMs: number }) =>
      await Promise.resolve(success),
  );
  const wait = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    time += milliseconds;
    await Promise.resolve();
  });
  return {
    controller,
    elapse(milliseconds: number) {
      time += milliseconds;
    },
    input: { now: () => time, runCommand, signal: controller.signal, wait },
    runCommand,
    wait,
  };
};

describe("production navigation pinned image preparation", () => {
  it("skips a pull when the exact image is cached", async () => {
    const f = fixture();
    await expect(ensureProductionNavigationImage(f.input)).resolves.toBe(image);
    expect(f.runCommand).toHaveBeenCalledExactlyOnceWith(["image", "inspect", image], {
      signal: f.controller.signal,
      timeoutMs: 10_000,
    });
    expect(f.wait).not.toHaveBeenCalled();
  });

  it("pulls the same pinned image only after a known missing image", async () => {
    const f = fixture();
    f.runCommand.mockResolvedValueOnce(missing);
    await expect(ensureProductionNavigationImage(f.input)).resolves.toBe(image);
    expect(f.runCommand).toHaveBeenNthCalledWith(2, ["pull", image], {
      signal: f.controller.signal,
      timeoutMs: 60_000,
    });
    expect(f.runCommand).toHaveBeenCalledTimes(2);
  });

  it.each(["docker: toomanyrequests: Rate exceeded", "unexpected HTTP status code: 429"])(
    "uses the same immutable digest from the canonical registry after an observed mirror throttle: %s",
    async (stderr) => {
      const f = fixture();
      f.runCommand
        .mockResolvedValueOnce(missing)
        .mockResolvedValueOnce({ exitCode: 1, stderr })
        .mockResolvedValueOnce({
          exitCode: 1,
          stderr: `Error response from daemon: No such image: ${fallbackImage}`,
        })
        .mockResolvedValueOnce(success);
      await expect(ensureProductionNavigationImage(f.input)).resolves.toBe(fallbackImage);
      expect(image.split("@")[1]).toBe(fallbackImage.split("@")[1]);
      expect(f.runCommand.mock.calls.map(([args]) => args)).toEqual([
        ["image", "inspect", image],
        ["pull", image],
        ["image", "inspect", fallbackImage],
        ["pull", fallbackImage],
      ]);
      expect(f.wait).not.toHaveBeenCalled();
    },
  );
  it("reuses the exact fallback image when it is already present", async () => {
    const f = fixture();
    f.runCommand.mockResolvedValueOnce(missing).mockResolvedValueOnce(throttled);
    await expect(ensureProductionNavigationImage(f.input)).resolves.toBe(fallbackImage);
    expect(f.runCommand).toHaveBeenCalledTimes(3);
    expect(f.wait).not.toHaveBeenCalled();
  });
  it("reinspects after throttling and avoids another pull if the immutable image arrived locally", async () => {
    const f = fixture();
    f.runCommand.mockImplementation(async (args) => {
      if (args[0] === "pull") {
        return await Promise.resolve(throttled);
      }
      if (args[2] === fallbackImage && f.wait.mock.calls.length > 0) {
        return await Promise.resolve(success);
      }
      return await Promise.resolve({
        exitCode: 1,
        stderr: `Error response from daemon: No such image: ${args[2]}`,
      });
    });
    await expect(ensureProductionNavigationImage(f.input)).resolves.toBe(fallbackImage);
    expect(
      f.runCommand.mock.calls.filter(([args]) => args[0] === "pull").map(([args]) => args[1]),
    ).toEqual([image, fallbackImage]);
    expect(f.wait).toHaveBeenCalledExactlyOnceWith(10_000, f.controller.signal);
  });
  it("stops at the existing deadline when both registries remain throttled, without creating a container", async () => {
    const f = fixture();
    f.runCommand.mockImplementation(
      async (args) =>
        await Promise.resolve(
          args[0] === "pull"
            ? throttled
            : { exitCode: 1, stderr: `Error response from daemon: No such image: ${args[2]}` },
        ),
    );
    await expect(ensureProductionNavigationImage(f.input)).rejects.toThrow("deadline");
    expect(
      f.runCommand.mock.calls.filter(([args]) => args[0] === "pull" && args[1] === image),
    ).toHaveLength(1);
    expect(f.wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      10_000, 20_000, 40_000, 40_000, 40_000, 30_000,
    ]);
    expect(
      f.runCommand.mock.calls.every(([args]) => args[0] === "image" || args[0] === "pull"),
    ).toBe(true);
  });
  it("caps each pull by the remaining total deadline and stops at exhaustion", async () => {
    const f = fixture();
    const timeouts: number[] = [];
    f.runCommand.mockImplementation(async (args, options) => {
      if (args[0] === "image") {
        return await Promise.resolve({
          exitCode: 1,
          stderr: `Error response from daemon: No such image: ${args[2]}`,
        });
      }
      timeouts.push(options.timeoutMs);
      f.elapse(options.timeoutMs);
      return await Promise.resolve(throttled);
    });
    await expect(ensureProductionNavigationImage(f.input)).rejects.toThrow("deadline");
    expect(timeouts).toEqual([60_000, 60_000, 50_000]);
    expect(f.wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([10_000]);
  });
  it("does not pull after an unknown fallback inspection failure", async () => {
    const f = fixture();
    f.runCommand
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce({ exitCode: 1, stderr: "Cannot connect to the Docker daemon" });
    await expect(ensureProductionNavigationImage(f.input)).rejects.toThrow("could not inspect");
    expect(f.runCommand).toHaveBeenCalledTimes(3);
    expect(f.wait).not.toHaveBeenCalled();
  });
  it("fails a non-429 fallback pull immediately without returning an image", async () => {
    const f = fixture();
    f.runCommand
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: `Error response from daemon: No such image: ${fallbackImage}`,
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "unauthorized: authentication required" });
    await expect(ensureProductionNavigationImage(f.input)).rejects.toThrow("could not pull");
    expect(f.runCommand).toHaveBeenCalledTimes(4);
    expect(f.wait).not.toHaveBeenCalled();
  });

  it.each([
    "unauthorized: authentication required",
    "x509: certificate signed by unknown authority",
    "Cannot connect to the Docker daemon",
    "unknown registry failure",
    "Rate exceeded",
  ])("does not retry a non-429 pull error: %s", async (stderr) => {
    const f = fixture();
    f.runCommand.mockResolvedValueOnce(missing).mockResolvedValueOnce({ exitCode: 1, stderr });
    await expect(ensureProductionNavigationImage(f.input)).rejects.toThrow("could not pull");
    expect(f.runCommand).toHaveBeenCalledTimes(2);
    expect(f.wait).not.toHaveBeenCalled();
  });

  it.each([
    { exitCode: 1, stderr: "Cannot connect to the Docker daemon" },
    { exitCode: 1, stderr: "No such image: unrelated" },
    { exitCode: 125, stderr: missing.stderr },
  ])("does not pull after an unknown inspect failure: %j", async (result) => {
    const f = fixture();
    f.runCommand.mockResolvedValueOnce(result);
    await expect(ensureProductionNavigationImage(f.input)).rejects.toThrow("could not inspect");
    expect(f.runCommand).toHaveBeenCalledTimes(1);
  });

  it("propagates a command timeout or spawn failure immediately", async () => {
    const f = fixture();
    const failure = new Error("fixed command failure");
    f.runCommand.mockResolvedValueOnce(missing).mockRejectedValueOnce(failure);
    await expect(ensureProductionNavigationImage(f.input)).rejects.toBe(failure);
    expect(f.wait).not.toHaveBeenCalled();
  });

  it("does not dispatch when already cancelled", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(ensureProductionNavigationImage(f.input)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("passes cancellation to the in-flight command and does not retry", async () => {
    const f = fixture();
    f.runCommand
      .mockResolvedValueOnce(missing)
      .mockImplementationOnce(async (_args, { signal }) => {
        f.controller.abort();
        signal.throwIfAborted();
        return await Promise.resolve(success);
      });
    await expect(ensureProductionNavigationImage(f.input)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(f.runCommand).toHaveBeenCalledTimes(2);
    expect(f.wait).not.toHaveBeenCalled();
  });

  it("cancels during backoff without another pull", async () => {
    const f = fixture();
    f.runCommand
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: `Error response from daemon: No such image: ${fallbackImage}`,
      })
      .mockResolvedValueOnce(throttled);
    f.wait.mockImplementationOnce(async (_milliseconds, signal) => {
      f.controller.abort();
      signal.throwIfAborted();
      await Promise.resolve();
    });
    await expect(ensureProductionNavigationImage(f.input)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(f.runCommand).toHaveBeenCalledTimes(4);
  });

  it("prepares the image before the sole container creation and wires owned cancellation", () => {
    const source = readFileSync(
      new URL("test-production-navigation.mts", import.meta.url),
      "utf-8",
    );
    expect(source.indexOf("await ensureProductionNavigationImage({")).toBeLessThan(
      source.indexOf("databaseStarted = true;"),
    );
    expect(source.match(/await runDocker\(\[\s*"run"/gu)).toHaveLength(1);
    expect(source).toContain("imagePreparationAbort.abort();");
    expect(source).toContain("signal: imagePreparationAbort.signal");
    expect(source).toContain("const postgresImage = await ensureProductionNavigationImage({");
    expect(source).toMatch(/"127\.0\.0\.1::5432",\s*postgresImage,/u);
  });
});
