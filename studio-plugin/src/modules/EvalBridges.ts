// Game-VM eval bridges, ported from chrrxs/roblox-mcp-primitives.
//
// Our standard `execute_luau target=server/client-N` runs in the plugin VM
// with a fresh ModuleScript per call. That gives a clean sandbox but means
// `require(SomeModule)` returns a fresh copy, not the one the running game
// scripts hold. So runtime-mutated module state is invisible to probes.
//
// These bridges fix that by living inside the user's game scripts:
//   - Server: a Script in ServerScriptService that creates a BindableFunction
//     (for our server-peer plugin to invoke directly) plus a RemoteFunction
//     (kept for parity with the upstream primitive's client-callable shape).
//   - Client: a LocalScript in StarterPlayer.StarterPlayerScripts that
//     creates a BindableFunction. Plugin invokes it with a fresh ModuleScript
//     payload; require() runs inside the LocalScript VM so it shares the
//     game's require cache.
//
// Lifecycle: TestHandlers.startPlaytest inserts both scripts into the EDIT
// DM right before ExecutePlayModeAsync. ExecutePlayModeAsync clones the
// DataModel into the play DMs, so the scripts come along and run there.
// TestHandlers cleans them up from the edit DM when ExecutePlayModeAsync
// returns (test ended for any reason: stop_playtest, manual close, EndTest).
// Both scripts have Archivable=false so a user save doesn't persist them.

import { ServerScriptService, StarterPlayer } from "@rbxts/services";

const ScriptEditorService = game.GetService("ScriptEditorService");

function getStarterPlayerScripts(): Instance | undefined {
	return StarterPlayer.FindFirstChild("StarterPlayerScripts");
}

const SERVER_SCRIPT_NAME = "__MCP_ServerEvalBridge";
const CLIENT_SCRIPT_NAME = "__MCP_ClientEvalBridge";

// Public so the eval_*_runtime tool wrappers can reference the same names.
export const BRIDGE_NAMES = {
	serverScript: SERVER_SCRIPT_NAME,
	clientScript: CLIENT_SCRIPT_NAME,
	serverRemote: "__MCP_ServerEvalRemote",
	serverLocal: "__MCP_ServerEvalLocal",
	clientLocal: "__MCP_ClientEvalBridge",
} as const;

// Embedded Luau. The double `${...}` references our exported names so a
// rename here propagates to both the script source and the tool wrappers.
const SERVER_BRIDGE_SOURCE = `
-- Auto-installed by @chrrxs/robloxstudio-mcp at start_playtest, removed at
-- stop_playtest. Provides shared-require-cache eval on the server peer for
-- the eval_server_runtime MCP tool.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local RunService = game:GetService("RunService")

if not RunService:IsStudio() then
	return
end

local function evalCode(source)
	if type(source) ~= "string" then
		return false, "source must be a string"
	end
	local fn, compileErr = loadstring(source, "MCPServerEval")
	if not fn then
		local errStr = tostring(compileErr or "loadstring returned nil")
		-- Roblox returns nil from loadstring when LoadStringEnabled=false.
		-- Surface a clear, actionable error.
		if string.find(errStr, "not enabled", 1, true)
			or string.find(errStr, "disabled", 1, true)
			or errStr == "loadstring returned nil"
		then
			return false,
				"ServerScriptService.LoadStringEnabled is false. eval_server_runtime requires it. "
				.. "Enable it in Studio (ServerScriptService > Properties > LoadStringEnabled = true) "
				.. "and restart the playtest."
		end
		return false, errStr
	end
	return pcall(fn)
end

-- Defensive cleanup of stale instances from a prior session.
local prevRf = ReplicatedStorage:FindFirstChild("${BRIDGE_NAMES.serverRemote}")
if prevRf then prevRf:Destroy() end
local prevBf = ServerScriptService:FindFirstChild("${BRIDGE_NAMES.serverLocal}")
if prevBf then prevBf:Destroy() end

local rf = Instance.new("RemoteFunction")
rf.Name = "${BRIDGE_NAMES.serverRemote}"
rf.Archivable = false
rf.Parent = ReplicatedStorage
rf.OnServerInvoke = function(_player, source)
	return evalCode(source)
end

local bf = Instance.new("BindableFunction")
bf.Name = "${BRIDGE_NAMES.serverLocal}"
bf.Archivable = false
bf.Parent = ServerScriptService
bf.OnInvoke = function(source)
	return evalCode(source)
end
`;

