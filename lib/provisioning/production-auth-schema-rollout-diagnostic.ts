import { z } from "zod";
import { operatorPublicResultSchema } from "./hosted-operator-contract";

const diagnosticSchema = z.strictObject({
  event: z.literal("builder.auth_schema_rollout_failure"),
  phase: z.enum([
    "configuration",
    "request_validation",
    "canonical_owner",
    "owner_recheck",
    "owner_reader_configuration",
    "profile_selection",
    "journal_initialize",
    "journal_read",
    "journal_save",
    "journal_cleanup",
    "migration_binding_read",
    "migration_binding_validation",
    "sandbox_oidc",
    "sandbox_create",
    "proposal_worker_verification",
    "proposal_input_write",
    "proposal_execution",
    "proposal_validation",
    "proposal_cleanup",
  ]),
  errorClass: z.enum([
    "operator_error",
    "validation_error",
    "type_error",
    "syntax_error",
    "native_error",
    "unexpected",
  ]),
  operatorCode: operatorPublicResultSchema.shape.code,
  sqlState: z
    .enum([
      "28P01",
      "42501",
      "42P01",
      "42703",
      "23505",
      "40001",
      "40P01",
      "53300",
      "55000",
      "08001",
      "08006",
    ])
    .optional(),
});
type Phase = z.infer<typeof diagnosticSchema>["phase"];

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Exceptions are untrusted; only own data descriptors can contribute allowlisted labels.
const ownData = (error: unknown, name: string): unknown => {
  try {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Never invoke exception getters or coercion.
    if (error === null || typeof error !== "object") {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, name);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- Hostile prototype traps and primitive throws remain unknown until compared to fixed native identities.
const prototypeOf = (value: unknown): unknown => {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- An unreadable untrusted prototype contributes no class evidence.
    return null;
  }
};

/** Server-only closed labels. Never serialize exceptions, messages, identities, inputs or URLs. */
export const reportAuthSchemaRolloutFailure = (
  phase: Phase,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Private exceptions are projected through the closed diagnostic schema.
  error: unknown,
): void => {
  try {
    const name = ownData(error, "name");
    let errorClass: z.infer<typeof diagnosticSchema>["errorClass"] = "unexpected";
    if (name === "HostedOperatorError") {
      errorClass = "operator_error";
    } else if (name === "ZodError") {
      errorClass = "validation_error";
    } else {
      let prototype = prototypeOf(error);
      const knownPrototypes = [
        [TypeError.prototype, "type_error"],
        [SyntaxError.prototype, "syntax_error"],
        [Error.prototype, "native_error"],
      ] as const;
      for (let depth = 0; depth < 3 && prototype !== null; depth += 1) {
        const current = prototype;
        const known = knownPrototypes.find(([candidate]) => candidate === current);
        if (known) {
          const [, classification] = known;
          errorClass = classification;
          break;
        }
        prototype = prototypeOf(prototype);
      }
    }
    const code = ownData(error, "code");
    const operatorCode = operatorPublicResultSchema.shape.code.unwrap().safeParse(code);
    let sqlState = diagnosticSchema.shape.sqlState.unwrap().safeParse(code);
    let cause = ownData(error, "cause");
    for (let depth = 0; depth < 3 && !sqlState.success; depth += 1) {
      sqlState = diagnosticSchema.shape.sqlState.unwrap().safeParse(ownData(cause, "code"));
      cause = ownData(cause, "cause");
    }
    console.warn(
      JSON.stringify(
        diagnosticSchema.parse({
          event: "builder.auth_schema_rollout_failure",
          phase,
          errorClass,
          operatorCode: operatorCode.success ? operatorCode.data : undefined,
          sqlState: sqlState.success ? sqlState.data : undefined,
        }),
      ),
    );
  } catch {
    // Diagnostics cannot replace an actual authorization, command or cleanup failure.
  }
};

export const observeAuthSchemaRolloutPhase = async <T>(
  phase: Phase,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    reportAuthSchemaRolloutFailure(phase, error);
    throw error;
  }
};

export const observeAuthSchemaRolloutPhaseSync = <T>(phase: Phase, run: () => T): T => {
  try {
    return run();
  } catch (error) {
    reportAuthSchemaRolloutFailure(phase, error);
    throw error;
  }
};
