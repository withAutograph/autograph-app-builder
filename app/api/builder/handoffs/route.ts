import { getBuilderHandoffDeploymentHandler } from "@/lib/handoff/deployment";

export const runtime = "nodejs";

export const POST = (request: Request) =>
  getBuilderHandoffDeploymentHandler(process.env)(request);
