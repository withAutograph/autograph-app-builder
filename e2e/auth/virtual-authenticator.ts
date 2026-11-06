import type { BrowserContext, CDPSession, Page } from "playwright/test";

interface Credential {
  credentialId: string;
  rpId: string;
  userHandle?: string;
}

const parseCredential = (value: unknown): Credential | undefined => {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const credential = value as Record<string, unknown>;
  const { credentialId, rpId, userHandle } = credential;
  if (
    typeof credentialId !== "string" ||
    typeof rpId !== "string" ||
    (userHandle !== undefined && typeof userHandle !== "string")
  ) {
    return undefined;
  }

  const parsed: Credential = { credentialId, rpId };
  if (userHandle !== undefined) {
    parsed.userHandle = userHandle;
  }
  return parsed;
};

export class VirtualAuthenticator {
  private readonly session: CDPSession;
  readonly id: string;

  private constructor(session: CDPSession, id: string) {
    this.session = session;
    this.id = id;
  }

  static async create(context: BrowserContext, page: Page) {
    const session = await context.newCDPSession(page);
    await session.send("WebAuthn.enable");
    const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        automaticPresenceSimulation: true,
        ctap2Version: "ctap2_1",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        protocol: "ctap2",
        transport: "internal",
      },
    });
    return new VirtualAuthenticator(session, authenticatorId);
  }

  async credentials(): Promise<Credential[]> {
    const result = await this.session.send("WebAuthn.getCredentials", {
      authenticatorId: this.id,
    });
    return result.credentials.flatMap((credential) => {
      const parsed = parseCredential(credential);
      return parsed === undefined ? [] : [parsed];
    });
  }

  async removeCredential(credentialId: string) {
    await this.session.send("WebAuthn.removeCredential", {
      authenticatorId: this.id,
      credentialId,
    });
  }

  async setUserVerified(value: boolean) {
    await this.session.send("WebAuthn.setUserVerified", {
      authenticatorId: this.id,
      isUserVerified: value,
    });
  }

  async setPresence(value: boolean) {
    await this.session.send("WebAuthn.setAutomaticPresenceSimulation", {
      authenticatorId: this.id,
      enabled: value,
    });
  }

  async dispose() {
    await this.session.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: this.id,
    });
    await this.session.detach();
  }
}
