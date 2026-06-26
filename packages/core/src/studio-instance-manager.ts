import { execFileSync, spawn } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

export type StudioLaunchSource = 'baseplate' | 'local_file' | 'published_place' | 'place_revision';

export interface StudioLaunchOptions {
  source: StudioLaunchSource;
  localPlaceFile?: string;
  placeId?: number;
  universeId?: number;
  placeVersion?: number;
}

export interface ManagedStudioInstance {
  source: StudioLaunchSource;
  instanceId?: string;
  nativeProcessId?: number;
  spawnPid?: number;
  exe: string;
  args: string[];
  placeId?: number;
  universeId?: number;
  placeVersion?: number;
  localPlaceFile?: string;
  launchedAt: number;
  closedAt?: number;
}

export interface StudioProcessInfo {
  Id: number;
  Path?: string;
  MainWindowTitle?: string;
}

const BASEPLATE_TEMP_DIR = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
const BASEPLATE_TEMP_NAME = /^Baseplate-\d+-\d+\.rbxl$/;
const BASEPLATE_TEMPLATE_NAME = 'Baseplate.rbxl';

export interface ConnectedStudioInstance {
  instanceId: string;
  role: string;
  placeId: number;
  placeName: string;
  dataModelName: string;
}

function run(command: string, args: string[], options: Record<string, unknown> = {}): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function powershell(script: string): string {
  return run('powershell.exe', ['-NoProfile', '-Command', script], {
    cwd: isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
  });
}

function windowsLocalAppData(): string | undefined {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA;
  if (!isWsl()) return undefined;
  try {
    return run('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], {
      cwd: existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
    });
  } catch {
    return undefined;
  }
}

function toWslPath(windowsPath: string): string {
  if (!isWsl()) return windowsPath;
  return run('wslpath', ['-u', windowsPath]);
}

function toStudioLaunchArg(arg: string): string {
  if (!isWsl() || !path.isAbsolute(arg) || !existsSync(arg)) return arg;
  return run('wslpath', ['-w', arg]);
}

function resolveEntrypointDir(): string | undefined {
  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;
  try {
    return path.dirname(realpathSync(entrypoint));
  } catch {
    return path.dirname(path.resolve(entrypoint));
  }
}

