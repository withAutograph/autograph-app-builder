import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
/* oxlint-disable eslint/no-await-in-loop, sonarjs/expression-complexity, sonarjs/no-nested-functions, react-doctor/async-await-in-loop, react-doctor/js-cache-property-access -- Provider effects and durable checkpoints are intentionally sequential. */
import { z } from "zod";
import type { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { HostedOperatorError, restrictedOperatorEnvironment } from "./hosted-operator-contract";
import type {
  ProtectedAppEnvironment,
  ManagedOperatorEnvironmentRow,
} from "./hosted-operator-contract";
import type {
  HostedOperatorManagedEnvironmentContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";

import {
  matchesPreviewEnvironmentGitBranch,
  resolveNativePreviewEnvironmentGitBranch,
  savedPreviewEnvironmentGitBranch,
} from "./native-preview-environment-scope";
import { reportHostedEnvironmentBindingFailure } from "./hosted-operator-consent-diagnostic";
import type {
  HostedEnvironmentBindingFailure,
  HostedOperatorConsentDiagnosticSink,
} from "./hosted-operator-consent-diagnostic";

const providerRow = z.object({
  comment: z.string().optional(),
  configurationId: z.string().nullable().optional(),
  gitBranch: z.string().nullable().optional(),
  id: z.string().min(1),
  key: z.string().min(1),
  target: z.array(z.string()),
  type: z.string(),
});
type ProviderRow = z.infer<typeof providerRow>;
const unavailable = () => new HostedOperatorError("operator_unavailable");
const providerErrorLimit = 8 * 1024;
const providerErrorDeadlineMs = 200;
const gitReferenceToken = /(?:git|repository|branch)/iu;
const cancelProviderReader = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  try {
    await reader.cancel();
  } catch {
    /* A provider response body is advisory and cancellation cannot change its rejection. */
  }
};
type ProviderChunkRead = ReadableStreamReadResult<Uint8Array> | { timedOut: true };
const readProviderChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remainingMs: number,
): Promise<ProviderChunkRead> => {
  const timerAbort = new AbortController();
  try {
    const result: ProviderChunkRead = await Promise.race([
      reader.read(),
      delay<{ timedOut: true }>(remainingMs, { timedOut: true }, { signal: timerAbort.signal }),
    ]);
    return result;
  } finally {
    timerAbort.abort();
  }
};
const readProviderFailure = async (response: Response) => {
  let text = "";
  const { body } = response;
  if (body === null) {
    return false;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let releaseReader = true;
  try {
    reader = body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    const deadline = Date.now() + providerErrorDeadlineMs;
    while (size < providerErrorLimit) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        releaseReader = false;
        void cancelProviderReader(reader);
        return false;
      }
      const read = await readProviderChunk(reader, remainingMs);
      if ("timedOut" in read) {
        releaseReader = false;
        void cancelProviderReader(reader);
        return false;
      }
      if (read.done) {
        text += decoder.decode();
        break;
      }
      const remaining = providerErrorLimit - size;
      const part = read.value.subarray(0, remaining);
      size += part.byteLength;
      text += decoder.decode(part, { stream: size < providerErrorLimit });
      if (part.byteLength < read.value.byteLength || size >= providerErrorLimit) {
        releaseReader = false;
        void cancelProviderReader(reader);
        return false;
      }
    }
  } catch {
    if (reader !== undefined) {
      releaseReader = false;
      void cancelProviderReader(reader);
    }
    return false;
  } finally {
    if (reader !== undefined && releaseReader) {
      reader.releaseLock();
    }
  }
  try {
    const parsed = z
      .object({
        error: z.object({ code: z.string().optional(), message: z.string().optional() }),
      })
      .safeParse(JSON.parse(text));
    return (
      parsed.success &&
      ((parsed.data.error.code !== undefined && gitReferenceToken.test(parsed.data.error.code)) ||
        (parsed.data.error.message !== undefined &&
          gitReferenceToken.test(parsed.data.error.message)))
    );
  } catch {
    return false;
  }
};
const providerRequestStage = (
  method: string,
  route: string,
  override?: HostedEnvironmentBindingFailure["stage"],
): HostedEnvironmentBindingFailure["stage"] => {
  if (override !== undefined) {
    return override;
  }
  if (method === "POST") {
    return "create_post";
  }
  if (method === "PATCH") {
    return "update_patch";
  }
  if (method === "DELETE") {
    return "delete_request";
  }
  if (route.startsWith("/v9/projects/")) {
    return "project_read";
  }
  return route.startsWith("/v10/projects/") ? "environment_list" : "environment_value_read";
};
const hasCredentialBinding = (
  credential: Awaited<ReturnType<typeof readActiveVercelInstallationToken>>,
  target: HostedOperatorManagedEnvironmentContext["target"],
): credential is NonNullable<Awaited<ReturnType<typeof readActiveVercelInstallationToken>>> =>
  credential !== null &&
  credential !== undefined &&
  credential.binding.active &&
  credential.binding.installationId === target.installationId &&
  credential.binding.scopeId === target.scopeId &&
  credential.binding.scopeType === target.scopeType;
