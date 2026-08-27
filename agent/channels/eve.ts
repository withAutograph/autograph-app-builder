import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

import { readHostedForwarderSubject } from "@/lib/eve/hosted-forwarder";

const hostedForwarderSubject = readHostedForwarderSubject(process.env);

export default eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // This placeholder will not allow browser requests in production.
    // Replace it with your app's auth provider, like Auth.js or Clerk,
    // or use none() for a public demo.
    placeholderAuth(),
  ],
  // Only this exact Vercel project/environment may project a verified MCP
  // principal into the canonical Eve session routes.
  trustedForwarders:
    hostedForwarderSubject === undefined
      ? undefined
      : (forwarder) => forwarder.subject === hostedForwarderSubject,
});
