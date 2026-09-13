import { describe, expect, it, vi } from "vitest";

import { passkeyUiPlugins } from "./passkey-ui-plugins";

describe("passkey UI plugins", () => {
  it("omits the plugin and all of its UI surfaces when disabled", () => {
    const createPlugin = vi.fn(() => ({
      authButtons: ["Continue with Passkey"],
      id: "passkey",
      securityCards: ["Passkeys"],
    }));

    expect(passkeyUiPlugins(false, createPlugin)).toEqual([]);
    expect(createPlugin).not.toHaveBeenCalled();
  });

  it("restores the passkey auth and settings surfaces when enabled", () => {
    const plugin = {
      authButtons: ["Continue with Passkey"],
      id: "passkey",
      securityCards: ["Passkeys"],
    };

    expect(passkeyUiPlugins(true, () => plugin)).toEqual([plugin]);
  });
});
