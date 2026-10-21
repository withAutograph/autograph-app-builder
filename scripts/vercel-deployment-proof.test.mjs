/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- This JavaScript subprocess fixture reads synthetic JSON and executes the actual workflow shell with local mock binaries. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf-8");
const block = workflow
  .split("      - name: Require exact Vercel Git deployment\n")[1]
  .split("      - uses: actions/upload-artifact@v4")[0];
const script = block
  .split("        run: |\n")[1]
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");
const sha = "a".repeat(40);
const deployment = (id, environment = "Production", source = sha) => ({
  id,
  sha: source,
  environment,
  created_at: `2026-10-21T10:00:0${id}Z`,
});
const status = (id, state) => ({
  id,
  state,
  created_at: `2026-10-21T10:01:0${id}Z`,
  environment_url: "https://exact-source.vercel.app",
});
const runProof = (deployments, statuses) => {
  const directory = mkdtempSync(path.join(tmpdir(), "builder-deployment-proof-"));
  const fixture = path.join(directory, "fixture.json");
  writeFileSync(fixture, JSON.stringify({ deployments, statuses }));
  writeFileSync(
    path.join(directory, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.FIXTURE_ROOT;
const data = JSON.parse(fs.readFileSync(path.join(root,"fixture.json"),"utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root,"calls.jsonl"),JSON.stringify(args)+"\\n");
const endpoint = args.find(arg => arg.startsWith("repos/"));
if(endpoint === "repos/example/builder/deployments") {
  process.stdout.write(JSON.stringify(data.deployments));
} else {
  const match = endpoint?.match(/deployments\\/(\\d+)\\/statuses$/);
  if(!match || !Object.hasOwn(data.statuses,match[1])) process.exit(41);
  const variants = data.statuses[match[1]];
  const countFile = path.join(root,"reads-"+match[1]);
  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile,"utf8")) : 0;
  fs.writeFileSync(countFile,String(count+1));
  process.stdout.write(JSON.stringify(Array.isArray(variants[0]) ? variants[Math.min(count,variants.length-1)] : variants));
}
`,
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(directory, "curl"),
    `#!${process.execPath}
const fs=require("node:fs");
fs.appendFileSync(process.env.FIXTURE_ROOT+"/probes.jsonl",JSON.stringify(process.argv.slice(2))+"\\n");
process.stdout.write(JSON.stringify({resource:"https://new.autograph.so/mcp",authorization_servers:["https://auth.example.test"]}));
`,
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(directory, "sleep"),
    `#!${process.execPath}
require("node:fs").appendFileSync(process.env.FIXTURE_ROOT+"/waits.jsonl",process.argv[2]+"\\n");
`,
    { mode: 0o700 },
  );
  try {
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
      cwd: directory,
      encoding: "utf-8",
      env: {
        PATH: `${directory}:${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        FIXTURE_ROOT: directory,
        GITHUB_REPOSITORY: "example/builder",
        EXPECTED_SHA: sha,
        EXPECTED_ENVIRONMENT: "Production",
      },
    });
    const readLines = (name) => {
      try {
        return readFileSync(path.join(directory, name), "utf-8").trim().split("\n");
      } catch (error) {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    };
    return {
      result,
      calls: readLines("calls.jsonl").map(JSON.parse),
      probes: readLines("probes.jsonl").map(JSON.parse),
      proof: readLines("vercel-deployment-proof.json").join("\n"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("same exact-source record can become successful after a duplicate cancellation marks it inactive", () => {
  const observed = runProof([deployment(1)], {
    1: [[status(1, "inactive")], [status(2, "success")]],
  });
  assert.equal(observed.result.status, 0, observed.result.stderr);
  assert.deepEqual(JSON.parse(observed.proof), {
    format: "autograph-vercel-deployment-proof-v1",
    sha,
    environment: "Production",
    url: "https://exact-source.vercel.app",
    contract: "canonical-public-contract",
  });
  assert.equal(
    observed.calls.filter((args) => args.includes("repos/example/builder/deployments/1/statuses"))
      .length > 1,
    true,
  );
  assert.equal(
    observed.probes.some((args) => args.includes("https://new.autograph.so/healthz")),
    true,
  );
  assert.equal(
    observed.probes.some((args) =>
      args.includes("https://new.autograph.so/.well-known/oauth-protected-resource"),
    ),
    true,
  );
});
test("historical success beneath current inactive or error is never accepted", () => {
  const observed = runProof([deployment(1)], {
    1: [
      [status(1, "success"), status(2, "inactive")],
      [status(1, "success"), status(3, "error")],
    ],
  });
  assert.notEqual(observed.result.status, 0);
  assert.equal(observed.proof, "");
  assert.equal(observed.probes.length, 0);
  assert.equal(
    observed.calls.filter((args) => args.includes("repos/example/builder/deployments/1/statuses"))
      .length > 1,
    true,
  );
});
test("other source and environment records cannot supply proof", () => {
  const observed = runProof(
    [deployment(1), deployment(2, "Preview"), deployment(3, "Production", "b".repeat(40))],
    { 1: [status(1, "failure")] },
  );
  assert.notEqual(observed.result.status, 0);
  assert.equal(observed.proof, "");
  assert.equal(observed.probes.length, 0);
});
test("pending deployment can become successful on a subsequent observation", () => {
  const observed = runProof([deployment(1)], {
    1: [[status(1, "pending")], [status(2, "success")]],
  });
  assert.equal(observed.result.status, 0, observed.result.stderr);
  assert.equal(
    observed.calls.filter((args) => args.includes("repos/example/builder/deployments/1/statuses"))
      .length > 1,
    true,
  );
  assert.equal(JSON.parse(observed.proof).sha, sha);
});
