import type { Page } from "playwright";
import { sanitizePreviewEvidence } from "../evals/support/self-reproduction-preview-observation";

export const observePreviewWebSockets = (page: Page) => {
  const events: { event: "created" | "error" | "closed"; url: string }[] = [];
  page.on("websocket", (socket) => {
    const url = sanitizePreviewEvidence(new URL(socket.url()).origin);
    // Playwright reports creation, not successful handshake, and exposes no close code.
    events.push({ event: "created", url });
    socket.on("socketerror", () => events.push({ event: "error", url }));
    socket.on("close", () => events.push({ event: "closed", url }));
  });
  return events;
};
