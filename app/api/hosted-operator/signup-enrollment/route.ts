import { openHostedOperatorCompositionResources } from "@/lib/provisioning/hosted-operator-source-configuration";
import { createProtectedSignupEnrollmentRequestHandler } from "@/lib/provisioning/protected-signup-enrollment-request";

export const maxDuration = 120;

export const POST = createProtectedSignupEnrollmentRequestHandler(async (request, input) => {
  const { controlPlane } = await openHostedOperatorCompositionResources();
  try {
    return await controlPlane.continueProtectedSignup(request, input);
  } finally {
    await controlPlane.close();
  }
});
