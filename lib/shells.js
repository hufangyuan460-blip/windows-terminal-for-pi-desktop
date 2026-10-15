'use strict';

/**
 * shells.js — Windows shell discovery and launch planning.
 *
 * The plugin process starts with a deliberately minimal environment
 * (PI-Desktop keeps PATH, SystemRoot, TEMP, USERPROFILE and little else), so
 * discovery cannot lean on `ComSpec`, `ProgramFiles` or the user's own PATH
 * additions being present. This module rebuilds the picture from the two
 * environment hives plus the process environment, then resolves each supported
 * shell to a real executable path.
 *
 * Everything here is pure with respect to the machine state it reads, so the
 * parsing and path rules are unit-testable.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MACHINE_ENV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_ENV_KEY = 'HKCU\\Environment';
const CODEPAGE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage';

/** Code pages that Node's ICU can decode by name. */
const CODEPAGE_ENCODINGS = {
  437: 'ibm437',
  850: 'ibm850',
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1200: 'utf-16le',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  65001: 'utf-8',
};

let cachedCodePages = null;
let cachedRegistryEnv = null;

function decodeBytes(buffer, codePage) {
  const encoding = CODEPAGE_ENCODINGS[Number(codePage)] || 'utf-8';
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

function queryRegistry(keyPath) {
  try {
    const output = execFileSync('reg.exe', ['query', keyPath], {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return output;
  } catch {
    return null;
  }
}

/** Reads OEM/ANSI code pages so console bytes can be decoded correctly. */
function systemCodePages() {
  if (cachedCodePages) return cachedCodePages;
  const buffer = queryRegistry(CODEPAGE_KEY);
  const values = {};
  if (buffer) {
    const text = decodeBytes(buffer, 65001);
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s{2,}(OEMCP|ACP|MACCP)\s+REG_SZ\s+(\S+)\s*$/.exec(line);
      if (match) values[match[1]] = Number(match[2]);
    }
  }
  cachedCodePages = {
    oem: Number.isFinite(values.OEMCP) ? values.OEMCP : 0,
    ansi: Number.isFinite(values.ACP) ? values.ACP : 0,
    utf8: Number(values.OEMCP) === 65001 || Number(values.ACP) === 65001,
  };
  return cachedCodePages;
}

/** Parses `reg query` output into a name -> value map (values keep spaces). */
function parseRegistryEnvironment(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (!name || name === 'Path') {
      // Path is handled separately so machine and user halves stay distinguishable.
      if (name === 'Path') values[match[1].trim()] = match[3];
      continue;
    }
    values[name] = match[3];
  }
  return values;
}

/** Machine then user environment values from the registry, decoded by code page. */
function registryEnvironment() {
  if (cachedRegistryEnv) return cachedRegistryEnv;
  const codePages = systemCodePages();
  const machineKey = queryRegistry(MACHINE_ENV_KEY);
  const userKey = queryRegistry(USER_ENV_KEY);
  const machine = machineKey ? parseRegistryEnvironment(decodeBytes(machineKey, codePages.oem || 65001)) : {};
  const user = userKey ? parseRegistryEnvironment(decodeBytes(userKey, codePages.oem || 65001)) : {};
  cachedRegistryEnv = { machine, user };
  return cachedRegistryEnv;
}

/** %VAR% lookup: registry machine + user, then the plugin's own environment. */
function buildEnvLookup() {
  const { machine, user } = registryEnvironment();
  const lookup = new Map();
  for (const [name, value] of Object.entries(machine)) lookup.set(name.toLowerCase(), value);
  for (const [name, value] of Object.entries(user)) lookup.set(name.toLowerCase(), value);
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string') lookup.set(name.toLowerCase(), value);
  }
  return lookup;
}

function lookupEnv(lookup, name) {
  return lookup.get(String(name).toLowerCase());
}

/** Expands %NAME% against the lookup; unknown names are left verbatim. */
function expandEnvVars(value, lookup) {
  if (typeof value !== 'string' || value.indexOf('%') < 0) return value;
  return value.replace(/%([^%]+)%/g, (match, name) => {
    const found = lookupEnv(lookup, name);
    return typeof found === 'string' ? found : match;
  });
}

