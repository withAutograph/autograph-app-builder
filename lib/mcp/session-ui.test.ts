import { describe, expect, it } from "vitest";

import codexManifest from "../../.codex-plugin/plugin.json";
import packageManifest from "../../package.json";
import portableManifest from "../../plugin.json";
import {
  APP_VERSION,
  MCP_APP_RESOURCE_MIME_TYPE,
  sessionUiHtml,
} from "./session-ui";

describe("Autograph App Builder contextual MCP App", () => {
  it("uses the MCP Apps resource profile and protocol handshake", () => {
    expect(MCP_APP_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(sessionUiHtml).toContain("ui/initialize");
    expect(sessionUiHtml).toContain("ui/notifications/tool-result");
    expect(sessionUiHtml).toContain("ui/notifications/initialized");
  });

  it("keeps the package, portable, Codex, and runtime versions aligned", () => {
    expect(APP_VERSION).toBe(packageManifest.version);
    expect(portableManifest.version).toBe(packageManifest.version);
    expect(codexManifest.version).toBe(packageManifest.version);
    expect(sessionUiHtml).toContain(packageManifest.version);
  });

  it("uses responsive sizing and respects reduced motion", () => {
    expect(sessionUiHtml).toContain("min-height:100%");
    expect(sessionUiHtml).toContain("overflow:hidden");
    expect(sessionUiHtml).toContain("prefers-reduced-motion:reduce");
  });

  it("uses focused product language without an event log", () => {
    expect(sessionUiHtml).toContain("<title>Autograph App Builder</title>");
    expect(sessionUiHtml).toContain("Complete the requested details");
    expect(sessionUiHtml).toContain("Loading requested controls");
    expect(sessionUiHtml).toContain("Answer in chat to continue");
    expect(sessionUiHtml).not.toContain("Build updates will appear here");
    expect(sessionUiHtml).not.toContain(" events");
    expect(sessionUiHtml).not.toContain("Eve session");
  });

  it("supports interactive submission and authorization", () => {
    expect(sessionUiHtml).toContain("autograph_respond");
    expect(sessionUiHtml).toContain("autograph_get");
    expect(sessionUiHtml).toContain("ui/open-link");
    expect(sessionUiHtml).toContain("Check access");
    expect(sessionUiHtml).toContain("addEventListener(`focus`");
    expect(sessionUiHtml).toContain("addEventListener(`visibilitychange`");
    expect(sessionUiHtml).toContain("Update GitHub access");
  });

  it("never embeds generated app previews", () => {
    expect(sessionUiHtml).not.toContain("<iframe");
    expect(sessionUiHtml).not.toContain("srcdoc");
    expect(sessionUiHtml).not.toContain("result.prototype");
    expect(sessionUiHtml).not.toContain("Interactive app prototype");
  });
});
