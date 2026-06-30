import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Compatibility shim for MCP clients that still probe optional resource
 * endpoints before considering tool-only servers usable. The Roblox Studio
 * integration is tool-driven, so the resource surface is intentionally empty.
 *
 * Upstream context:
 * - https://github.com/openai/codex/issues/14242
 * - https://github.com/openai/codex/issues/14454
 */
export function registerEmptyResourceShim(server: Server): void {
  server.registerCapabilities({ resources: {} });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    throw new McpError(ErrorCode.InvalidParams, `Resource ${request.params.uri} not found`);
  });
}
