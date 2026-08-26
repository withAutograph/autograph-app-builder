import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (script: string, args: string[], expected = 0) =>
  new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, `scripts/${script}`, ...args],
      { stdio: expected === 0 ? "inherit" : "ignore" },
    );
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === expected
        ? resolveRun()
        : rejectRun(
            new Error(`${script} exited ${code}; expected ${expected}.`),
          ),
    );
  });

const temp = await mkdtemp(join(tmpdir(), "autograph-portable-"));
try {
  for (const endpoint of [
    "https://replace-me.invalid",
    "https://mcp-endpoint.template",
    "https://localhost",
    "https://agent.example.com",
  ])
    await run(
      "build-portable-release.mts",
      [
        "--endpoint",
        endpoint,
        "--output",
        join(temp, `rejected-${Date.now()}`),
      ],
      1,
    );
  const first = join(temp, "release-a");
  const second = join(temp, "release-b");
  const endpoint = "https://mcp.autograph.dev";
  for (const output of [first, second])
    await run("build-portable-release.mts", [
      "--endpoint",
      endpoint,
      "--output",
      output,
    ]);
  const archiveName = "autograph-app-builder-0.1.0.tar.gz";
  const firstArchive = await readFile(join(first, archiveName));
  const secondArchive = await readFile(join(second, archiveName));
  if (!firstArchive.equals(secondArchive))
    throw new Error("Portable archive is not reproducible.");
  const firstReceipt = JSON.parse(
    await readFile(join(first, "release-receipt.json"), "utf8"),
  );
  const secondReceipt = JSON.parse(
    await readFile(join(second, "release-receipt.json"), "utf8"),
  );
  if (JSON.stringify(firstReceipt) !== JSON.stringify(secondReceipt))
    throw new Error("Portable release receipt is not reproducible.");
  const extracted = join(temp, "extracted");
  await mkdir(extracted);
  execFileSync(
    "/usr/bin/tar",
    ["-xzf", join(first, archiveName), "-C", extracted],
    {
      stdio: "inherit",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NODE_ENV: "test" },
    },
  );
  await run("validate-plugin.mts", [
    "--root",
    join(extracted, "autograph-app-builder"),
    "--artifact",
    "--release",
  ]);
  const installs = join(temp, "installs");
  for (const client of ["vscode", "cursor", "codex"])
    await run("install-portable-plugin.mts", [
      "--client",
      client,
      "--source",
      first,
      "--destination",
      installs,
    ]);
  await run("smoke-portable-plugin.mts", [
    "--release",
    first,
    "--install-root",
    installs,
  ]);
} finally {
  await rm(temp, { recursive: true, force: true });
}
