// Copied only into the disposable production-navigation snapshot, never app/.
import { revalidateTag } from "next/cache";

import { loadNextGatewayModels } from "@/lib/integrations/ai-gateway-models.next";
import { readProductionNavigationRuntimeConfig } from "@/lib/testing/production-navigation";

const catalogUrl = "https://ai-gateway.vercel.sh/v1/models";
let installed = false;
let upstreamCalls = 0;
let revision = 1;
let unavailable = false;

function installCatalogFixture() {
  if (!readProductionNavigationRuntimeConfig(process.env)) {
    throw new Error("The cache probe requires a guarded production-navigation artifact.");
  }
  if (installed) return;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== catalogUrl) return realFetch(input, init);
    upstreamCalls += 1;
    if (unavailable) return new Response(null, { status: 503 });
    return Response.json({
      data: [
        {
          id: "openai/gpt-5.6-terra",
          name: `Navigation catalog ${revision}`,
          owned_by: "openai",
          type: "language",
          zdr: "all",
          tags: ["tool-use"],
        },
      ],
    });
  };
  installed = true;
}

export async function GET() {
  installCatalogFixture();
  const models = await loadNextGatewayModels();
  return Response.json({ models, upstreamCalls }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  installCatalogFixture();
  const text = await request.text();
  if (text.length > 32) return new Response(null, { status: 400 });
  switch (text) {
    case "reset": {
      upstreamCalls = 0;
      revision = 1;
      unavailable = false;
      break;
    }
    case "advance": {
      revision = 2;
      unavailable = false;
      break;
    }
    case "fail": {
      unavailable = true;
      break;
    }
    case "recover": {
      revision = 3;
      unavailable = false;
      break;
    }
    default: {
      return new Response(null, { status: 400 });
    }
  }
  // Route handlers cannot use updateTag. Immediate expiration makes the next
  // read a deterministic blocking refresh rather than background SWR.
  revalidateTag("public-ai-gateway-models", { expire: 0 });
  return new Response(null, { status: 204 });
}
