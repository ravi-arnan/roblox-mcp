import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { registerEmptyResourceShim } from '../mcp-compat.js';

describe('MCP compatibility shims', () => {
  test('empty resource shim handles resource probes without hiding tools capability', async () => {
    const server = new Server(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    registerEmptyResourceShim(server);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getServerCapabilities()).toEqual({
        resources: {},
        tools: {},
      });
      await expect(client.listResources()).resolves.toEqual({ resources: [] });
      await expect(client.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
      await expect(client.readResource({ uri: 'robloxstudio://missing' }))
        .rejects.toThrow('Resource robloxstudio://missing not found');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
