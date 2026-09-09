import { getBuilderHandoffDeploymentHandler } from "@/lib/handoff/deployment";

export const POST = (request: Request) =>
  getBuilderHandoffDeploymentHandler(process.env)(request);