function stripSurroundingQuotes(value) {
  const text = String(value).trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

/** Splits a `;` separated PATH-like value into expanded, unquoted directories. */
function splitPathList(value, lookup) {
  if (typeof value !== 'string' || value.length === 0) return [];
  const result = [];
  for (const raw of value.split(';')) {
    const entry = stripSurroundingQuotes(expandEnvVars(raw, lookup));
    if (entry.length > 0 && entry !== '""') result.push(entry);
  }
  return result;
}

/** The search PATH a real user process would get: machine first, then user. */
function searchPathDirectories() {
  const lookup = buildEnvLookup();
  const { machine, user } = registryEnvironment();
  const directories = [];
  const seen = new Set();
  const push = (list) => {
    for (const directory of list) {
      const key = normalizeForCompare(directory);
      if (seen.has(key)) continue;
      seen.add(key);
      directories.push(directory);
    }
  };
  const processPath = splitPathList(lookupEnv(lookup, 'Path') || '', lookup);
  if (processPath.length > 0) push(processPath);
  push(splitPathList(machine.Path || '', lookup));
  push(splitPathList(user.Path || '', lookup));
  return directories;
}

function normalizeForCompare(value) {
  return String(value).replace(/[\\/]+$/, '').toLowerCase();
}

function fileExists(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function directoryExists(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Finds `name` on the given directories, honouring PATHEXT. */
function findOnPath(name, directories, extensions) {
  const exts = extensions && extensions.length ? extensions : ['.exe', '.cmd', '.bat', '.com'];
  for (const directory of directories) {
    if (!directory) continue;
    for (const ext of exts) {
      const candidate = path.join(directory, name + ext);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function pwshInstallDirectories() {
  const lookup = buildEnvLookup();
  const roots = [];
  for (const name of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    const value = lookupEnv(lookup, name);
    if (typeof value === 'string' && value.length > 0) roots.push(value);
  }
  const candidates = [];
  for (const root of roots) {
    const base = path.join(root, 'PowerShell');
    candidates.push(base);
  }
  const versions = [];
  for (const base of candidates) {
    if (!directoryExists(base)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^7/.test(entry.name)) continue;
      versions.push(path.join(base, entry.name));
    }
  }
  versions.sort((left, right) => right.localeCompare(left, 'en'));
  const windowsApps = lookupEnv(buildEnvLookup(), 'LOCALAPPDATA');
  const extra = [];
  if (typeof windowsApps === 'string' && windowsApps.length > 0) {
    extra.push(path.join(windowsApps, 'Microsoft', 'WindowsApps'));
  }
  return [...versions, ...extra];
}

function windowsPowerShellPath() {
  const lookup = buildEnvLookup();
  const root = lookupEnv(lookup, 'SystemRoot') || lookupEnv(lookup, 'windir') || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function cmdPath() {
  const lookup = buildEnvLookup();
  const comspec = lookupEnv(lookup, 'ComSpec');
  if (typeof comspec === 'string' && comspec.length > 0) {
    const resolved = expandEnvVars(stripSurroundingQuotes(comspec), lookup);
    if (fileExists(resolved)) return resolved;
  }
  const root = lookupEnv(lookup, 'SystemRoot') || lookupEnv(lookup, 'windir') || 'C:\\Windows';
  return path.join(root, 'System32', 'cmd.exe');
}

/**
 * The shells this plugin supports, in preference order. PowerShell 7 wins over
 * Windows PowerShell, which wins over cmd — the same order the task asks for
 * and the order most terminals default to on Windows.
 */
function discoverShells() {
  const lookup = buildEnvLookup();
  const directories = searchPathDirectories();
  const extensions = splitPathList(lookupEnv(lookup, 'PATHEXT') || '', lookup).map((ext) =>
    ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase(),
  );

  const shells = [];

  const pwshOnPath = findOnPath('pwsh', directories, extensions);
  const pwshCandidates = [];
  if (pwshOnPath) pwshCandidates.push(pwshOnPath);
  for (const directory of pwshInstallDirectories()) {
    pwshCandidates.push(path.join(directory, 'pwsh.exe'));
  }
  const pwsh = pwshCandidates.find((candidate) => fileExists(candidate)) || null;
  shells.push({
    id: 'pwsh',
    label: 'PowerShell 7',
    dialect: 'powershell',
    path: pwsh,
    available: Boolean(pwsh),
    args: pwsh ? ['-NoLogo'] : [],
    detail: pwsh || '未安装',
  });

  const powershell = windowsPowerShellPath();
  const powershellAvailable = fileExists(powershell);
  shells.push({
    id: 'windows-powershell',
    label: 'Windows PowerShell 5.1',
    dialect: 'powershell',
    path: powershellAvailable ? powershell : null,
    available: powershellAvailable,
    args: powershellAvailable ? ['-NoLogo'] : [],
    detail: powershellAvailable ? powershell : '未找到',
  });

  const cmd = cmdPath();
  const cmdAvailable = fileExists(cmd);
  shells.push({
    id: 'cmd',
    label: '命令提示符 (cmd)',
    dialect: 'cmd',
    path: cmdAvailable ? cmd : null,
    available: cmdAvailable,
    args: cmdAvailable ? [] : [],
    detail: cmdAvailable ? cmd : '未找到',
  });

  return shells;
}

function preferredShellId(shells) {
  const found = shells.find((shell) => shell.available);
  return found ? found.id : null;
}

/** Validates a working directory; returns the usable path plus a note. */
function resolveWorkingDirectory(candidate) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const value = typeof candidate === 'string' ? candidate.trim().replace(/^"+|"+$/g, '') : '';
  if (!value) {
    return { cwd: home, note: home ? 'no-project' : 'no-directory' };
  }
  if (/^\\\\[^\\?]/.test(value) && !/^\\\\\?\\/.test(value)) {
    // cmd refuses a UNC working directory; PowerShell handles it, so keep the
    // path and let the shell explain if it cannot.
    if (directoryExists(value)) return { cwd: value, note: 'unc' };
    return { cwd: home, note: 'missing-directory' };
  }
  if (directoryExists(value)) {
    return { cwd: value, note: null };
  }
  return { cwd: home, note: 'missing-directory' };
}

/**
 * Builds the launch plan for a shell: resolved executable, argument vector and
 * working directory.
 *
 * The console code page is deliberately left alone. Measured behaviour on a
 * 936 (Simplified Chinese) system: ConPTY carries UTF-8 in *both* directions
 * whatever the console code page says, so `Get-ConsoleCP`-aware legacy tools
 * keep working in their own code page while the plugin still sees UTF-8 on the
 * wire. Forcing `chcp 65001` only added a visible side effect (the window title
 * and the first echoed line changed) and risked mangling a legacy tool's own
 * output. See docs/ARCHITECTURE.md.
 */
function planLaunch(shell, options = {}) {
  if (!shell || !shell.available || !shell.path) {
    return { ok: false, error: 'SHELL_UNAVAILABLE', args: [], cwd: '', path: null };
  }

  const codePages = systemCodePages();
  const cwdInfo = resolveWorkingDirectory(options.cwd);

  return {
    ok: true,
    path: shell.path,
    args: [...(shell.args || [])],
    cwd: cwdInfo.cwd,
    cwdNote: cwdInfo.note,
    codePage: codePages.oem,
    error: null,
  };
}

/** Short human-readable description of a plan, for logs and the status bar. */
function describeLaunch(plan) {
  if (!plan || !plan.ok) return 'shell unavailable';
  return `${path.basename(plan.path)} ${plan.args.join(' ')}`.trim();
}

function resetCaches() {
  cachedCodePages = null;
  cachedRegistryEnv = null;
}

module.exports = {
  discoverShells,
  preferredShellId,
  planLaunch,
  describeLaunch,
  resolveWorkingDirectory,
  systemCodePages,
  registryEnvironment,
  buildEnvLookup,
  expandEnvVars,
  splitPathList,
  stripSurroundingQuotes,
  searchPathDirectories,
  findOnPath,
  parseRegistryEnvironment,
  decodeBytes,
  normalizeForCompare,
  CODEPAGE_ENCODINGS,
  MACHINE_ENV_KEY,
  USER_ENV_KEY,
  CODEPAGE_KEY,
  resetCaches,
};
