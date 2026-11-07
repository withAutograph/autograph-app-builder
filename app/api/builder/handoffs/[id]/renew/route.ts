import { getBuilderHandoffRenewDeploymentHandler } from "@/lib/handoff/deployment";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function renewHandoff(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return await getBuilderHandoffRenewDeploymentHandler(process.env)(request, id);
}

export { renewHandoff as POST };