function resolveBaseplateTemplatePath(): string {
  const entrypointDir = resolveEntrypointDir();
  const candidates = [
    ...(entrypointDir ? [
      path.join(entrypointDir, 'assets', BASEPLATE_TEMPLATE_NAME),
      path.join(entrypointDir, '..', 'assets', BASEPLATE_TEMPLATE_NAME),
    ] : []),
    path.join(process.cwd(), 'packages', 'core', 'assets', BASEPLATE_TEMPLATE_NAME),
    path.join(process.cwd(), 'packages', 'robloxstudio-mcp', 'dist', 'assets', BASEPLATE_TEMPLATE_NAME),
    path.join(process.cwd(), 'assets', BASEPLATE_TEMPLATE_NAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Baseplate template not found. Expected ${BASEPLATE_TEMPLATE_NAME} in one of: ${candidates.join(', ')}`);
}

function createBaseplatePlaceFile(): string {
  mkdirSync(BASEPLATE_TEMP_DIR, { recursive: true });
  const file = path.join(BASEPLATE_TEMP_DIR, `Baseplate-${process.pid}-${Date.now()}.rbxl`);
  copyFileSync(resolveBaseplateTemplatePath(), file);
  return file;
}

function isGeneratedBaseplatePlaceFile(file: string): boolean {
  const resolvedFile = path.resolve(file);
  return path.dirname(resolvedFile) === path.resolve(BASEPLATE_TEMP_DIR) &&
    BASEPLATE_TEMP_NAME.test(path.basename(resolvedFile));
}

export function cleanupManagedBaseplateFiles(record: Pick<ManagedStudioInstance, 'source' | 'localPlaceFile'>): void {
  if (record.source !== 'baseplate' || !record.localPlaceFile) return;
  if (!isGeneratedBaseplatePlaceFile(record.localPlaceFile)) return;

  rmSync(record.localPlaceFile, { force: true });
  rmSync(`${record.localPlaceFile}.lock`, { force: true });
}

function prepareStudioLaunchOptions(options: StudioLaunchOptions): StudioLaunchOptions {
  if (options.source !== 'baseplate' || options.localPlaceFile) return options;
  return {
    ...options,
    localPlaceFile: createBaseplatePlaceFile(),
  };
}

export function resolveStudioExe(): string {
  if (process.env.ROBLOX_STUDIO_EXE) return process.env.ROBLOX_STUDIO_EXE;

  if (process.platform === 'darwin') {
    return '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio';
  }

  if (process.platform !== 'win32' && !isWsl()) {
    throw new Error('Roblox Studio executable auto-discovery is only supported on Windows, WSL, and macOS. Set ROBLOX_STUDIO_EXE.');
  }

  const localAppData = windowsLocalAppData();
  const root = localAppData
    ? path.join(toWslPath(localAppData), 'Roblox', 'Versions')
    : path.join(os.homedir(), 'AppData', 'Local', 'Roblox', 'Versions');

  if (!existsSync(root)) {
    throw new Error(`Roblox Studio Versions folder not found: ${root}. Set ROBLOX_STUDIO_EXE.`);
  }

  const candidates = readdirSync(root)
    .filter((name) => name.startsWith('version-'))
    .map((name) => path.join(root, name, 'RobloxStudioBeta.exe'))
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`RobloxStudioBeta.exe not found under ${root}. Set ROBLOX_STUDIO_EXE.`);
  }

  return candidates[0];
}

export function listStudioProcesses(): StudioProcessInfo[] {
  if (process.platform === 'darwin') {
    let out = '';
    try {
      out = run('pgrep', ['-fl', 'RobloxStudio']);
    } catch {
      return [];
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pid, ...rest] = line.trim().split(/\s+/);
        return { Id: Number(pid), Path: rest.join(' '), MainWindowTitle: '' };
      })
      .filter((proc) => Number.isFinite(proc.Id));
  }

  if (process.platform !== 'win32' && !isWsl()) return [];

  let out = '';
  try {
    out = powershell(
      'Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | ' +
      'Select-Object Id,Path,MainWindowTitle | ConvertTo-Json -Compress',
    );
  } catch {
    return [];
  }
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function buildStudioLaunchArgs(options: StudioLaunchOptions): string[] {
  switch (options.source) {
    case 'baseplate':
      return ['--task', 'EditFile', '--localPlaceFile', options.localPlaceFile ?? createBaseplatePlaceFile()];
    case 'local_file':
      if (!options.localPlaceFile) throw new Error('local_place_file is required when source="local_file".');
      return ['--task', 'EditFile', '--localPlaceFile', options.localPlaceFile];
    case 'published_place':
      if (!options.placeId) throw new Error('place_id is required when source="published_place".');
      if (!options.universeId) throw new Error('universe_id is required when source="published_place".');
      return ['--task', 'EditPlace', '--placeId', String(options.placeId), '--universeId', String(options.universeId)];
    case 'place_revision':
      if (!options.placeId) throw new Error('place_id is required when source="place_revision".');
      if (!options.universeId) throw new Error('universe_id is required when source="place_revision".');
      if (!options.placeVersion) throw new Error('place_version is required when launching source="place_revision".');
      return [
        '--task', 'EditPlaceRevision',
        '--placeId', String(options.placeId),
        '--universeId', String(options.universeId),
        '--placeVersion', String(options.placeVersion),
      ];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StudioInstanceManager {
  private managedByInstanceId = new Map<string, ManagedStudioInstance>();
  private pending = new Set<ManagedStudioInstance>();

  list(): ManagedStudioInstance[] {
    return [...this.managedByInstanceId.values(), ...this.pending]
      .filter((instance, index, all) => all.indexOf(instance) === index);
  }

  get(instanceId: string): ManagedStudioInstance | undefined {
    return this.managedByInstanceId.get(instanceId);
  }

  attachInstanceId(record: ManagedStudioInstance, instanceId: string) {
    record.instanceId = instanceId;
    this.pending.delete(record);
    this.managedByInstanceId.set(instanceId, record);
  }

  async launch(options: StudioLaunchOptions): Promise<ManagedStudioInstance> {
    const preparedOptions = prepareStudioLaunchOptions(options);
    const before = new Set(listStudioProcesses().map((proc) => proc.Id));
    const exe = resolveStudioExe();
    const args = buildStudioLaunchArgs(preparedOptions).map(toStudioLaunchArg);
    const proc = spawn(exe, args, {
      cwd: isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();

    const record: ManagedStudioInstance = {
      source: options.source,
      spawnPid: proc.pid,
      exe,
      args,
      placeId: preparedOptions.placeId,
      universeId: preparedOptions.universeId,
      placeVersion: preparedOptions.placeVersion,
      localPlaceFile: preparedOptions.localPlaceFile,
      launchedAt: Date.now(),
    };
    this.pending.add(record);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && record.nativeProcessId === undefined) {
      const created = listStudioProcesses().find((candidate) => !before.has(candidate.Id));
      if (created) {
        record.nativeProcessId = created.Id;
        break;
      }
      await delay(250);
    }

    if (record.nativeProcessId === undefined && process.platform !== 'win32' && !isWsl()) {
      record.nativeProcessId = proc.pid;
    }

    return record;
  }

  close(record: ManagedStudioInstance) {
    const processId = record.nativeProcessId ?? record.spawnPid;
    if (!processId) {
      throw new Error(`Cannot close ${record.instanceId ?? 'Studio launch'} because its process id was not detected.`);
    }

    if (process.platform === 'win32' || isWsl()) {
      powershell(`Stop-Process -Id ${Math.trunc(processId)} -Force -ErrorAction Stop`);
    } else {
      try {
        process.kill(processId, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }

    record.closedAt = Date.now();
    if (record.instanceId) this.managedByInstanceId.delete(record.instanceId);
    this.pending.delete(record);
    cleanupManagedBaseplateFiles(record);
  }

  closeConnectedInstance(instance: ConnectedStudioInstance) {
    const process = this.findProcessForConnectedInstance(instance);
    if (!process) {
      throw new Error(`Could not find a Studio process for connected instance "${instance.instanceId}".`);
    }
    this.closeProcess(process.Id);
  }

  private closeProcess(processId: number) {
    if (process.platform === 'win32' || isWsl()) {
      powershell(`Stop-Process -Id ${Math.trunc(processId)} -Force -ErrorAction Stop`);
    } else {
      try {
        process.kill(processId, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }

  private findProcessForConnectedInstance(instance: ConnectedStudioInstance): StudioProcessInfo | undefined {
    const processes = listStudioProcesses();
    if (processes.length === 0) return undefined;
    if (processes.length === 1) return processes[0];

    const names = [instance.dataModelName, instance.placeName]
      .map((name) => name.trim())
      .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index);

    const candidates = processes.filter((proc) => {
      const title = (proc.MainWindowTitle ?? '').trim();
      if (!title) return false;
      return names.some((name) =>
        title === `${name} - Roblox Studio` ||
        title.startsWith(`${name} - `) ||
        title.startsWith(`${name} (`),
      );
    });

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new Error(`Multiple Studio processes matched connected instance "${instance.instanceId}".`);
    }
    return undefined;
  }
}
