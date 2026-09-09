import { getBuilderHandoffStatusDeploymentHandler } from "@/lib/handoff/deployment";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return getBuilderHandoffStatusDeploymentHandler(process.env)(request, id);
}
