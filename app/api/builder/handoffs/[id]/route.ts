import { getBuilderHandoffStatusDeploymentHandler } from "@/lib/handoff/deployment";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function getHandoffStatus(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return await getBuilderHandoffStatusDeploymentHandler(process.env)(request, id);
}

export { getHandoffStatus as GET };
