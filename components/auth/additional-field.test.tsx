// @vitest-environment jsdom
import { AuthProvider } from "@better-auth-ui/react";
import { QueryClient } from "@tanstack/react-query";
import { createAuthClient } from "better-auth/react";
import { act, createContext, useContext } from "react";
import type { PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AdditionalField } from "./additional-field";
import type { AdditionalFieldProps } from "./additional-field";

// oxlint-disable-next-line anti-slop/no-module-mocking -- The real popover stalls calendar interactions in jsdom.
vi.mock("@/components/ui/popover", () => {
  const context = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  const popoverContent = ({ children }: PropsWithChildren) =>
    useContext(context).open ? <div>{children}</div> : null;
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>) => (
      <context.Provider value={{ open, onOpenChange }}>{children}</context.Provider>
    ),
    PopoverTrigger: ({
      children,
      id,
      disabled,
    }: PropsWithChildren<{ id: string; disabled?: boolean }>) => {
      const { open, onOpenChange } = useContext(context);
      return (
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-expanded={open}
          onClick={() => {
            onOpenChange(!open);
          }}
        >
          {children}
        </button>
      );
    },
    PopoverContent: popoverContent,
  };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const setup = function setup(field: AdditionalFieldProps["field"]) {
  const view = document.createElement("div");
  document.body.append(view);
  container = view;
  root = createRoot(view);
  const authClient = createAuthClient({ baseURL: "http://localhost:3000/api/auth" });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(
      <AuthProvider
        authClient={authClient}
        queryClient={queryClient}
        navigate={() => {}}
        Link={({ href, children }) => <a href={href}>{children}</a>}
      >
        <form>
          <AdditionalField name={field.name} field={field} />
        </form>
      </AuthProvider>,
    );
  });
  const form = view.querySelector("form");
  if (!form) {
    throw new Error("Expected form");
  }
  return { view, form };
};

const click = function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected clickable element");
  }
  act(() => {
    element.click();
  });
};

const setValue = function setValue(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

it("validates, selects, and clears a required date in the submitted form", () => {
  const { view, form } = setup({
    name: "birthday",
    type: "date",
    label: "Birthday",
    required: true,
  });
  const input = form.querySelector<HTMLInputElement>('input[name="birthday"]');
  if (!input) {
    throw new Error("Expected date input");
  }
  expect(new FormData(form).get("birthday")).toBe("");
  act(() => {
    input.dispatchEvent(new Event("invalid", { cancelable: true }));
  });
  expect(view.querySelector('[role="alert"]')?.textContent).toBe(input.validationMessage);
  click(view.querySelector("#birthday-date"));
  const day = document.querySelector<HTMLButtonElement>("button[data-day]");
  if (day?.dataset.day === undefined || day.dataset.day === "") {
    throw new Error("Expected calendar day");
  }
  const selected = new Date(day.dataset.day);
  selected.setHours(0, 0, 0, 0);
  const dayLabel = day.dataset.day;
  click(day);
  expect(new FormData(form).get("birthday")).toBe(selected.toISOString());
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(view.querySelector("#birthday-date")?.getAttribute("aria-expanded")).toBe("false");
  click(view.querySelector("#birthday-date"));
  click(document.querySelector(`button[data-day="${dayLabel}"]`));
  expect(new FormData(form).get("birthday")).toBe("");
});

it("combines a selected date with the edited time and clears the datetime", () => {
  const { view, form } = setup({
    name: "appointment",
    type: "date",
    inputType: "datetime",
    label: "Appointment",
    defaultValue: new Date(2024, 5, 10, 14, 23, 45),
  });
  const time = view.querySelector<HTMLInputElement>('input[type="time"]');
  if (!time) {
    throw new Error("Expected time input");
  }
  expect(time.value).toBe("14:23:45");
  click(view.querySelector("#appointment-date"));
  const day = document.querySelector<HTMLButtonElement>("button[data-day]");
  if (day?.dataset.day === undefined || day.dataset.day === "") {
    throw new Error("Expected calendar day");
  }
  const selected = new Date(day.dataset.day);
  const dayLabel = day.dataset.day;
  click(day);
  expect(view.querySelector("#appointment-date")?.getAttribute("aria-expanded")).toBe("true");
  selected.setHours(14, 23, 45, 0);
  expect(new FormData(form).get("appointment")).toBe(selected.toISOString());
  setValue(time, "09:12:30");
  selected.setHours(9, 12, 30, 0);
  expect(new FormData(form).get("appointment")).toBe(selected.toISOString());
  click(document.querySelector(`button[data-day="${dayLabel}"]`));
  expect(new FormData(form).get("appointment")).toBe("");
  expect(time.value).toBe("09:12:30");
});

it("submits edits to a decorated text field", () => {
  const { view, form } = setup({
    name: "handle",
    type: "string",
    label: "Handle",
    prefix: "@",
    defaultValue: "original",
  });
  const input = view.querySelector<HTMLInputElement>("#handle");
  if (!input) {
    throw new Error("Expected text input");
  }
  expect(new FormData(form).get("handle")).toBe("original");
  setValue(input, "updated");
  expect(new FormData(form).get("handle")).toBe("updated");
  expect(view.textContent).toContain("@");
});
