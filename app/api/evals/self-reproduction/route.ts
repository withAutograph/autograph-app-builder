import { createHostedEvalHttpHandler } from "@/lib/evals/hosted-self-reproduction-http";
import { hostedSelfReproductionRuntime } from "@/lib/evals/hosted-self-reproduction-runtime";

export const runtime = "nodejs";
export const POST = createHostedEvalHttpHandler(hostedSelfReproductionRuntime);
