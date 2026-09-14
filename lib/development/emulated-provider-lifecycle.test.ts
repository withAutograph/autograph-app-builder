import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, expect, it } from "vitest";
import {
  assertOwnedProviders,
  ownsProviderListener,
  waitForOwnedProviders,
} from "./emulated-provider-lifecycle";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers) {
    server.close();
  }
  servers.length = 0;
});
const listener = async () => {
  const server = createServer();
  servers.push(server);
  // oxlint-disable-next-line promise/avoid-new -- Bridge the actual local listener callback.
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's address API returns a pipe or TCP address.
  if (address === null || typeof address === "string") {
    throw new Error("No TCP listener");
  }
  return { port: address.port, server };
};

it("requires both real listeners to belong to the owned emulator PID", async () => {
  const first = await listener();
  const second = await listener();
  await waitForOwnedProviders({ pid: process.pid, ports: [first.port, second.port], timeoutMs: 0 });
  expect(await ownsProviderListener(process.ppid, second.port)).toBe(false);
  await expect(
    waitForOwnedProviders({ pid: process.ppid, ports: [first.port, second.port], timeoutMs: 0 }),
  ).rejects.toThrow("not ready");
  second.server.close();
  await expect(
    waitForOwnedProviders({ pid: process.pid, ports: [first.port, second.port], timeoutMs: 0 }),
  ).rejects.toThrow("not ready");
  await expect(assertOwnedProviders(process.pid, [first.port, second.port])).rejects.toThrow(
    "stopped",
  );
});

it("resolves the installed listener utility with a sanitized PATH", async () => {
  // oxlint-disable-next-line typescript/strict-void-return -- Adapt Node callback API.
  const execute = promisify(execFile);
  const result = await execute(path.resolve(".config/mise/scripts/resolve-lsof"), [], {
    env: { PATH: "/usr/bin:/bin" },
  });
  expect(result.stdout.trim().startsWith("/")).toBe(true);
  const first = await listener();
  const code = `import {ownsProviderListener} from ${JSON.stringify(path.resolve("lib/development/emulated-provider-lifecycle.ts"))};if(!await ownsProviderListener(${process.pid},${first.port}))process.exit(2);`;
  await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    env: { PATH: "/usr/bin:/bin" },
  });
});
