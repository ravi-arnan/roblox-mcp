#!/usr/bin/env node
// Regression coverage for JSON object payloads that map to Roblox value types.
// The converter must honor the destination property type: {X,Y} is Vector2 for
// GuiObject.AnchorPoint, while {X,Y,Z} remains Vector3 for BasePart.Position.

import { McpClient, runTest, assert } from './lib/mcp-client.mjs';
import { setTimeout as delay } from 'node:timers/promises';

function findResult(response, property) {
  return Array.isArray(response.results)
    ? response.results.find((result) => result.property === property)
    : undefined;
}

async function deleteIfPresent(client, instancePath, instanceId) {
  if (!instancePath) return;
  try {
    await client.callTool('delete_object', { instancePath, instance_id: instanceId });
  } catch {
    // Best-effort cleanup; the test verdict should come from the assertion.
  }
}

async function waitForEditInstance(client, instanceId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const connected = await client.callTool('get_connected_instances', {});
      const instances = connected.instances ?? [];
      const edit = instances.find((inst) => inst.role === 'edit' && inst.instanceId === instanceId);
      if (edit) return edit;
      last = connected;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(500);
  }
  throw new Error(`edit instance ${instanceId} did not remain connected. Last: ${JSON.stringify(last)}`);
}

await runTest('property value conversion honors destination property types', async ({ track }) => {
  const client = track(new McpClient('property-value-conversion', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();

  let launchedInstanceId;
  let instanceId = process.env.MCP_INSTANCE_ID;
  if (!instanceId) {
    const launched = await client.callTool('manage_instance', {
      action: 'launch',
      source: 'baseplate',
      wait_for_connection: true,
      timeout_ms: 120000,
    });
    launchedInstanceId = launched.instance_id;
    instanceId = launchedInstanceId;
  }
  assert(typeof instanceId === 'string' && instanceId.length > 0, 'edit instance is available');
  await waitForEditInstance(client, instanceId);

  let screenGuiPath;
  let partPath;

  try {
    const screenGui = await client.callTool('create_object', {
      className: 'ScreenGui',
      parent: 'game.StarterGui',
      name: '__RSMCP_Vector2Conversion',
      instance_id: instanceId,
    });
    assert(screenGui.success === true, 'created Vector2 conversion ScreenGui');
    screenGuiPath = screenGui.instancePath;

    const label = await client.callTool('create_object', {
      className: 'TextLabel',
      parent: screenGui.instancePath,
      name: 'AnchorPointProbe',
      instance_id: instanceId,
    });
    assert(label.success === true, 'created AnchorPoint probe label');

    const anchorSet = await client.callTool('set_properties', {
      instancePath: label.instancePath,
      properties: { AnchorPoint: { X: 0.5, Y: 0.5 } },
      instance_id: instanceId,
    });
    const anchorResult = findResult(anchorSet, 'AnchorPoint');
    assert(anchorSet.summary?.failed === 0 && anchorResult?.success === true,
      'set_properties accepts {X,Y} for Vector2 properties');

    const part = await client.callTool('create_object', {
      className: 'Part',
      parent: 'game.Workspace',
      name: '__RSMCP_Vector3Conversion',
      instance_id: instanceId,
    });
    assert(part.success === true, 'created Vector3 conversion part');
    partPath = part.instancePath;

    const positionSet = await client.callTool('set_properties', {
      instancePath: part.instancePath,
      properties: { Position: { X: 1, Y: 2, Z: 3 } },
      instance_id: instanceId,
    });
    const positionResult = findResult(positionSet, 'Position');
    assert(positionSet.summary?.failed === 0 && positionResult?.success === true,
      'set_properties preserves {X,Y,Z} for Vector3 properties');
  } finally {
    await deleteIfPresent(client, screenGuiPath, instanceId);
    await deleteIfPresent(client, partPath, instanceId);
    if (launchedInstanceId) {
      await client.callTool('manage_instance', {
        action: 'close',
        instance_id: launchedInstanceId,
      }).catch(() => {});
    }
  }
});
