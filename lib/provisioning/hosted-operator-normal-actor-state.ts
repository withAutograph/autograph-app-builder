import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { BuilderProvisionAuthority } from "./journal";
import {
  decryptVersionedVercelToken,
  encryptVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import {
  assertNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import type { NormalActorProgram, NormalActorState } from "./hosted-operator-normal-actor-program";

/** Separate from resource credentials; append this envelope to the existing protected owner journal. */
export const sealedNormalActorStateSchema = z.strictObject({
  encryptedToken: z.string().min(1),
  keyVersion: z.string().min(1),
  tokenIv: z.string().min(1),
  tokenTag: z.string().min(1),
});
export type SealedNormalActorState = z.infer<typeof sealedNormalActorStateSchema>;
export interface NormalActorStateScope {
  authority: BuilderProvisionAuthority;
  ownerSessionId: string;
  operationRef: string;
  program: NormalActorProgram;
}
const aad = (scope: NormalActorStateScope): string => {
  const authority = hostedTenantAuthoritySchema.parse(scope.authority);
  const program = normalActorProgramSchema.parse(scope.program);
  return JSON.stringify({
    ...authority,
    appId: program.appId,
    origin: program.origin,
    ownerSessionId: z.string().min(1).parse(scope.ownerSessionId),
    operationRef: z.uuid().parse(scope.operationRef),
    programDigest: normalActorProgramDigest(program),
    purpose: "normal-auth-actor-state-v1",
  });
};
export const encryptNormalActorState = (input: NormalActorStateScope & {
  config: VercelTokenKeyringConfig;
  state: NormalActorState;
}): SealedNormalActorState => {
  const state = assertNormalActorState(input.program, input.state, input.operationRef);
  return {
    ...encryptVercelToken({ associatedData: aad(input), key: input.config.tokenKey, token: JSON.stringify(state) }),
    keyVersion: input.config.tokenKeyVersion,
  };
};
export const decryptNormalActorState = (input: NormalActorStateScope & {
  config: VercelTokenKeyringConfig;
  sealed: SealedNormalActorState;
}): NormalActorState => {
  try {
    const sealed = sealedNormalActorStateSchema.parse(input.sealed);
    const state = JSON.parse(decryptVersionedVercelToken({ ...sealed, associatedData: aad(input), config: input.config }));
    return assertNormalActorState(input.program, state, input.operationRef);
  } catch {
    // Ciphertext/parser diagnostics can contain normal session credentials.
    throw new Error("normal_actor_state_unavailable");
  }
};
