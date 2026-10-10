import { createCustodyOwnerInvocationHandler } from "@/lib/provisioning/vercel-token-key-custody-owner-invocation";

const handler = createCustodyOwnerInvocationHandler();
export const GET = handler;
export const POST = handler;
