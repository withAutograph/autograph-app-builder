// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { Passkey } from "./passkey";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply the authentication context used by this isolated hydration test.
vi.mock("@better-auth-ui/react", () => ({
  useAuth: () => ({ localization: { settings: { delete: "Delete" } } }),
  useAuthPlugin: () => ({
    localization: { passkey: "Passkey", renamePasskey: "Rename", deletePasskey: "Delete {{name}}" },
  }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking, sonarjs/function-name -- The closed dialog is outside the timestamp hydration test.
vi.mock("./delete-passkey-dialog", () => ({ DeletePasskeyDialog: () => null }));
// oxlint-disable-next-line anti-slop/no-module-mocking, sonarjs/function-name -- The closed dialog is outside the timestamp hydration test.
vi.mock("./rename-passkey-dialog", () => ({ RenamePasskeyDialog: () => null }));

it("hydrates the passkey timestamp in the browser locale without losing the passkey", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const format = vi.spyOn(Date.prototype, "toLocaleString");
  format.mockImplementation(function serverFormat(this: Date, _locale, options) {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(this);
  });
  const date = new Date("2026-05-13T14:00:00.000Z");
  const view = <Passkey passkey={{ id: "key-1", name: "Laptop", createdAt: date }} />;
  const container = document.createElement("div");
  const serverMarkup = new DOMParser().parseFromString(renderToString(view), "text/html");
  container.replaceChildren(...serverMarkup.body.childNodes);
  document.body.append(container);
  expect(container.textContent).toContain("Laptop");
  expect(container.textContent).toContain("—");
  format.mockImplementation(function browserFormat(this: Date, _locale, options) {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "America/Los_Angeles" }).format(
      this,
    );
  });
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    act(() => {
      root = hydrateRoot(container, view, {
        onRecoverableError: (error) => {
          errors.push(error);
        },
      });
    });
    expect(errors).toEqual([]);
    expect(container.textContent).toContain(
      new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "America/Los_Angeles",
      }).format(date),
    );
    expect(container.textContent).toContain("Laptop");
  } finally {
    act(() => {
      root?.unmount();
    });
    container.remove();
    format.mockRestore();
    vi.unstubAllGlobals();
  }
});
