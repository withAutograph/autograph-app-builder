import { getBuilderHandoffStatusDeploymentHandler } from "@/lib/handoff/deployment";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return getBuilderHandoffStatusDeploymentHandler(process.env)(request, id);
}
