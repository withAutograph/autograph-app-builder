import { getBuilderHandoffRenewDeploymentHandler } from "@/lib/handoff/deployment";

const renewHandoff = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return await getBuilderHandoffRenewDeploymentHandler(process.env)(request, id);
};

export { renewHandoff as POST };
