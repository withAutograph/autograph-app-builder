import { getBuilderHandoffDeploymentHandler } from "@/lib/handoff/deployment";

export const POST = async (request: Request) =>
  getBuilderHandoffDeploymentHandler(process.env)(request);
