import { isDeepStrictEqual } from "node:util";
import {
  canonicalGatewayEnvironmentRowsSchema,
  HostedOperatorError,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan, ManagedOperatorEnvironmentRow } from "./hosted-operator-contract";

/** Only prior verified journal readback can supply approval metadata; provider comments cannot. */
export const describeHostedOperatorSharedGateway = (
  plan: Pick<HostedOperatorPlan, "publicGateway">,
  rows: ManagedOperatorEnvironmentRow[] | undefined,
) => {
  const parsed = canonicalGatewayEnvironmentRowsSchema.safeParse(
    rows?.map((row) => ({ ...row, target: ["preview"], type: "encrypted" })),
  );
  if (!parsed.success) {
    throw new HostedOperatorError("reconciliation_required");
  }
  if (
    parsed.data.length !== 5 ||
    new Set(parsed.data.map((row) => row.id)).size !== 5 ||
    new Set(parsed.data.map((row) => row.key)).size !== 5 ||
    parsed.data.some(
      (row) =>
        row.projectId !== plan.publicGateway?.projectId ||
        row.branch !== plan.publicGateway?.branch ||
        row.comment !== `App Builder protected operator ${row.operationRef}`,
    )
  ) {
    throw new HostedOperatorError("reconciliation_required");
  }
  return parsed.data.toSorted((a, b) => a.key.localeCompare(b.key));
};

/** The source's saved snapshot must still equal the exact approved target snapshot. */
export const assertHostedOperatorSharedGateway = (
  targetPlan: Pick<HostedOperatorPlan, "publicGateway" | "authAdoption">,
  sourcePlan: Pick<HostedOperatorPlan, "publicGateway">,
  rows: ManagedOperatorEnvironmentRow[] | undefined,
) => {
  const observed = describeHostedOperatorSharedGateway(sourcePlan, rows);
  const approved = targetPlan.authAdoption?.gatewayEnvironment?.toSorted((a, b) =>
    a.key.localeCompare(b.key),
  );
  if (
    !isDeepStrictEqual(approved, observed) ||
    observed.some(
      (row) =>
        row.projectId !== targetPlan.publicGateway?.projectId ||
        row.branch !== targetPlan.publicGateway?.branch,
    )
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return observed;
};
