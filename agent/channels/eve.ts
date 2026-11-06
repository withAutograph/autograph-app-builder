import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

import { readHostedForwarderSubject } from "@/lib/eve/hosted-forwarder";
import { createHostedNativeRecoveryBinding } from "@/lib/eve/native-recovery-binding";
import { createLocalNativeRecovery } from "@/lib/eve/local-native-recovery";

const hostedForwarderSubject = readHostedForwarderSubject(process.env);
const localRecovery =
  hostedForwarderSubject === undefined ? createLocalNativeRecovery(process.env) : undefined;

const trustedForwarders: Parameters<typeof eveChannel>[0]["trustedForwarders"] =
  hostedForwarderSubject === undefined
    ? undefined
    : (forwarder) => forwarder.subject === hostedForwarderSubject;
const localTrustedForwarders: Parameters<typeof eveChannel>[0]["trustedForwarders"] =
  localRecovery === undefined
    ? undefined
    : (forwarder, assertion) => localRecovery.trustForwarder(forwarder, assertion);

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
  terminalRecovery:
    hostedForwarderSubject === undefined
      ? localRecovery?.ports
      : createHostedNativeRecoveryBinding(process.env),
  // Hosted MCP forwarding stays pinned to the exact configured workload.
  // Local recovery accepts only the local-dev principal in its private cycle.
  trustedForwarders: trustedForwarders ?? localTrustedForwarders,
});
