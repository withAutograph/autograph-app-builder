/* oxlint-disable eslint/no-bitwise, eslint/curly, sonarjs/expression-complexity -- Explicit owner and local-principal comparisons form the local authority boundary. */
import { authorizeRepeatablePrivateApplyCalls } from "./native-recovery-repeatable-apply";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { eveChannel } from "eve/channels/eve";
import { MessageResponse, isCurrentTurnBoundaryEvent } from "eve/client";
import type { Client, ClientSession, MessageStreamEvent, InputResponse } from "eve/client";
import { z } from "zod";
import type { LocalSessionClient } from "./service";
import { readLocalEveCycleBinding } from "./local-cycle-binding";
import {
  nativeRecoveryBindingSchema,
  nativeRecoveryDescriptorSchema,
  assertNativeRecoveryReceipt,
} from "./native-recovery-contract";
import { deriveInstalledEveStatus } from "./public-events";

type Ports = NonNullable<Parameters<typeof eveChannel>[0]["terminalRecovery"]>;
const localPrincipal = {
  attributes: {},
  authenticator: "local-dev",
  principalId: "local-dev",
  principalType: "local-dev",
} as const;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new Error("The original local terminal recovery is unavailable.");
const reservationSchema = z.strictObject({
  kind: z.literal("local-native-recovery-v1"),
  descriptor: nativeRecoveryDescriptorSchema,
});
const cancellationSchema = z.strictObject({
  kind: z.literal("local-native-recovery-cancel-v1"),
  publicId: z.string().min(1),
});

export const localRecoveryResponseSchema = z.object({
  sessionId: z.string().min(1),
  recoveryBinding: nativeRecoveryBindingSchema,
});
export const localRecoveredControlReceiptSchema = z.object({
  sessionId: z.string().min(1),
  deliveryId: z.string().min(1).optional(),
});
interface LocalRecoveredControlBody {
  message?: string;
  turnPolicy?: "queue";
  inputResponses?: readonly InputResponse[];
}
type LocalRecoveredControl = (
  logicalSessionId: string,
  body: LocalRecoveredControlBody,
) => Promise<z.infer<typeof localRecoveredControlReceiptSchema>>;
type LocalRecoveryResponse = z.infer<typeof localRecoveryResponseSchema>;
interface LocalRecoveryRequest {
  operationId: string;
  recovery: z.infer<typeof nativeRecoveryDescriptorSchema>;
  forwardedPrincipal: { current: typeof localPrincipal };
  recoveryPhase?: "activate";
}

