/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop, sonarjs/no-nested-functions -- Provider readbacks and durable checkpoints retain one current owner fence through ordered effects. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { ManagedOperatorEnvironmentRow } from "./hosted-operator-contract";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import { createHostedOperatorDeploymentDelivery } from "./hosted-operator-deployment-delivery";
import type {
  HostedOperatorContext,
  HostedOperatorDeploymentContext,
} from "./hosted-operator-service";
import type { HostedContinuityDependencies } from "./hosted-operator-continuity";
import {
  continuityRecordSchema,
  parseContinuityPlanForOwner,
} from "./hosted-operator-continuity-contract";
import type {
  ContinuityCapabilities,
  ContinuityRecord,
} from "./hosted-operator-continuity-contract";
import {
  matchesPreviewEnvironmentGitBranch,
  resolveNativePreviewEnvironmentGitBranch,
  savedPreviewEnvironmentGitBranch,
} from "./native-preview-environment-scope";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new HostedOperatorError("reconciliation_required");
const mismatch = () => new HostedOperatorError("resource_mismatch");
const providerRowSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  type: z.string(),
  target: z.array(z.string()),
  gitBranch: z.string().nullable().optional(),
  comment: z.string().optional(),
  configurationId: z.string().nullable().optional(),
});
type Patch = Partial<
  Pick<
    ContinuityRecord,
    "environmentRows" | "environmentWrites" | "deliveryCandidates" | "deliveryAttempted"
  >
>;
type CredentialReader = Awaited<
  ReturnType<typeof createHostedOperatorControlPlane>
>["readCredential"];

const namesFor = (intentId: string) => {
  const suffix = intentId.replaceAll("-", "").toUpperCase();
  return [
    `PLATFORM_GATEWAY_MANAGED_TARGET_${suffix}`,
    `PLATFORM_GATEWAY_MANAGED_TRANSPORT_${suffix}`,
  ] as const;
};
const capability = (value: string) =>
  /^[A-Za-z0-9_-]{43}$/u.test(value) &&
  Buffer.from(value, "base64url").length === 32 &&
  Buffer.from(value, "base64url").toString("base64url") === value;

const expectedPublication = (
  context: HostedOperatorContext,
  record: ContinuityRecord,
  capabilities: ContinuityCapabilities,
) => {
  const { projection, current, approval, locator, plan } = record;
  if (
    projection === undefined ||
    current === undefined ||
    approval === undefined ||
    locator === undefined
  ) {
    throw mismatch();
  }
  if (
    !capability(capabilities.suiteSelector) ||
    !capability(capabilities.transport) ||
    capabilities.suiteSelector === capabilities.transport
  ) {
    throw mismatch();
  }
  const common = {
    intentId: record.requestId,
    approvalRef: approval.approvalId,
    owner: { ...context.authority, sessionId: context.target.sessionId },
    appId: context.target.appId,
    runtimeAttemptId: record.attemptId,
    fence: record.fence,
  };
  const observedCommon = {
    intentId: projection.intentId,
    approvalRef: projection.approvalRef,
    owner: projection.owner,
    appId: projection.appId,
    runtimeAttemptId: projection.runtimeAttemptId,
    fence: projection.fence,
  };
  const { expiresAt, ...observedTarget } = projection.observation;
  const valid = [
    isDeepStrictEqual(observedCommon, common),
    isDeepStrictEqual(current, {
      ...common,
      sandboxId: plan.runtime.sandboxId,
      providerSessionId: locator.providerSessionId,
      state: current.state,
      leaseExpiresAt: current.leaseExpiresAt,
    }),
    projection.preparedOperationRef === plan.originalSetup.operationRef,
    isDeepStrictEqual(projection.gateway, plan.gateway),
    isDeepStrictEqual(projection.actors, plan.actors),
    projection.approvedTarget.projectId === plan.runtime.projectId,
    projection.approvedTarget.ownerId === plan.runtime.ownerId,
    projection.approvedTarget.bridgePort === plan.runtime.bridgePort,
    projection.approvedTarget.sandboxId === plan.runtime.sandboxId,
    projection.approvedTarget.providerSessionId === locator.providerSessionId,
    locator.sandboxId === plan.runtime.sandboxId,
    locator.attemptId === record.attemptId,
    isDeepStrictEqual(projection.approvedTarget, observedTarget),
    projection.state === "ready",
    current.state === "ready",
    Date.parse(current.leaseExpiresAt) > Date.now(),
    Date.parse(expiresAt) > Date.now(),
    projection.suiteSelectorSha256 === hash(capabilities.suiteSelector),
    projection.transportSha256 === hash(capabilities.transport),
    approval.planRef === plan.planRef,
    approval.planDigest === record.planDigest,
    approval.idempotencyKey === record.idempotencyKey,
  ].every(Boolean);
  if (!valid) {
    throw mismatch();
  }
  const [targetKey, transportKey] = namesFor(record.requestId);
  return new Map([
    [targetKey, JSON.stringify({ projection, current })],
    [transportKey, capabilities.transport],
  ]);
};

