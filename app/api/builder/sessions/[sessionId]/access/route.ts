import { handleBuilderAppAccess } from "@/lib/app-access/deployment";

const handle = async (request: Request, context: { params: Promise<{ sessionId: string }> }) => {
  const { sessionId } = await context.params;
  return await handleBuilderAppAccess(request, sessionId);
};

export const GET = handle;
export const POST = handle;
