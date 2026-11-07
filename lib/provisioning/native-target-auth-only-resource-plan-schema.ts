import { z } from "zod";
import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
import { authResourceBootstrapPlanSchema } from "./hosted-operator-sandbox-launcher";
import { configurationSchema } from "./hosted-operator-native-preview-neon";
import { nativeTargetAuthOnlyPlanSchema } from "./native-target-auth-only-plan-schema";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Bind the resource effect to retained app source, the registered Preview and private provider custody. */
export const nativeTargetAuthOnlyResourceApprovalPlanSchema =
  authResourceBootstrapPlanSchema.extend({
    authOnlyPlanDigest: digestSchema,
    authSchema: nativeTargetAuthOnlyPlanSchema.shape.authSchema.optional(),
    nativeNeonConfiguration: configurationSchema.omit({ connectorInstallationId: true }),
    target: hostedRuntimeTargetSchema,
  });
