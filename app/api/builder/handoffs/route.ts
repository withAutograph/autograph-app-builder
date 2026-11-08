import { getBuilderHandoffDeploymentHandler } from "@/lib/handoff/deployment";

// oxlint-disable-next-line sonarjs/function-name -- Next.js discovers this named HTTP method export.
export const POST = (request: Request) => getBuilderHandoffDeploymentHandler(process.env)(request);
