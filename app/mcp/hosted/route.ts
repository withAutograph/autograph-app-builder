import { createHostedSessionRelay } from "@/lib/development/hosted-session-relay";

/** Public OAuth remains hosted; this route never grants local worker authority. */
const requestHandler = async (request: Request): Promise<Response> => {
  const resourceUrl = process.env.APP_BUILDER_DEVELOPMENT_HOSTED_RESOURCE;
  if (
    process.env.APP_BUILDER_LOCAL_ADAPTER !== "1" ||
    process.env.EVE_HOSTED_ADAPTER !== "0" ||
    resourceUrl === undefined ||
    resourceUrl === ""
  ) {
    return new Response(null, { status: 404 });
  }
  return await createHostedSessionRelay({ resourceUrl })(request);
};

export { requestHandler as POST };
