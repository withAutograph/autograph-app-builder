/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Only the ephemeral GitHub-hosted Ubuntu browser setup uses this apt configuration. */
export interface BrowserAptContext {
  platform: string;
  environment: Record<string, string | undefined>;
  osRelease: string;
  mirrorFiles: Record<string, string>;
}
export const browserAptWrites = ({
  platform,
  environment,
  osRelease,
  mirrorFiles,
}: BrowserAptContext): { contents: string; path: string }[] => {
  if (
    platform !== "linux" ||
    environment.GITHUB_ACTIONS !== "true" ||
    environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !/^ID=(?:ubuntu|"ubuntu")$/mu.test(osRelease)
  ) {
    return [];
  }
  const writes = [];
  for (const [file, contents] of Object.entries(mirrorFiles)) {
    // GitHub's mirror+file sources pick individual indexes from this list.
    // Keep source suites, components, Signed-By and third-party sources intact.
    if (
      /https?:\/\/(?:azure\.archive|archive|security)\.ubuntu\.com\/ubuntu\/?(?:\s|$)/mu.test(
        contents,
      )
    ) {
      writes.push({
        contents:
          file === "/etc/apt/apt-security-mirrors.txt"
            ? "https://security.ubuntu.com/ubuntu/\n"
            : "https://archive.ubuntu.com/ubuntu/\n",
        path: file,
      });
    }
  }
  if (writes.length > 0) {
    writes.push({
      contents:
        'Acquire::Retries "1";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n',
      // Apt applies parts in filename order; this follows runner-image zz-retries.
      path: "/etc/apt/apt.conf.d/zzz-autograph-browser-acquire",
    });
  }
  return writes;
};

const prepareCiBrowserApt = async () => {
  if (
    process.platform !== "linux" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  ) {
    return;
  }
  const osRelease = await readFile("/etc/os-release", "utf-8");
  const mirrorFiles: Record<string, string> = {};
  for (const file of ["/etc/apt/apt-mirrors.txt", "/etc/apt/apt-security-mirrors.txt"]) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Read the two supported runner mirror files before preparing CI mutations.
      mirrorFiles[file] = await readFile(file, "utf-8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  const writes = browserAptWrites({
    environment: process.env,
    mirrorFiles,
    osRelease,
    platform: process.platform,
  });
  if (writes.length === 0) {
    return;
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "autograph-browser-apt-"));
  try {
    for (const [index, write] of writes.entries()) {
      const source = path.join(scratch, `${index}.conf`);
      // eslint-disable-next-line no-await-in-loop -- Apply mirror selection before the acquire configuration in a known order.
      await writeFile(source, write.contents, { mode: 0o600 });
      execFileSync(
        "/usr/bin/sudo",
        ["--non-interactive", "/usr/bin/install", "--mode=0644", source, write.path],
        {
          stdio: "inherit",
        },
      );
    }
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
};

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await prepareCiBrowserApt();
}
