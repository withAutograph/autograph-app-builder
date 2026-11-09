// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { Calendar } from "./calendar";

it("hydrates localized day attributes and month labels without a mismatch", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const dateFormat = vi.spyOn(Date.prototype, "toLocaleDateString");
  const monthFormat = vi.spyOn(Date.prototype, "toLocaleString");
  dateFormat.mockImplementation(function serverDate(this: Date) {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(this);
  });
  monthFormat.mockImplementation(function serverMonth(this: Date, _locale, options) {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(this);
  });
  const onSelect = vi.fn<(date: Date | undefined) => void>();
  const view = (
    <Calendar
      month={new Date(2026, 4, 1)}
      captionLayout="dropdown"
      mode="single"
      selected={new Date(2026, 4, 5)}
      onSelect={onSelect}
    />
  );
  const container = document.createElement("div");
  const serverMarkup = new DOMParser().parseFromString(renderToString(view), "text/html");
  container.replaceChildren(...serverMarkup.body.childNodes);
  document.body.append(container);
  expect(container.querySelector("button[data-day]")).toBeNull();
  dateFormat.mockImplementation(function browserDate(this: Date) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles" }).format(this);
  });
  monthFormat.mockImplementation(function browserMonth(this: Date, _locale, options) {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "America/Los_Angeles" }).format(
      this,
    );
  });
  const errors: unknown[] = [];
  const consoleErrors = vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(consoleErrors).not.toHaveBeenCalled();
    const button = container.querySelector<HTMLButtonElement>("button[data-day]");
    const isoDay = button?.closest("td")?.dataset.day;
    expect(isoDay).toBeTruthy();
    const parts = (isoDay ?? "").split("-");
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    expect(button?.dataset.day).toBe(
      new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles" }).format(
        new Date(year, month - 1, day),
      ),
    );
    act(() => {
      button?.click();
    });
    expect(onSelect).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "America/Los_Angeles" }).format(
        new Date(2026, 4, 1),
      ),
    );
  } finally {
    act(() => {
      root?.unmount();
    });
    container.remove();
    consoleErrors.mockRestore();
    dateFormat.mockRestore();
    monthFormat.mockRestore();
    vi.unstubAllGlobals();
  }
});
