import packageManifest from "../../package.json";
import { generatedSessionUiHtml } from "./session-ui.generated";

export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
export const APP_VERSION = packageManifest.version;
export const sessionUiHtml = generatedSessionUiHtml;
