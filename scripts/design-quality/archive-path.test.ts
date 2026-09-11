import { expect, it } from "vitest";
import { captureFilename } from "./archive-path";

it("archives desktop variants and retains historical names", () => {
  for (const name of [
    "desktop-0",
    "desktop-wide-0",
    "desktop-window-1",
    "desktop-custom-1280x840-0",
    "mobile-0",
  ])
    expect(captureFilename(name)).toBe(`${name}.png`);
});
it("does not interpret names as paths or HTML", () => {
  for (const name of [
    "../desktop-0",
    "/tmp/desktop-0",
    "x<img>-0",
    "desktop?secret-0",
    "desktop-custom-1280x840px-0",
  ])
    expect(() => captureFilename(name)).toThrow();
});
