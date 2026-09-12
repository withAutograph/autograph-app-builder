import packageManifest from "../../package.json";

export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
export const APP_VERSION = packageManifest.version;
export { generatedSessionUiHtml as sessionUiHtml } from "./session-ui.generated";
