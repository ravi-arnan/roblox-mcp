import { HttpService, ServerStorage } from "@rbxts/services";

const SETTING_KEY_PREFIX = "MCP_SERVER_URL_";

let pluginRef: Plugin | undefined;

function init(p: Plugin): void {
	pluginRef = p;
}

function computeInstanceId(): string {
	if (game.PlaceId !== 0) {
		return `place:${tostring(game.PlaceId)}`;
	}
	const existing = ServerStorage.GetAttribute("__MCPPlaceId");
	if (typeIs(existing, "string") && existing !== "") {
		return `anon:${existing as string}`;
	}
	const fresh = HttpService.GenerateGUID(false);
	pcall(() => ServerStorage.SetAttribute("__MCPPlaceId", fresh));
	return `anon:${fresh}`;
}

function settingKey(instanceId: string): string {
	return SETTING_KEY_PREFIX + instanceId;
}

function rememberServerUrl(serverUrl: string): void {
	if (!pluginRef || serverUrl === "") return;
	const key = settingKey(computeInstanceId());
	pcall(() => pluginRef!.SetSetting(key, serverUrl));
}

function readServerUrl(): string | undefined {
	if (!pluginRef) return undefined;
	const key = settingKey(computeInstanceId());
	const [ok, value] = pcall(() => pluginRef!.GetSetting(key));
	if (ok && typeIs(value, "string") && value !== "") {
		return value as string;
	}
	return undefined;
}

export = {
	init,
	rememberServerUrl,
	readServerUrl,
};
