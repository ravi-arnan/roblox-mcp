#!/usr/bin/env node
// Regression coverage for canonical DataModel paths. The plugin should emit
// bracket-quoted paths for unsafe names, accept those paths everywhere, and
// still accept legacy paths such as "..dir" for names that begin with a dot.

import { McpClient, runTest, assert, assertContains, waitForEditPeer } from './lib/mcp-client.mjs';

const LUAU_KEYWORDS = new Set([
  'and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'export',
  'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or',
  'repeat', 'return', 'then', 'true', 'type', 'until', 'while',
]);

function quoteSegment(segment) {
  return `"${segment
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')}"`;
}

function canonicalSegment(segment) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) && !LUAU_KEYWORDS.has(segment)
    ? `.${segment}`
    : `[${quoteSegment(segment)}]`;
}

function childPath(parentPath, childName) {
  return `${parentPath}${canonicalSegment(childName)}`;
}

function assertNoError(value, label) {
  assert(!value?.error, `${label}${value?.error ? ` (${value.error})` : ''}`);
}

function containsPath(value, targetPath) {
  if (value === targetPath) return true;
  if (Array.isArray(value)) return value.some((item) => containsPath(item, targetPath));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsPath(item, targetPath));
  }
  return false;
}

await runTest('canonical instance paths resolve across tools', async ({ track }) => {
  const client = track(new McpClient('path-resolution'));
  await client.start();
  await client.initialize();
  await waitForEditPeer(client);

  const instances = await client.callTool('get_connected_instances', {});
  const edit = instances.instances?.find((i) => i.role === 'edit');
  const instanceId = edit?.instanceId;
  assert(typeof instanceId === 'string' && instanceId.length > 0, 'edit instance is connected');

  let originalServerScriptServiceName;
  const renameService = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: 'local svc = game:GetService("ServerScriptService")\nlocal old = svc.Name\nsvc.Name = "__RSMCP_RenamedServerScriptService"\nreturn old',
  });
  if (renameService.success === true && typeof renameService.returnValue === 'string') {
    originalServerScriptServiceName = renameService.returnValue;
    assert(originalServerScriptServiceName !== '__RSMCP_RenamedServerScriptService',
      'renamed ServerScriptService to exercise GetService root resolution');
  } else {
    console.log('  SKIP service rename assertion: ServerScriptService.Name was not writable');
  }

  const rootName = `__RSMCP_PathResolution_${Date.now()}`;
  const rootPath = childPath('game.ServerScriptService', rootName);
  let root;
  let breakpointWasSet = false;

  try {
    root = await client.callTool('create_object', {
      className: 'Folder',
      parent: 'game.ServerScriptService',
      name: rootName,
      instance_id: instanceId,
    });
    assert(root.success === true, 'created path-resolution root folder');
    assert(root.instancePath === rootPath, 'root folder path is canonical even when service is renamed');

    const segments = [
      '.dot',
      'Name With Spaces',
      'A.B.C',
      'quote"child',
      '[bracket]',
      'slash\\child',
      'tab\tchild',
      'line\nchild',
      'end',
    ];

    let currentPath = root.instancePath;
    for (const segment of segments) {
      const expectedPath = childPath(currentPath, segment);
      const created = await client.callTool('create_object', {
        className: 'Folder',
        parent: currentPath,
        name: segment,
        instance_id: instanceId,
      });
      assert(created.success === true, `created folder segment ${JSON.stringify(segment)}`);
      assert(created.instancePath === expectedPath, `emitted canonical path for ${JSON.stringify(segment)}`);

      const props = await client.callTool('get_instance_properties', {
        instancePath: expectedPath,
        excludeSource: true,
        instance_id: instanceId,
      });
      assertNoError(props, `resolved canonical path for ${JSON.stringify(segment)}`);
      assert(props.properties?.Name === segment, `resolved instance name for ${JSON.stringify(segment)}`);
      currentPath = expectedPath;
    }

    const scriptName = 'Script.With Spaces';
    const scriptPath = childPath(currentPath, scriptName);
    const script = await client.callTool('create_object', {
      className: 'Script',
      parent: currentPath,
      name: scriptName,
      properties: { Enabled: false },
      instance_id: instanceId,
    });
    assert(script.success === true, 'created script under canonical weird-name hierarchy');
    assert(script.instancePath === scriptPath, 'script path is canonical');

    const sourceText = 'local value = 41\nreturn value + 1\n';
    const setSource = await client.callTool('set_script_source', {
      instancePath: scriptPath,
      source: sourceText,
      instance_id: instanceId,
    });
    assert(setSource.success === true, 'set_script_source accepts canonical path');

    const source = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      startLine: 1,
      endLine: 2,
      instance_id: instanceId,
    });
    assertContains(source, 'return value + 1', 'get_script_source accepts canonical path');

    const children = await client.callTool('get_instance_children', {
      instancePath: currentPath,
      instance_id: instanceId,
    });
    assertNoError(children, 'get_instance_children accepts canonical path');
    assert(children.children?.some((child) => child.path === scriptPath), 'get_instance_children emits reusable canonical child path');

    const project = await client.callTool('get_project_structure', {
      path: root.instancePath,
      maxDepth: 20,
      scriptsOnly: false,
      instance_id: instanceId,
    });
    assertNoError(project, 'get_project_structure accepts canonical path');
    assert(containsPath(project, scriptPath), 'get_project_structure emits canonical descendant path');

    const tree = await client.callTool('get_file_tree', {
      path: root.instancePath,
      instance_id: instanceId,
    });
    assertNoError(tree, 'get_file_tree accepts canonical path');
    assert(containsPath(tree, scriptPath), 'get_file_tree emits canonical descendant path');

    const literalBracket = await client.callTool('create_object', {
      className: 'Folder',
      parent: root.instancePath,
      name: '[bracket]',
      instance_id: instanceId,
    });
    assert(literalBracket.success === true, 'created literal bracket legacy folder');
    const literalBracketLegacy = await client.callTool('get_instance_properties', {
      instancePath: `${root.instancePath}.[bracket]`,
      excludeSource: true,
      instance_id: instanceId,
    });
    assertNoError(literalBracketLegacy, 'legacy literal bracket path resolves');
    assert(literalBracketLegacy.properties?.Name === '[bracket]', 'legacy literal bracket path targets literal bracket name');

    const danger = await client.callTool('create_object', {
      className: 'Folder',
      parent: root.instancePath,
      name: 'Danger',
      instance_id: instanceId,
    });
    assert(danger.success === true, 'created control sibling for quoted legacy bracket path');
    const quotedLiteral = await client.callTool('create_object', {
      className: 'Folder',
      parent: root.instancePath,
      name: '["Danger"]',
      instance_id: instanceId,
    });
    assert(quotedLiteral.success === true, 'created quoted literal legacy bracket folder');
    const quotedLiteralLegacy = await client.callTool('get_instance_properties', {
      instancePath: `${root.instancePath}.["Danger"]`,
      excludeSource: true,
      instance_id: instanceId,
    });
    assertNoError(quotedLiteralLegacy, 'legacy quoted literal bracket path resolves');
    assert(quotedLiteralLegacy.properties?.Name === '["Danger"]', 'legacy quoted literal bracket path does not retarget sibling Danger');

    const dotFolder = await client.callTool('create_object', {
      className: 'Folder',
      parent: root.instancePath,
      name: '.dir',
      instance_id: instanceId,
    });
    assert(dotFolder.success === true, 'created dot-prefixed compatibility folder');
    assert(dotFolder.instancePath === childPath(root.instancePath, '.dir'), 'dot-prefixed folder path is canonical bracket path');

    const legacyScript = await client.callTool('create_object', {
      className: 'Script',
      parent: dotFolder.instancePath,
      name: 'ReproScript',
      properties: { Enabled: false },
      instance_id: instanceId,
    });
    assert(legacyScript.success === true, 'created legacy-path script');

    const legacyPath = `${root.instancePath}..dir.ReproScript`;
    const legacySourceSet = await client.callTool('set_script_source', {
      instancePath: legacyPath,
      source: '-- line one\nprint("legacy path works")\n',
      instance_id: instanceId,
    });
    assert(legacySourceSet.success === true, 'set_script_source accepts legacy ..dir path');

    const legacySource = await client.callTool('get_script_source', {
      instancePath: legacyScript.instancePath,
      startLine: 1,
      endLine: 2,
      instance_id: instanceId,
    });
    assertContains(legacySource, 'legacy path works', 'canonical path reads source written through legacy path');

    const breakpoint = await client.callTool('breakpoints', {
      action: 'set',
      target: 'edit',
      script_path: legacyScript.instancePath,
      line: 2,
      enabled: true,
      continue_execution: true,
      log_message: '"path resolution"',
      instance_id: instanceId,
    });
    if (breakpoint.error === 'script_debugger_unavailable') {
      console.log('  SKIP breakpoint assertion: ScriptDebuggerService beta unavailable');
    } else {
      assert(breakpoint.ok === true, `breakpoints accepts canonical bracket path (${JSON.stringify(breakpoint)})`);
      breakpointWasSet = true;
    }
  } finally {
    if (breakpointWasSet) {
      await client.callTool('breakpoints', {
        action: 'remove',
        target: 'edit',
        script_path: root?.instancePath ? childPath(childPath(root.instancePath, '.dir'), 'ReproScript') : '',
        line: 2,
        instance_id: instanceId,
      }).catch(() => {});
    }
    if (root?.instancePath) {
      const deleted = await client.callTool('delete_object', {
        instancePath: root.instancePath,
        instance_id: instanceId,
      });
      assert(deleted.success === true || deleted.error?.includes('not found'), 'cleaned up path-resolution root folder');
    }
    if (originalServerScriptServiceName !== undefined) {
      await client.callTool('execute_luau', {
        target: 'edit',
        instance_id: instanceId,
        code: `game:GetService("ServerScriptService").Name = ${JSON.stringify(originalServerScriptServiceName)}`,
      }).catch(() => {});
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));
