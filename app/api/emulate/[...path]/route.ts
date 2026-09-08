import { previewEmulateRoute } from "@/lib/integrations/preview-emulate-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = previewEmulateRoute("GET");
export const POST = previewEmulateRoute("POST");
export const PUT = previewEmulateRoute("PUT");
export const PATCH = previewEmulateRoute("PATCH");
export const DELETE = previewEmulateRoute("DELETE");
