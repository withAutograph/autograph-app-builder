import { describe, expect, it } from "vitest";

import { MCP_APP_RESOURCE_MIME_TYPE, sessionUiHtml } from "./session-ui";

describe("Eve MCP App session UI", () => {
  it("uses the MCP Apps resource profile and protocol handshake", () => {
    expect(MCP_APP_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(sessionUiHtml).toContain('method:"ui/initialize"');
    expect(sessionUiHtml).toContain('"ui/notifications/tool-result"');
    expect(sessionUiHtml).toContain('"ui/notifications/initialized"');
  });

  it("keeps a stable viewport and respects reduced motion", () => {
    expect(sessionUiHtml).toContain("height:312px");
    expect(sessionUiHtml).toContain("overflow:hidden");
    expect(sessionUiHtml).toContain("prefers-reduced-motion:reduce");
  });

  it("renders untrusted event content as text and removes the placeholder", () => {
    expect(sessionUiHtml).toContain("document.createTextNode(body)");
    expect(sessionUiHtml).not.toContain("innerHTML");
    expect(sessionUiHtml).not.toContain("Complete the production bridge");
  });
});
