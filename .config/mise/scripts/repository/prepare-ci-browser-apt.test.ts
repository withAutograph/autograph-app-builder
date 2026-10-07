/* eslint-disable sonarjs/no-clear-text-protocols -- These fixtures reproduce the failing runner HTTP mirror input; the configured output uses HTTPS. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { browserAptWrites } from "./prepare-ci-browser-apt.mts";

const fixture = {
  environment: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" },
  mirrorFiles: {
    "/etc/apt/apt-mirrors.txt":
      "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n",
  },
  osRelease: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n',
  platform: "linux",
};
it("replaces the hosted runner mirrorlist rather than changing signed sources", () => {
  expect(browserAptWrites(fixture)).toEqual([
    { contents: "https://archive.ubuntu.com/ubuntu/\n", path: "/etc/apt/apt-mirrors.txt" },
    {
      contents:
        'Acquire::Retries "1";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n',
      path: "/etc/apt/apt.conf.d/zzz-autograph-browser-acquire",
    },
  ]);
  const writes = JSON.stringify(browserAptWrites(fixture));
  expect(writes).not.toMatch(
    /Signed-By|trusted=|Unauthenticated|AllowInsecure|Check-Valid-Until|Verify-Peer/u,
  );
});
it.each([
  { platform: "darwin" },
  { environment: { GITHUB_ACTIONS: "false", RUNNER_ENVIRONMENT: "github-hosted" } },
  { environment: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" } },
  { osRelease: "ID=debian\n" },
])("leaves local, self-hosted and non-Ubuntu machines untouched", (overrides) => {
  expect(browserAptWrites({ ...fixture, ...overrides })).toEqual([]);
});
it("retains Ubuntu ports and unrelated mirrorlists", () => {
  expect(
    browserAptWrites({
      ...fixture,
      mirrorFiles: { "/etc/apt/apt-mirrors.txt": "http://ports.ubuntu.com/ubuntu-ports/\n" },
    }),
  ).toEqual([]);
});
it("uses the canonical security endpoint for the security mirrorlist", () => {
  const writes = browserAptWrites({
    ...fixture,
    mirrorFiles: { "/etc/apt/apt-security-mirrors.txt": "http://security.ubuntu.com/ubuntu/\n" },
  });
  expect(writes[0]).toEqual({
    contents: "https://security.ubuntu.com/ubuntu/\n",
    path: "/etc/apt/apt-security-mirrors.txt",
  });
});

it("retains full Chromium dependency installation after the CI-only preparation", () => {
  const task = readFileSync(
    new URL("../../tasks/storybook/install-browser", import.meta.url),
    "utf-8",
  );
  expect(task).toContain("prepare-ci-browser-apt.mts");
  expect(task).toContain("node_modules/playwright/cli.js install --with-deps chromium");
  expect(task).not.toContain("--no-deps");
});
