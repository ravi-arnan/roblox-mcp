import { HttpService, ServerStorage } from "@rbxts/services";

const SETTING_KEY_PREFIX = "MCP_SERVER_URL_";

let pluginRef: Plugin | undefined;

function init(p: Plugin): void {
	pluginRef = p;
}

function addUnique(values: string[], value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}

function computeInstanceIds(): string[] {
	const ids: string[] = [];
	if (game.PlaceId !== 0) {
		addUnique(ids, `place:${tostring(game.PlaceId)}`);
	}
	const existing = ServerStorage.GetAttribute("__MCPPlaceId");
	if (typeIs(existing, "string") && existing !== "") {
		addUnique(ids, `anon:${existing as string}`);
	} else if (game.PlaceId === 0) {
		const fresh = HttpService.GenerateGUID(false);
		pcall(() => ServerStorage.SetAttribute("__MCPPlaceId", fresh));
		addUnique(ids, `anon:${fresh}`);
	}
	return ids;
}

function settingKey(instanceId: string): string {
	return SETTING_KEY_PREFIX + instanceId;
}

function rememberServerUrl(serverUrl: string): void {
	if (!pluginRef || serverUrl === "") return;
	for (const instanceId of computeInstanceIds()) {
		const key = settingKey(instanceId);
		pcall(() => pluginRef!.SetSetting(key, serverUrl));
	}
}

function readServerUrl(): string | undefined {
	if (!pluginRef) return undefined;
	for (const instanceId of computeInstanceIds()) {
		const key = settingKey(instanceId);
		const [ok, value] = pcall(() => pluginRef!.GetSetting(key));
		if (ok && typeIs(value, "string") && value !== "") {
			return value as string;
		}
	}
	return undefined;
}

export = {
	init,
	rememberServerUrl,
	readServerUrl,
};
