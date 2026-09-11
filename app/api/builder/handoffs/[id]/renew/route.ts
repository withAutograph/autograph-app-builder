import { getBuilderHandoffRenewDeploymentHandler } from "@/lib/handoff/deployment";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return getBuilderHandoffRenewDeploymentHandler(process.env)(request, id);
}