/** Private publisher only. Pending digests and row references contain no capability bytes. */
export const createHostedManagedRuntimeProjection = (deps: {
  assertOwner: (context: HostedOperatorContext) => Promise<void>;
  readCredential: CredentialReader;
  fetch?: typeof fetch;
}): HostedContinuityDependencies["projection"] => {
  const open = (
    context: HostedOperatorContext,
    initial: ContinuityRecord,
    assertCurrent: () => Promise<void>,
  ) => {
    let record = continuityRecordSchema.parse(initial);
    parseContinuityPlanForOwner(record.plan, context);
    const { gateway, preparedPlan } = record.plan;
    const delivery = preparedPlan.gatewayDelivery;
    const publicGateway = preparedPlan.publicGateway;
    if (publicGateway === undefined || delivery === undefined) {
      throw mismatch();
    }
    if (
      ![
        gateway.ownerId === context.target.scopeId,
        gateway.environment === "preview",
        publicGateway.projectId === gateway.projectId,
        publicGateway.origin === gateway.publicOrigin,
        delivery.projectId === gateway.projectId,
        delivery.branch === publicGateway.branch,
        preparedPlan.action === "prepare",
      ].every(Boolean)
    ) {
      throw mismatch();
    }
    const keys = namesFor(record.requestId);
    const selectedKeys = new Set<string>(keys);
    const comment = `App Builder managed runtime ${record.requestId}`;
    const guard = async () => {
      await deps.assertOwner(context);
      await assertCurrent();
    };
    const request = async (
      route: string,
      method: "GET" | "POST" | "DELETE" = "GET",
      body?: {
        key: string;
        value: string;
        type: "encrypted";
        target: string[];
        gitBranch?: string;
        comment: string;
      },
      allowMissing = false,
    ) => {
      await guard();
      const credential = await deps.readCredential(
        context.authority,
        context.target.installationId,
      );
      if (
        credential?.binding.active !== true ||
        credential.binding.installationId !== context.target.installationId ||
        credential.binding.scopeId !== context.target.scopeId ||
        credential.binding.scopeType !== context.target.scopeType
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      await guard();
      const url = new URL(route, "https://api.vercel.com");
      if (context.target.scopeType === "team") {
        url.searchParams.set("teamId", context.target.scopeId);
      }
      let response: Response;
      try {
        response = await (deps.fetch ?? fetch)(url, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.token}`,
            "Content-Type": "application/json",
          },
        });
      } catch {
        throw unavailable();
      }
      try {
        if (allowMissing && response.status === 404) {
          await guard();
          return null;
        }
        if (!response.ok) {
          throw unavailable();
        }
        const value = response.status === 204 ? null : z.json().parse(await response.json());
        await guard();
        return value;
      } catch (error) {
        if (error instanceof HostedOperatorError) {
          throw error;
        }
        throw unavailable();
      } finally {
        if (!response.bodyUsed) {
          await response.body?.cancel();
        }
      }
    };
    const inspect = async () => {
      const project = z
        .object({
          id: z.string(),
          accountId: z.string(),
          link: z
            .object({ productionBranch: z.string().nullable().optional() })
            .nullable()
            .optional(),
        })
        .parse(await request(`/v9/projects/${encodeURIComponent(gateway.projectId)}`));
      if (project.id !== gateway.projectId || project.accountId !== gateway.ownerId) {
        throw mismatch();
      }
      const gitBranch = resolveNativePreviewEnvironmentGitBranch(delivery.branch, project);
      const listed = z
        .object({ envs: z.array(providerRowSchema) })
        .parse(await request(`/v10/projects/${encodeURIComponent(gateway.projectId)}/env`)).envs;
      const selected = listed.filter(
        (row) =>
          selectedKeys.has(row.key) &&
          row.target.includes("preview") &&
          matchesPreviewEnvironmentGitBranch(row.gitBranch, gitBranch),
      );
      if (
        new Set(selected.map((row) => row.key)).size !== selected.length ||
        selected.some(
          (row) =>
            row.target.length !== 1 ||
            row.type !== "encrypted" ||
            (row.configurationId !== null && row.configurationId !== undefined),
        )
      ) {
        throw unavailable();
      }
      const listedById = new Map(listed.map((row) => [row.id, row]));
      for (const saved of record.environmentRows) {
        if (
          ![
            selectedKeys.has(saved.key),
            saved.operationRef === record.requestId,
            saved.projectId === gateway.projectId,
            saved.branch === delivery.branch,
            savedPreviewEnvironmentGitBranch(saved) === gitBranch,
          ].every(Boolean)
        ) {
          throw mismatch();
        }
        if (selected.some((row) => row.key === saved.key && row.id !== saved.id)) {
          throw unavailable();
        }
        const actual = listedById.get(saved.id);
        if (
          actual !== undefined &&
          !selected.some((row) => row.id === saved.id && row.key === saved.key)
        ) {
          throw unavailable();
        }
        if (actual === undefined) {
          const missing = await request(
            `/v1/projects/${encodeURIComponent(gateway.projectId)}/env/${encodeURIComponent(saved.id)}`,
            "GET",
            undefined,
            true,
          );
          if (missing !== null) {
            throw unavailable();
          }
        }
      }
      const values = new Map<string, string>();
      const savedRows = new Map(record.environmentRows.map((row) => [row.id, row]));
      const pendingWrites = new Map(record.environmentWrites.map((write) => [write.key, write]));
      for (const row of selected) {
        const value = z
          .object({ value: z.string() })
          .parse(
            await request(
              `/v1/projects/${encodeURIComponent(gateway.projectId)}/env/${encodeURIComponent(row.id)}`,
            ),
          ).value;
        const saved = savedRows.get(row.id);
        const pending = pendingWrites.get(row.key);
        if (
          saved === undefined ? pending?.sha256 !== hash(value) : saved.valueSha256 !== hash(value)
        ) {
          throw unavailable();
        }
        values.set(row.id, value);
      }
      await guard();
      return { rows: selected, values, gitBranch };
    };
    const references = (
      observed: Awaited<ReturnType<typeof inspect>>,
    ): ManagedOperatorEnvironmentRow[] =>
      observed.rows.map((row) => ({
        id: row.id,
        key: row.key,
        projectId: gateway.projectId,
        branch: delivery.branch,
        gitBranch: observed.gitBranch,
        operationRef: record.requestId,
        comment: row.comment ?? comment,
        valueSha256: hash(observed.values.get(row.id) ?? ""),
      }));
    return {
      keys,
      comment,
      guard,
      request,
      inspect,
      references,
      get record() {
        return record;
      },
      setRecord(patch: Patch) {
        record = { ...record, ...structuredClone(patch) };
      },
    };
  };
  const implementation: HostedContinuityDependencies["projection"] = {
    async publish(context, initial, capabilities, assertCurrent, checkpoint) {
      const io = open(context, initial, assertCurrent);
      const { plan } = io.record;
      const expected = expectedPublication(context, io.record, capabilities);
      const persist = async (patch: Patch) => {
        await io.guard();
        await checkpoint(patch);
        io.setRecord(patch);
        await io.guard();
      };
      for (const [key, value] of expected) {
        let observed = await io.inspect();
        const row = observed.rows.find((item) => item.key === key);
        if (row !== undefined) {
          if (observed.values.get(row.id) !== value) {
            throw unavailable();
          }
          await persist({ environmentRows: io.references(observed) });
          continue;
        }
        if (
          io.record.environmentRows.some((saved) => saved.key === key) ||
          io.record.environmentWrites.some((write) => write.key === key)
        ) {
          throw unavailable();
        }
        await persist({
          environmentWrites: [...io.record.environmentWrites, { key, sha256: hash(value) }],
        });
        await io.guard();
        // The durable marker precedes POST. An uncertain response can only reconcile this exact value.
        await io.request(
          `/v10/projects/${encodeURIComponent(plan.gateway.projectId)}/env`,
          "POST",
          {
            key,
            value,
            type: "encrypted",
            target: ["preview"],
            ...(observed.gitBranch === null ? {} : { gitBranch: observed.gitBranch }),
            comment: io.comment,
          },
        );
        observed = await io.inspect();
        if (
          !observed.rows.some((item) => item.key === key && observed.values.get(item.id) === value)
        ) {
          throw unavailable();
        }
        await persist({ environmentRows: io.references(observed) });
      }
      const verifyPair = async () => {
        const observed = await io.inspect();
        if (
          observed.rows.length !== expected.size ||
          [...expected].some(
            ([key, value]) =>
              !observed.rows.some(
                (row) => row.key === key && observed.values.get(row.id) === value,
              ),
          )
        ) {
          throw unavailable();
        }
        await persist({ environmentRows: io.references(observed) });
      };
      const effect = plan.preparedPlan.effects.find((item) => item.kind === "gateway-delivery");
      if (effect === undefined) {
        throw mismatch();
      }
      const deliveryContext: HostedOperatorDeploymentContext = {
        ...context,
        plan: plan.preparedPlan,
        effect,
        operationRef: io.record.requestId,
        fenceGeneration: io.record.fence,
        workerCheckpoints: [],
        assertCurrent: io.guard,
        checkpoint: () => Promise.reject(mismatch()),
        deliveryCandidates: io.record.deliveryCandidates,
        checkpointDelivery: async (candidates) => {
          await persist({ deliveryCandidates: [...candidates] });
          deliveryContext.deliveryCandidates = io.record.deliveryCandidates;
        },
      };
      const delivery = createHostedOperatorDeploymentDelivery({
        target: "gateway",
        readCredential: deps.readCredential,
        fetch: deps.fetch,
        assertAuthorized: io.guard,
        assertEnvironment: verifyPair,
        beforeCreate: async () => {
          if (io.record.deliveryAttempted === true) {
            throw unavailable();
          }
          await persist({ deliveryAttempted: true });
        },
      });
      const result = await delivery.deliver(deliveryContext);
      if (result.status !== "applied") {
        throw unavailable();
      }
      await verifyPair();
      await io.guard();
    },
    async revoke(context, initial, assertCurrent, checkpoint) {
      const io = open(context, initial, assertCurrent);
      let observed = await io.inspect();
      // Recover a lost create response through the retained exact pending digest before deletion.
      const recovered = io.references(observed);
      await io.guard();
      await checkpoint(recovered);
      io.setRecord({ environmentRows: recovered });
      await io.guard();
      for (const row of observed.rows) {
        const owned = io.record.environmentRows.find(
          (reference) => reference.id === row.id && reference.key === row.key,
        );
        if (owned === undefined) {
          throw unavailable();
        }
        await io.guard();
        await io.request(
          `/v9/projects/${encodeURIComponent(io.record.plan.gateway.projectId)}/env/${encodeURIComponent(row.id)}`,
          "DELETE",
          undefined,
          true,
        );
        observed = await io.inspect();
        if (observed.rows.some((item) => item.id === row.id || item.key === row.key)) {
          throw unavailable();
        }
        const rows = io.record.environmentRows.filter((reference) => reference.id !== row.id);
        await checkpoint(rows);
        io.setRecord({ environmentRows: rows });
        await io.guard();
      }
      if (observed.rows.length !== 0) {
        throw unavailable();
      }
      // A lost DELETE response is settled only by current absence, never by deleting another row.
      await checkpoint([]);
      await io.guard();
      // Runtime is already closed by the service. This proves row absence, not removal from an old deployment.
    },
  };
  const safe = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      if (error instanceof HostedOperatorError) {
        throw error;
      }
      throw unavailable();
    }
  };
  return {
    publish: (...args) => safe(() => implementation.publish(...args)),
    revoke: (...args) => safe(() => implementation.revoke(...args)),
  };
};
