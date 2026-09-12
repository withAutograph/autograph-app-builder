import { getBuilderHandoffRenewDeploymentHandler } from "@/lib/handoff/deployment";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return getBuilderHandoffRenewDeploymentHandler(process.env)(request, id);
}
