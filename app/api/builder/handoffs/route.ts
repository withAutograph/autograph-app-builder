import { getBuilderHandoffDeploymentHandler } from "@/lib/handoff/deployment";

// oxlint-disable-next-line typescript/promise-function-async, sonarjs/function-name -- Preserve the handler's promise and synchronous exception behavior. Next.js discovers this named HTTP method export.
export const POST = (request: Request) => getBuilderHandoffDeploymentHandler(process.env)(request);
