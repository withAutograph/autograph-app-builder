import { once } from "node:events";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PublicState } from "./self-reproduction-public";

const entrySchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["running", "finished", "failed", "expired", "incomplete"]),
});
const ledgerSchema = z.array(entrySchema);
type Entry = z.infer<typeof entrySchema>;
export interface PreviewCaptureInvocation {
  repositoryRoot: string;
  stateFile: string;
  outputDir: string;
}
const executePreviewCapture = async (input: PreviewCaptureInvocation): Promise<number> => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/observe-self-reproduction-preview.mts",
      "--state-file",
      input.stateFile,
      "--output-dir",
      input.outputDir,
    ],
    { cwd: input.repositoryRoot, stdio: "ignore" },
  );
  await once(child, "exit");
  return child.exitCode ?? 1;
};

/** Observes receipts only: no MCP calls, generation commands, approvals, or replies. */
export const createAutomaticPreviewObserver = (input: {
  outputDir: string;
  repositoryRoot: string;
  execute?: (invocation: PreviewCaptureInvocation) => Promise<number>;
  now?: () => number;
}) => {
  const root = path.join(input.outputDir, "preview-observations");
  const ledgerFile = path.join(root, "ledger.json");
  const jobs: Promise<void>[] = [];
  const entries = new Map<string, Entry>();
  let initialized = false;
  const persist = () => {
    writeFileSync(`${ledgerFile}.tmp`, `${JSON.stringify([...entries.values()], null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(`${ledgerFile}.tmp`, ledgerFile);
  };
  const initialize = () => {
    if (initialized) {
      return;
    }
    mkdirSync(root, { mode: 0o700, recursive: true });
    if (existsSync(ledgerFile)) {
      for (const entry of ledgerSchema.parse(JSON.parse(readFileSync(ledgerFile, "utf-8")))) {
        entries.set(entry.digest, {
          digest: entry.digest,
          status: entry.status === "running" ? "incomplete" : entry.status,
        });
      }
    }
    initialized = true;
    persist();
  };
  const observe = (state: PublicState): void => {
    try {
      initialize();
      const receipt = state.session?.workingPreview;
      if (!receipt) {
        return;
      }
      const digest = createHash("sha256")
        .update(JSON.stringify([state.session?.sessionId, receipt]))
        .digest("hex");
      if (entries.has(digest)) {
        return;
      }
      const directory = path.join(root, digest);
      const privateDirectory = path.join(directory, "private");
      mkdirSync(privateDirectory, { mode: 0o700, recursive: true });
      const stateFile = path.join(privateDirectory, "state.json");
      writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
      const entry: Entry = {
        digest,
        status: Date.parse(receipt.expiresAt) <= (input.now ?? Date.now)() ? "expired" : "running",
      };
      entries.set(digest, entry);
      persist();
      if (entry.status === "expired") {
        return;
      }
      // Call immediately, then retain its asynchronous completion without delaying polling.
      const job = (async () => {
        try {
          const code = await (input.execute ?? executePreviewCapture)({
            outputDir: path.join(directory, "capture"),
            repositoryRoot: input.repositoryRoot,
            stateFile,
          });
          entry.status = code === 0 ? "finished" : "failed";
        } catch {
          entry.status = "failed";
        }
        try {
          persist();
        } catch {
          // Observation failure cannot change the public session.
        }
      })();
      jobs.push(job);
    } catch {
      // Filesystem or malformed-ledger failures must never alter generation or user replies.
      try {
        mkdirSync(root, { mode: 0o700, recursive: true });
        writeFileSync(
          path.join(root, "observer-error.json"),
          JSON.stringify({
            reason:
              "Preview observation storage or ledger was unavailable; public session was not changed.",
            status: "incomplete",
          }),
          { mode: 0o600 },
        );
      } catch {
        /* Evidence storage itself is unavailable. */
      }
    }
  };
  return {
    finish: async () => {
      await Promise.all(jobs);
    },
    observe,
  };
};
