import { once } from "node:events";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PublicState } from "./self-reproduction-public";

const entrySchema = z.object({
  captureReport: z
    .string()
    .regex(/^[a-f0-9]{64}\/capture\/report\.json$/u)
    .optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  exitCode: z.number().int().nullable().optional(),
  finishedAt: z.iso.datetime().optional(),
  startedAt: z.iso.datetime().optional(),
  status: z.enum(["running", "finished", "failed", "expired", "incomplete", "timed_out"]),
});
const ledgerSchema = z.array(entrySchema);
type Entry = z.infer<typeof entrySchema>;
export interface PreviewCaptureInvocation {
  signal: AbortSignal;
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
    { cwd: input.repositoryRoot, detached: process.platform !== "win32", stdio: "ignore" },
  );
  const stopOwnedProcess = () => {
    try {
      if (child.pid !== undefined && process.platform !== "win32") {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      // The owned process group may have already exited.
    }
  };
  input.signal.addEventListener("abort", stopOwnedProcess, { once: true });
  if (input.signal.aborted) {
    stopOwnedProcess();
  }
  try {
    await once(child, "exit");
    return child.exitCode ?? 1;
  } finally {
    input.signal.removeEventListener("abort", stopOwnedProcess);
  }
};

/** Observes receipts only: no MCP calls, generation commands, approvals, or replies. */
export const createAutomaticPreviewObserver = (input: {
  outputDir: string;
  repositoryRoot: string;
  execute?: (invocation: PreviewCaptureInvocation) => Promise<number>;
  now?: () => number;
  timeoutMs?: number;
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
    const links = [...entries.values()]
      .map(
        (entry) =>
          `<li>${entry.digest}: ${entry.status}; exit ${entry.exitCode ?? "unavailable"} <a href="${entry.digest}/capture/index.html">Capture report</a></li>`,
      )
      .join("");
    writeFileSync(
      path.join(root, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>Preview observations</title><h1>Preview observations</h1><p>Runner completion is not a product verdict. Missing capture reports remain incomplete evidence.</p><a href="ledger.json">Sanitized runner ledger</a><ul>${links}</ul>`,
      { mode: 0o600 },
    );
  };
  const initialize = () => {
    if (initialized) {
      return;
    }
    mkdirSync(root, { mode: 0o700, recursive: true });
    if (existsSync(ledgerFile)) {
      for (const entry of ledgerSchema.parse(JSON.parse(readFileSync(ledgerFile, "utf-8")))) {
        entries.set(entry.digest, {
          ...entry,
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
      writeFileSync(
        stateFile,
        JSON.stringify({
          outcome: state.outcome,
          session: {
            sessionId: state.session?.sessionId,
            status: state.session?.status,
            workingPreview: receipt,
          },
          sourceRevision: state.sourceRevision,
        }),
        { mode: 0o600 },
      );
      const entry: Entry = {
        captureReport: `${digest}/capture/report.json`,
        digest,
        exitCode: null,
        startedAt: new Date((input.now ?? Date.now)()).toISOString(),
        status: Date.parse(receipt.expiresAt) <= (input.now ?? Date.now)() ? "expired" : "running",
      };
      if (entry.status === "expired") {
        entry.finishedAt = entry.startedAt;
      }
      entries.set(digest, entry);
      persist();
      if (entry.status === "expired") {
        return;
      }
      // Call immediately, then retain its asynchronous completion without delaying polling.
      const job = (async () => {
        const controller = new AbortController();
        const timeout = Promise.withResolvers<null>();
        const timer = setTimeout(() => {
          controller.abort();
          timeout.resolve(null);
        }, input.timeoutMs ?? 180_000);
        try {
          const execution = (input.execute ?? executePreviewCapture)({
            outputDir: path.join(directory, "capture"),
            repositoryRoot: input.repositoryRoot,
            signal: controller.signal,
            stateFile,
          });
          const code = await Promise.race([execution, timeout.promise]);
          entry.exitCode = code;
          entry.status = code === 0 ? "finished" : "failed";
          if (code === null) {
            entry.status = "timed_out";
          }
        } catch {
          entry.status = controller.signal.aborted ? "timed_out" : "failed";
        } finally {
          clearTimeout(timer);
          entry.finishedAt = new Date((input.now ?? Date.now)()).toISOString();
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
