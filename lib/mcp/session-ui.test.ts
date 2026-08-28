import { describe, expect, it } from "vitest";

import codexManifest from "../../.codex-plugin/plugin.json";
import packageManifest from "../../package.json";
import portableManifest from "../../plugin.json";
import {
  APP_VERSION,
  MCP_APP_RESOURCE_MIME_TYPE,
  sessionUiHtml,
} from "./session-ui";

describe("Autograph App Builder MCP App progress UI", () => {
  it("uses the MCP Apps resource profile and protocol handshake", () => {
    expect(MCP_APP_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(sessionUiHtml).toContain('method:"ui/initialize"');
    expect(sessionUiHtml).toContain('"ui/notifications/tool-result"');
    expect(sessionUiHtml).toContain('"ui/notifications/initialized"');
  });

  it("keeps the package, portable, Codex, and runtime versions aligned", () => {
    expect(APP_VERSION).toBe(packageManifest.version);
    expect(portableManifest.version).toBe(packageManifest.version);
    expect(codexManifest.version).toBe(packageManifest.version);
    expect(sessionUiHtml).toContain(`version:"${packageManifest.version}"`);
  });

  it("keeps a stable viewport and respects reduced motion", () => {
    expect(sessionUiHtml).toContain("height:312px");
    expect(sessionUiHtml).toContain("overflow:hidden");
    expect(sessionUiHtml).toContain("prefers-reduced-motion:reduce");
  });

  it("uses product language while retaining private handshake identifiers", () => {
    expect(sessionUiHtml).toContain("<title>Autograph App Builder</title>");
    expect(sessionUiHtml).toContain(
      'aria-label="Autograph App Builder progress"',
    );
    expect(sessionUiHtml).toContain("Connecting to Autograph App Builder");
    expect(sessionUiHtml).toContain('id="subtitle">App build');
    expect(sessionUiHtml).toContain("Build updates will appear here");
    expect(sessionUiHtml).toContain(
      'label.textContent="Autograph App Builder"',
    );
    expect(sessionUiHtml).toContain(
      "Autograph App Builder is waiting for your response",
    );
    expect(sessionUiHtml).toContain("Autograph App Builder is working");
    expect(sessionUiHtml).toContain("App build finished");
    expect(sessionUiHtml).toContain("App build failed");
    expect(sessionUiHtml).toContain("App build cancelled");
    expect(sessionUiHtml).not.toContain("App build stopped");
    expect(sessionUiHtml).toContain('id:"eve-session-init"');
    expect(sessionUiHtml).not.toContain("Eve session");
    expect(sessionUiHtml).not.toContain("Connecting to Eve");
  });

  it("renders untrusted event content as text and removes the placeholder", () => {
    expect(sessionUiHtml).toContain("document.createTextNode(body)");
    expect(sessionUiHtml).not.toContain("innerHTML");
    expect(sessionUiHtml).not.toContain("Complete the production bridge");
  });
});
