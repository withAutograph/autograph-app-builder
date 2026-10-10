import { createCustodySourceHandler } from "@/lib/provisioning/vercel-token-key-custody-deployment";

export const runtime = "nodejs";
export const POST = createCustodySourceHandler();
