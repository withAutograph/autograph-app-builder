import type { BrowserContext, CDPSession, Page } from "playwright/test";

type Credential = {
  credentialId: string;
  rpId: string;
  userHandle?: string;
};

export class VirtualAuthenticator {
  private constructor(
    private readonly session: CDPSession,
    readonly id: string,
  ) {}

  static async create(context: BrowserContext, page: Page) {
    const session = await context.newCDPSession(page);
    await session.send("WebAuthn.enable");
    const { authenticatorId } = await session.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          ctap2Version: "ctap2_1",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    );
    return new VirtualAuthenticator(session, authenticatorId);
  }

  async credentials(): Promise<Credential[]> {
    const result = await this.session.send("WebAuthn.getCredentials", {
      authenticatorId: this.id,
    });
    return result.credentials as Credential[];
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