const providerRejection = async (response: Response) => {
  const gitRelated = await readProviderFailure(response);
  const httpStatus = response.status >= 100 && response.status <= 599 ? response.status : undefined;
  const { body, bodyUsed } = response;
  if (body !== null && !body.locked && !bodyUsed) {
    await body.cancel();
  }
  return {
    httpStatus,
    reason: gitRelated ? "git_reference_rejection" : "provider_rejected",
  } as const;
};
const createFailureReporter = (
  sessionId: string,
  sink: HostedOperatorConsentDiagnosticSink | undefined,
) => {
  const failure: HostedEnvironmentBindingFailure = {
    stage: "input_validation",
    reason: "input_rejected",
  };
  return {
    stage: () => failure.stage,
    set: (
      stage: HostedEnvironmentBindingFailure["stage"],
      reason: HostedEnvironmentBindingFailure["reason"],
      httpStatus?: number,
    ) => {
      failure.stage = stage;
      failure.reason = reason;
      if (httpStatus === undefined) {
        delete failure.httpStatus;
      } else {
        failure.httpStatus = httpStatus;
      }
    },
    report: () => {
      reportHostedEnvironmentBindingFailure(sessionId, failure, sink);
    },
  };
};
export const createHostedOperatorEnvironmentBindings = (deps: {
  readCredential: (
    authority: HostedOperatorManagedEnvironmentContext["authority"],
    installationId: string,
  ) => ReturnType<typeof readActiveVercelInstallationToken>;
  assertAuthorized: ProtectedHostedOperatorDependencies["assertAuthorized"];
  fetch?: typeof fetch;
  diagnosticSink?: HostedOperatorConsentDiagnosticSink;
}) => {
  const open = (
    input: HostedOperatorManagedEnvironmentContext,
    values: ProtectedAppEnvironment,
    diagnostics: ReturnType<typeof createFailureReporter>,
  ) => {
    const expected = restrictedOperatorEnvironment(input.plan, values, input.authority);
    const { target } = input;
    const boundary = input.plan.deploymentBoundary;
    if (
      !boundary ||
      target.environment !== "preview" ||
      target.projectId !== boundary.app.projectId ||
      target.scopeId !== boundary.teamId ||
      target.scopeType !== "team"
    ) {
      throw unavailable();
    }
    // The approved publication ref is independent of the resource journal's branch.
    const deploymentTarget = { ...target, branch: boundary.app.branch };
    const comment = `App Builder protected operator ${input.operationRef}`;
    const guard = async () => {
      try {
        await input.assertCurrent();
        await deps.assertAuthorized(input);
      } catch (error) {
        diagnostics.set(diagnostics.stage(), "authorization_rejected");
        throw error;
      }
    };
    const request = async (
      route: string,
      method = "GET",
      body?: {
        comment?: string;
        gitBranch?: string;
        key?: string;
        target?: string[];
        type: "encrypted";
        value: string;
      },
      diagnosticStage?: HostedEnvironmentBindingFailure["stage"],
    ) => {
      const requestStage = providerRequestStage(method, route, diagnosticStage);
      diagnostics.set(requestStage, "provider_request_failed");
      await guard();
      diagnostics.set("credential_read", "credential_read_failed");
      const credential = await deps.readCredential(input.authority, target.installationId);
      if (!hasCredentialBinding(credential, target)) {
        diagnostics.set("credential_read", "credential_unavailable");
        throw new HostedOperatorError("authorization_required");
      }
      diagnostics.set(requestStage, "provider_request_failed");
      await guard();
      const url = new URL(route, "https://api.vercel.com");
      url.searchParams.set("teamId", target.scopeId);
      const options: RequestInit = {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${credential.token}`,
          "Content-Type": "application/json",
        },
        method,
        redirect: "error",
      };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
      const response = await (deps.fetch ?? fetch)(url, options);
      await guard();
      if (!response.ok) {
        const providerFailure = await providerRejection(response);
        diagnostics.set(requestStage, providerFailure.reason, providerFailure.httpStatus);
        throw unavailable();
      }
      if (response.status === 204) {
        return null;
      }
      diagnostics.set(requestStage, "provider_response_invalid");
      const result: unknown = await response.json();
      await guard();
      return result;
    };
    let writeGitBranch: Promise<string | null> | undefined;
    const previewGitBranch = (diagnosticStage?: HostedEnvironmentBindingFailure["stage"]) => {
      writeGitBranch ??= (async () => {
        const project = await request(
          `/v9/projects/${encodeURIComponent(target.projectId)}`,
          "GET",
          undefined,
          diagnosticStage,
        );
        const observed = z.object({ id: z.string(), accountId: z.string() }).parse(project);
        if (observed.id !== target.projectId || observed.accountId !== target.scopeId) {
          throw unavailable();
        }
        return resolveNativePreviewEnvironmentGitBranch(deploymentTarget.branch, project);
      })();
      return writeGitBranch;
    };
    const list = async (diagnosticStage?: HostedEnvironmentBindingFailure["stage"]) =>
      z
        .object({ envs: z.array(providerRow) })
        .parse(
          await request(
            `/v10/projects/${encodeURIComponent(target.projectId)}/env`,
            "GET",
            undefined,
            diagnosticStage,
          ),
        ).envs;
    const relevant = (row: ProviderRow) =>
      row.target.includes("preview") &&
      (row.gitBranch === null ||
        row.gitBranch === undefined ||
        row.gitBranch === deploymentTarget.branch) &&
      Object.hasOwn(expected, row.key);
    const owned = (row: ProviderRow, gitBranch: string | null) => {
      const known = (input.managedEnvironment ?? []).find((saved) => saved.id === row.id);
      return (
        row.target.length === 1 &&
        row.target[0] === "preview" &&
        (known === undefined
          ? matchesPreviewEnvironmentGitBranch(row.gitBranch, gitBranch) ||
            row.gitBranch === deploymentTarget.branch
          : matchesPreviewEnvironmentGitBranch(
              row.gitBranch,
              savedPreviewEnvironmentGitBranch(known),
            )) &&
        (row.configurationId === undefined ||
          row.configurationId === null ||
          row.configurationId === "" ||
          row.configurationId === target.installationId) &&
        row.type === "encrypted" &&
        (row.comment === comment ||
          (input.managedEnvironment ?? []).some(
            (saved) =>
              saved.id === row.id && saved.key === row.key && saved.comment === row.comment,
          ))
      );
    };
    const reference = (row: ProviderRow): ManagedOperatorEnvironmentRow => {
      const known = (input.managedEnvironment ?? []).find((saved) => saved.id === row.id);
      return {
        ...(known ?? { gitBranch: row.gitBranch ?? null }),
        branch: deploymentTarget.branch,
        comment: z.string().min(1).parse(row.comment),
        id: row.id,
        key: row.key,
        operationRef: known?.operationRef ?? input.operationRef,
        projectId: target.projectId,
      };
    };
    const validateKnown = () => {
      const known = input.managedEnvironment ?? [];
      if (
        new Set(known.map((row) => row.id)).size !== known.length ||
        new Set(known.map((row) => row.key)).size !== known.length ||
        known.some(
          (row) =>
            row.branch !== deploymentTarget.branch ||
            row.projectId !== target.projectId ||
            row.comment !== `App Builder protected operator ${row.operationRef}` ||
            !Object.hasOwn(expected, row.key),
        )
      ) {
        throw unavailable();
      }
      return known;
    };
    const inspect = async (
      verifyValues = true,
      diagnosticStage?: HostedEnvironmentBindingFailure["stage"],
    ) => {
      const known = validateKnown();
      const [gitBranch, listed] = await Promise.all([
        previewGitBranch(diagnosticStage),
        list(diagnosticStage),
      ]);
      const rows = listed.filter(relevant);
      if (
        rows.some((row) => !owned(row, gitBranch)) ||
        new Set(rows.map((row) => row.key)).size !== rows.length ||
        known.some((row) => rows.some((actual) => actual.key === row.key && actual.id !== row.id))
      ) {
        throw unavailable();
      }
      for (const row of verifyValues ? rows : []) {
        const plaintext = z
          .object({ value: z.string() })
          .parse(
            await request(
              `/v1/projects/${encodeURIComponent(target.projectId)}/env/${encodeURIComponent(row.id)}`,
              "GET",
              undefined,
              diagnosticStage,
            ),
          );
        if (plaintext.value !== expected[row.key]) {
          throw unavailable();
        }
      }
      return rows;
    };
    const checkpoint = async (rows: ProviderRow[]) => {
      diagnostics.set("checkpoint", "checkpoint_failed");
      await guard();
      await input.checkpointManagedEnvironment(rows.map(reference));
      await guard();
    };
    const inspectCleanup = async () => {
      const approved = input.plan.appEnvironmentCleanup;
      if (
        approved === undefined ||
        input.plan.action !== "cleanup" ||
        input.effect.kind !== "remove-bindings"
      ) {
        throw unavailable();
      }
      const known = input.managedEnvironment ?? [];
      if (known.some((row) => !approved.some((allowed) => isDeepStrictEqual(allowed, row)))) {
        throw unavailable();
      }
      const listed = await list();
      return known.filter((row) => {
        const actual = listed.find((item) => item.id === row.id);
        if (!actual) {
          return false;
        }
        if (
          row.projectId !== target.projectId ||
          actual.key !== row.key ||
          !matchesPreviewEnvironmentGitBranch(
            actual.gitBranch,
            savedPreviewEnvironmentGitBranch(row),
          ) ||
          actual.comment !== row.comment ||
          actual.type !== "encrypted" ||
          actual.target.length !== 1 ||
          actual.target[0] !== "preview" ||
          (actual.configurationId !== undefined &&
            actual.configurationId !== null &&
            actual.configurationId !== "" &&
            actual.configurationId !== target.installationId)
        ) {
          throw unavailable();
        }
        return true;
      });
    };
    const checkpointCleanup = async (rows: ManagedOperatorEnvironmentRow[]) => {
      await guard();
      await input.checkpointManagedEnvironment(rows);
      await guard();
    };
    return {
      checkpoint,
      checkpointCleanup,
      inspectCleanup,
      comment,
      expected,
      guard,
      inspect,
      reference,
      previewGitBranch,
      request,
      target: deploymentTarget,
    };
  };
  return {
    async bind(input: HostedOperatorManagedEnvironmentContext, values: ProtectedAppEnvironment) {
      const diagnostics = createFailureReporter(input.target.sessionId, deps.diagnosticSink);
      try {
        if (input.plan.action !== "prepare" || input.effect.kind !== "bindings") {
          throw unavailable();
        }
        const io = open(input, values, diagnostics);
        let rows = await io.inspect(false);
        await io.checkpoint(rows);
        for (const [key, value] of Object.entries(io.expected)) {
          const existing = rows.find((row) => row.key === key);
          if (existing) {
            const plaintext = z
              .object({ value: z.string() })
              .parse(
                await io.request(
                  `/v1/projects/${encodeURIComponent(io.target.projectId)}/env/${encodeURIComponent(existing.id)}`,
                ),
              );
            if (plaintext.value === value) {
              continue;
            }
            await io.request(
              `/v9/projects/${encodeURIComponent(io.target.projectId)}/env/${encodeURIComponent(existing.id)}`,
              "PATCH",
              { type: "encrypted", value },
            );
          } else {
            const gitBranch = await io.previewGitBranch();
            await io.request(
              `/v10/projects/${encodeURIComponent(io.target.projectId)}/env`,
              "POST",
              {
                comment: io.comment,
                ...(gitBranch === null ? {} : { gitBranch }),
                key,
                target: ["preview"],
                type: "encrypted",
                value,
              },
            );
          }
          rows = await io.inspect(false, "readback");
          const observed = rows.find((row) => row.key === key);
          if (!observed) {
            throw unavailable();
          }
          const plaintext = z
            .object({ value: z.string() })
            .parse(
              await io.request(
                `/v1/projects/${encodeURIComponent(io.target.projectId)}/env/${encodeURIComponent(observed.id)}`,
                "GET",
                undefined,
                "readback",
              ),
            );
          if (plaintext.value !== value) {
            throw unavailable();
          }
          await io.checkpoint(rows);
        }
        await io.inspect(true, "readback");
        return { rows: rows.map(io.reference) };
      } catch {
        diagnostics.report();
        throw unavailable();
      }
    },
    async reconcile(
      input: HostedOperatorManagedEnvironmentContext,
      values: ProtectedAppEnvironment,
    ): Promise<
      | { status: "absent" | "unknown" }
      | { status: "applied"; rows: ManagedOperatorEnvironmentRow[] }
    > {
      const diagnostics = createFailureReporter(input.target.sessionId, deps.diagnosticSink);
      try {
        const io = open(input, values, diagnostics);
        if (input.plan.appEnvironmentCleanup !== undefined) {
          const rows = await io.inspectCleanup();
          await io.checkpointCleanup(rows);
          return rows.length === 0 ? { status: "absent" } : { rows, status: "applied" };
        }
        const rows = await io.inspect();
        if (rows.length === 0) {
          return { status: "absent" };
        }
        await io.checkpoint(rows);
        return rows.length === Object.keys(io.expected).length
          ? { rows: rows.map(io.reference), status: "applied" }
          : { status: "unknown" };
      } catch {
        diagnostics.report();
        return { status: "unknown" };
      }
    },
    async remove(input: HostedOperatorManagedEnvironmentContext, values: ProtectedAppEnvironment) {
      const diagnostics = createFailureReporter(input.target.sessionId, deps.diagnosticSink);
      try {
        if (input.plan.action !== "cleanup" || input.effect.kind !== "remove-bindings") {
          throw unavailable();
        }
        const io = open(input, values, diagnostics);
        if (input.plan.appEnvironmentCleanup !== undefined) {
          let remaining = await io.inspectCleanup();
          await io.checkpointCleanup(remaining);
          for (const row of remaining) {
            const current = await io.inspectCleanup();
            if (!current.some((item) => item.id === row.id)) {
              continue;
            }
            await io.request(
              `/v9/projects/${encodeURIComponent(row.projectId)}/env/${encodeURIComponent(row.id)}`,
              "DELETE",
            );
            remaining = await io.inspectCleanup();
            if (remaining.some((item) => item.id === row.id)) {
              throw unavailable();
            }
            await io.checkpointCleanup(remaining);
          }
          return { rows: remaining };
        }
        let rows = await io.inspect(false);
        const known = input.managedEnvironment ?? [];
        if (rows.some((row) => !known.some((item) => item.id === row.id && item.key === row.key))) {
          throw unavailable();
        }
        for (const row of rows) {
          // Re-observe exact ownership/value before each deletion; never delete by key.
          const current = await io.inspect(false);
          if (!current.some((item) => item.id === row.id)) {
            continue;
          }
          await io.request(
            `/v9/projects/${encodeURIComponent(io.target.projectId)}/env/${encodeURIComponent(row.id)}`,
            "DELETE",
          );
          rows = await io.inspect(false);
          if (rows.some((item) => item.id === row.id)) {
            throw unavailable();
          }
          await io.checkpoint(rows);
        }
        const emptyRows: ManagedOperatorEnvironmentRow[] = [];
        return { rows: emptyRows };
      } catch {
        diagnostics.report();
        throw unavailable();
      }
    },
    async verifyForDelivery(
      input: HostedOperatorManagedEnvironmentContext,
      values: ProtectedAppEnvironment,
    ) {
      const diagnostics = createFailureReporter(input.target.sessionId, deps.diagnosticSink);
      try {
        if (input.effect.kind !== "delivery" || input.plan.delivery === undefined) {
          throw unavailable();
        }
        const io = open(input, values, diagnostics);
        const rows = await io.inspect();
        if (rows.length !== Object.keys(io.expected).length) {
          throw unavailable();
        }
        await io.guard();
        return { rows: rows.map(io.reference) };
      } catch (error) {
        diagnostics.report();
        throw error;
      }
    },
  };
};