/** Local filesystem authority, deliberately independent of hosted principals and journals. */
export const createLocalNativeRecovery = (environment: Record<string, string | undefined>) => {
  const cycle = environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE;
  if (
    environment.APP_BUILDER_EXECUTION_MODE !== "development" ||
    environment.APP_BUILDER_EXECUTION_BUNDLE !== "local-development" ||
    environment.APP_BUILDER_LOCAL_ADAPTER !== "1" ||
    environment.EVE_HOSTED_ADAPTER !== "0" ||
    cycle === undefined
  )
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Disabled local mode has no recovery adapter.
    return undefined;
  const directory = path.join(path.dirname(cycle), "local-native-recovery");
  const owned = (file: string, isDirectory: boolean) => {
    const info = lstatSync(file);
    if (
      realpathSync(file) !== file ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      (isDirectory ? !info.isDirectory() : !info.isFile())
    )
      throw unavailable();
  };
  const assertLocal = () => {
    readLocalEveCycleBinding(cycle);
    owned(path.dirname(cycle), true);
  };
  const filename = (source: string, kind: "reservation" | "receipt") =>
    path.join(directory, `${hash(source)}.${kind}.json`);
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Private JSON I/O; each caller immediately parses the reservation or receipt schema.
  const read = (file: string): unknown => {
    assertLocal();
    try {
      owned(directory, true);
      owned(file, false);
      return JSON.parse(
        readFileSync(file, { encoding: "utf-8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const writeOnce = async (
    file: string,
    value:
      | z.infer<typeof reservationSchema>
      | z.infer<typeof nativeRecoveryBindingSchema>
      | z.infer<typeof cancellationSchema>,
  ) => {
    assertLocal();
    await mkdir(directory, { mode: 0o700, recursive: true });
    owned(directory, true);
    const temporary = `${file}.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
      try {
        await link(temporary, file);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      if (JSON.stringify(read(file)) !== JSON.stringify(value)) throw unavailable();
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const cancellationRevision = (publicId: string) => {
    assertLocal();
    const prefix = `${hash(publicId)}.cancel.`;
    let files: string[];
    try {
      owned(directory, true);
      files = readdirSync(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return 0;
      }
      throw error;
    }
    const markers = files.filter((file) => file.startsWith(prefix));
    for (const marker of markers) {
      if (cancellationSchema.parse(read(path.join(directory, marker))).publicId !== publicId) {
        throw unavailable();
      }
    }
    return markers.length;
  };
  const lineage = (publicId: string) => {
    const owners = [publicId];
    const seen = new Set(owners);
    while (true) {
      const current = owners.at(-1);
      if (current === undefined) {
        throw unavailable();
      }
      const value = read(filename(current, "receipt"));
      if (value === undefined) return owners;
      const receipt = nativeRecoveryBindingSchema.parse(value);
      if (
        receipt.sourcePublicSessionId !== publicId ||
        receipt.logicalSessionId !== publicId ||
        receipt.originalAuthoritySessionId !== publicId ||
        receipt.sourceOwnerRunId !== owners.at(-1) ||
        seen.has(receipt.ownerRunId)
      )
        throw unavailable();
      seen.add(receipt.ownerRunId);
      owners.push(receipt.ownerRunId);
    }
  };
  const authorize: Ports["authorize"] = ({ auth, descriptor }) => {
    assertLocal();
    if (
      auth.authenticator !== "local-dev" ||
      auth.principalType !== "local-dev" ||
      auth.principalId !== "local-dev" ||
      auth.attributes["eve:forwarded-by"] !== "local-dev"
    )
      throw unavailable();
    const saved = reservationSchema.parse(
      read(filename(descriptor.sourceOwnerRunId, "reservation")),
    );
    if (
      descriptor.parentCancellationRevision !==
      cancellationRevision(descriptor.sourcePublicSessionId)
    ) {
      throw unavailable();
    }
    if (
      JSON.stringify(saved.descriptor) !==
      JSON.stringify(nativeRecoveryDescriptorSchema.parse(descriptor))
    )
      throw unavailable();
    const owners = lineage(descriptor.sourcePublicSessionId);
    if (
      owners.at(-1) !== descriptor.sourceOwnerRunId &&
      owners.at(-2) !== descriptor.sourceOwnerRunId
    )
      throw unavailable();
    return Promise.resolve();
  };
  const ports: Ports = {
    authorize,
    async authorizeRepeatableRecoveryCalls(input) {
      await authorize(input);
      if (
        input.binding.ownerRunId !== input.descriptor.sourceOwnerRunId ||
        input.binding.logicalSessionId !== input.descriptor.logicalSessionId
      ) {
        return [];
      }
      // Only the current exact private build scope is repeatable. Outward
      // effects and arbitrary missing tool results retain strict reconciliation.
      return authorizeRepeatablePrivateApplyCalls(input);
    },
    async readReceipt(input) {
      await authorize(input);
      const receipt = read(filename(input.descriptor.sourceOwnerRunId, "receipt"));
      return receipt === undefined ? undefined : nativeRecoveryBindingSchema.parse(receipt);
    },
    async commitReceipt(input) {
      await authorize(input);
      assertNativeRecoveryReceipt(input.descriptor, input.recoveryBinding);
      await writeOnce(
        filename(input.descriptor.sourceOwnerRunId, "receipt"),
        nativeRecoveryBindingSchema.parse(input.recoveryBinding),
      );
      return input.recoveryBinding;
    },
    async authorizeActivation(input) {
      await authorize(input);
      const receipt = nativeRecoveryBindingSchema.parse(
        read(filename(input.descriptor.sourceOwnerRunId, "receipt")),
      );
      assertNativeRecoveryReceipt(input.descriptor, receipt);
    },
  };
  return {
    ports,
    trustForwarder(
      forwarder: Parameters<Ports["authorize"]>[0]["auth"],
      assertion: { principal?: { current: Parameters<Ports["authorize"]>[0]["auth"] } },
    ) {
      assertLocal();
      const current = assertion.principal?.current;
      return (
        forwarder.authenticator === "local-dev" &&
        forwarder.principalId === "local-dev" &&
        current?.authenticator === "local-dev" &&
        current.principalId === "local-dev" &&
        current.principalType === "local-dev"
      );
    },
    lineage,
    async cancel(publicId: string) {
      await writeOnce(path.join(directory, `${hash(publicId)}.cancel.${randomUUID()}.json`), {
        kind: "local-native-recovery-cancel-v1",
        publicId,
      });
    },
    async recover(
      client: LocalSessionClient,
      publicId: string,
      clientRequestId: string,
      post: (body: LocalRecoveryRequest) => Promise<LocalRecoveryResponse>,
    ) {
      const owners = lineage(publicId);
      const epoch = cancellationRevision(publicId);
      const source = owners.at(-1);
      if (source === undefined) {
        throw unavailable();
      }
      const snapshot = await client.sessions.attach(source).snapshot();
      const previousOwner = owners.at(-2);
      if (
        previousOwner !== undefined &&
        snapshot.events.length > 0 &&
        deriveInstalledEveStatus(snapshot.events) !== "failed"
      ) {
        // Existing stream events prove this physical owner already activated.
        // Reading an active/waiting owner needs no recovery activation effect.
        return;
      }
      if (
        previousOwner !== undefined &&
        snapshot.session.sessionId === source &&
        deriveInstalledEveStatus(snapshot.events) !== "failed"
      ) {
        // A prepared owner may have committed before the caller lost its reply.
        // Activate only that immutable receipt; never allocate another executor.
        const receipt = nativeRecoveryBindingSchema.parse(read(filename(previousOwner, "receipt")));
        const descriptor = nativeRecoveryDescriptorSchema.parse(receipt);
        const activated = localRecoveryResponseSchema.parse(
          await post({
            operationId: descriptor.operationId,
            recovery: descriptor,
            recoveryPhase: "activate",
            forwardedPrincipal: { current: localPrincipal },
          }),
        );
        if (
          JSON.stringify(activated.recoveryBinding) !== JSON.stringify(receipt) ||
          activated.sessionId !== source
        ) {
          throw unavailable();
        }
        return;
      }
      if (
        snapshot.session.sessionId !== source ||
        snapshot.events.length === 0 ||
        deriveInstalledEveStatus(snapshot.events) !== "failed"
      )
        throw unavailable();
      const previous = read(filename(source, "reservation"));
      const descriptor =
        previous === undefined
          ? nativeRecoveryDescriptorSchema.parse({
              version: 1,
              operationId: `local-recovery:${hash(JSON.stringify([publicId, source, clientRequestId]))}`,
              sourcePublicSessionId: publicId,
              sourceOwnerRunId: source,
              sourceAdapterGeneration: owners.length,
              logicalSessionId: publicId,
              originalAuthoritySessionId: publicId,
              parentCancellationRevision: epoch,
            })
          : reservationSchema.parse(previous).descriptor;
      await writeOnce(
        filename(source, "reservation"),
        reservationSchema.parse({ kind: "local-native-recovery-v1", descriptor }),
      );
      const body = {
        operationId: descriptor.operationId,
        recovery: descriptor,
        forwardedPrincipal: { current: localPrincipal },
      };
      const acceptedSchema = localRecoveryResponseSchema;
      const accepted = acceptedSchema.parse(await post(body));
      assertNativeRecoveryReceipt(descriptor, accepted.recoveryBinding);
      if (accepted.sessionId !== accepted.recoveryBinding.ownerRunId) throw unavailable();
      const canonical = nativeRecoveryBindingSchema.parse(read(filename(source, "receipt")));
      if (JSON.stringify(canonical) !== JSON.stringify(accepted.recoveryBinding))
        throw unavailable();
      const activated = acceptedSchema.parse(await post({ ...body, recoveryPhase: "activate" }));
      if (
        JSON.stringify(activated.recoveryBinding) !== JSON.stringify(canonical) ||
        activated.sessionId !== canonical.ownerRunId
      )
        throw unavailable();
    },
  };
};

const matchesLocalDelivery = (
  event: MessageStreamEvent,
  deliveryId: string | undefined,
  previouslyMatched: boolean,
): boolean => {
  if (deliveryId === undefined) {
    return true;
  }
  const matches = event.meta.deliveryIds?.includes(deliveryId) === true;
  const terminal = event.type === "session.failed" || event.type === "session.completed";
  if (!matches && terminal && (!previouslyMatched || event.type === "session.completed")) {
    throw unavailable();
  }
  return !(
    (!previouslyMatched && !matches) ||
    (!terminal && event.meta.deliveryIds !== undefined && !matches)
  );
};

/** Keep the public ID/cursor append-only while replacing only the failed physical executor. */
export const withLocalRecoveredSessions = (
  client: Pick<Client, "sessions">,
  recovery: NonNullable<ReturnType<typeof createLocalNativeRecovery>>,
  postControl?: LocalRecoveredControl,
): LocalSessionClient => ({
  sessions: {
    create: client.sessions.create.bind(client.sessions),
    attach: (publicId, options) => {
      const resolve = async () => {
        const owners = recovery.lineage(publicId);
        const prefix: MessageStreamEvent[] = [];
        const ancestors = await Promise.all(
          owners.slice(0, -1).map(async (owner) => await client.sessions.attach(owner).snapshot()),
        );
        for (const ancestor of ancestors) {
          prefix.push(...ancestor.events);
        }
        const owner = owners.at(-1);
        if (owner === undefined) {
          throw unavailable();
        }
        return {
          prefix,
          actual: client.sessions.attach(owner, {
            streamIndex: Math.max(0, (options?.streamIndex ?? 0) - prefix.length),
          }),
        };
      };
      const control = async (actual: ClientSession, body: LocalRecoveredControlBody) => {
        if (postControl === undefined) {
          throw unavailable();
        }
        const accepted = await postControl(publicId, body);
        if (
          accepted.sessionId !== publicId ||
          (body.message !== undefined && accepted.deliveryId === undefined)
        ) {
          throw unavailable();
        }
        return new MessageResponse({
          sessionId: publicId,
          deliveryId: accepted.deliveryId,
          cancelTurn: async (turnId) => await client.sessions.attach(publicId).cancel({ turnId }),
          async *createStream() {
            let matchingTurn = accepted.deliveryId === undefined;
            const authorizations = new Set<string>();
            for await (const event of actual.stream()) {
              if (!matchesLocalDelivery(event, accepted.deliveryId, matchingTurn)) {
                continue;
              }
              matchingTurn = true;
              if (event.type === "authorization.required" && event.data.webhookUrl !== undefined) {
                authorizations.add(event.data.name);
              }
              if (event.type === "authorization.completed") {
                authorizations.delete(event.data.name);
              }
              yield event;
              if (
                isCurrentTurnBoundaryEvent(event) &&
                (event.type !== "session.waiting" || authorizations.size === 0)
              ) {
                return;
              }
            }
            if (accepted.deliveryId !== undefined) {
              throw unavailable();
            }
          },
        });
      };
      return {
        state: { sessionId: publicId, streamIndex: options?.streamIndex ?? 0 },
        async snapshot(snapshotOptions) {
          const owners = recovery.lineage(publicId);
          const snapshots = await Promise.all(
            owners.map(async (owner) => {
              const snapshot = await client.sessions.attach(owner).snapshot(snapshotOptions);
              if (
                snapshot.session.sessionId !== owner ||
                snapshot.session.streamIndex !== snapshot.events.length
              ) {
                throw unavailable();
              }
              return snapshot;
            }),
          );
          const events = snapshots.flatMap((snapshot) => snapshot.events);
          return {
            events,
            session: { sessionId: publicId, streamIndex: events.length },
          };
        },
        async send(message, sendOptions) {
          const { actual } = await resolve();
          return actual.state.sessionId === publicId
            ? await actual.send(message, sendOptions)
            : await control(actual, { message, ...sendOptions });
        },
        async respond(input) {
          const { actual } = await resolve();
          return actual.state.sessionId === publicId
            ? await actual.respond(input)
            : await control(actual, { inputResponses: input });
        },
        async cancel(cancelOptions) {
          return await client.sessions.attach(publicId).cancel(cancelOptions);
        },
        async *stream(streamOptions) {
          const { actual } = await resolve();
          yield* actual.stream(streamOptions);
        },
      };
    },
  },
});