const CLIENT_BRIDGE_SOURCE = `
-- Auto-installed by @chrrxs/robloxstudio-mcp at start_playtest, removed at
-- stop_playtest. Provides shared-require-cache eval on the client peer for
-- the eval_client_runtime MCP tool.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

if not RunService:IsStudio() then
	return
end

local prevBf = ReplicatedStorage:FindFirstChild("${BRIDGE_NAMES.clientLocal}")
if prevBf then prevBf:Destroy() end

local bf = Instance.new("BindableFunction")
bf.Name = "${BRIDGE_NAMES.clientLocal}"
bf.Archivable = false
bf.Parent = ReplicatedStorage
bf.OnInvoke = function(payload)
	if typeof(payload) ~= "Instance" or not payload:IsA("ModuleScript") then
		return false, "payload must be a ModuleScript instance"
	end
	return pcall(require, payload)
end
`;

function setSource(scriptInst: Script | LocalScript, source: string): void {
	// ScriptEditorService is the cleaner API and integrates with Studio's
	// edit history; fall back to direct Source mutation (allowed in plugin
	// context with PluginSecurity) if the edit service rejects the call.
	const [seOk] = pcall(() => {
		ScriptEditorService.UpdateSourceAsync(scriptInst, () => source);
	});
	if (!seOk) {
		(scriptInst as unknown as { Source: string }).Source = source;
	}
}

function findBridges(): { server?: Instance; client?: Instance } {
	const sps = getStarterPlayerScripts();
	return {
		server: ServerScriptService.FindFirstChild(SERVER_SCRIPT_NAME),
		client: sps ? sps.FindFirstChild(CLIENT_SCRIPT_NAME) : undefined,
	};
}

export function cleanupBridges(): void {
	const { server, client } = findBridges();
	if (server) {
		pcall(() => server.Destroy());
	}
	if (client) {
		pcall(() => client.Destroy());
	}
}

export function installBridges(): { installed: boolean; error?: string } {
	// Defensive: clear any stale bridges from a prior unclean exit before
	// inserting fresh. The injected script also self-cleans its
	// ReplicatedStorage/ServerScriptService children at startup, but the
	// containing Script/LocalScript objects themselves we must clear here.
	cleanupBridges();

	const [ok, err] = pcall(() => {
		const serverScript = new Instance("Script");
		serverScript.Name = SERVER_SCRIPT_NAME;
		serverScript.Archivable = false;
		setSource(serverScript, SERVER_BRIDGE_SOURCE);
		serverScript.Parent = ServerScriptService;

		const sps = getStarterPlayerScripts();
		if (!sps) {
			error("StarterPlayer.StarterPlayerScripts not found - cannot install client eval bridge");
		}
		const clientScript = new Instance("LocalScript");
		clientScript.Name = CLIENT_SCRIPT_NAME;
		clientScript.Archivable = false;
		setSource(clientScript, CLIENT_BRIDGE_SOURCE);
		clientScript.Parent = sps;
	});

	if (!ok) {
		return { installed: false, error: tostring(err) };
	}
	return { installed: true };
}

// Heuristic check so start_playtest can surface a warning when
// LoadStringEnabled is false (eval_server_runtime won't work in that mode).
// We can't import the runtime LoadStringEnabled value cleanly without
// pulling in the type — read defensively.
export function loadStringEnabled(): boolean {
	const [ok, value] = pcall(
		() => (ServerScriptService as unknown as { LoadStringEnabled: boolean }).LoadStringEnabled,
	);
	return ok && value === true;
}

