import { getBuilderHandoffStatusDeploymentHandler } from "@/lib/handoff/deployment";

// oxlint-disable-next-line sonarjs/function-name, eslint/func-style -- Next.js discovers this named HTTP method export. Preserve function declaration hoisting and initialization timing.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return await getBuilderHandoffStatusDeploymentHandler(process.env)(request, id);
}
