import { getBuilderHandoffStatusDeploymentHandler } from "@/lib/handoff/deployment";

async function get(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return await getBuilderHandoffStatusDeploymentHandler(process.env)(request, id);
}

export const GET = get;
