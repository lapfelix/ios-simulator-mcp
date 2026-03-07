#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import path from "path";
import os from "os";
import fs from "fs";

const execFileAsync = promisify(execFile);

/**
 * Strict UDID/UUID pattern: 8-4-4-4-12 hexadecimal characters (e.g. 37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA)
 */
const UDID_REGEX =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const TMP_ROOT_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ios-simulator-mcp-")
);

/**
 * Runs a command with arguments and returns the stdout and stderr
 * @param cmd - The command to run
 * @param args - The arguments to pass to the command
 * @returns The stdout and stderr of the command
 */
async function run(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, { shell: false });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

/**
 * Gets the IDB command path from environment variable or defaults to "idb"
 * @returns The path to the IDB executable
 * @throws Error if custom path is specified but doesn't exist
 */
function getIdbPath(): string {
  const customPath = process.env.IOS_SIMULATOR_MCP_IDB_PATH;

  if (customPath) {
    // Expand tilde if present
    const expandedPath = customPath.startsWith("~/")
      ? path.join(os.homedir(), customPath.slice(2))
      : customPath;

    // Check if the path exists
    if (!fs.existsSync(expandedPath)) {
      throw new Error(
        `Custom IDB path specified in IOS_SIMULATOR_MCP_IDB_PATH does not exist: ${expandedPath}`
      );
    }

    return expandedPath;
  }

  return "idb";
}

/**
 * Gets the IDB companion path from environment variable, if set.
 * This is passed as --companion-path to the idb CLI, allowing use of
 * a custom idb_companion binary (e.g. a fork with additional features).
 * @returns The path to the IDB companion executable, or undefined
 * @throws Error if custom path is specified but doesn't exist
 */
function getCompanionPath(): string | undefined {
  const customPath = process.env.IOS_SIMULATOR_MCP_COMPANION_PATH;

  if (customPath) {
    const expandedPath = customPath.startsWith("~/")
      ? path.join(os.homedir(), customPath.slice(2))
      : customPath;

    if (!fs.existsSync(expandedPath)) {
      throw new Error(
        `Custom companion path specified in IOS_SIMULATOR_MCP_COMPANION_PATH does not exist: ${expandedPath}`
      );
    }

    return expandedPath;
  }

  // Auto-detect bundled companion from `npm run setup-companion`
  const bundledPath = path.join(__dirname, "..", ".companion", "bin", "idb_companion");
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  return undefined;
}

/**
 * Runs the idb command with the given arguments
 * @param args - arguments to pass to the idb command
 * @returns The stdout and stderr of the command
 * @see https://fbidb.io/docs/commands for documentation of available idb commands
 */
async function idb(...args: string[]) {
  try {
    const companionPath = getCompanionPath();
    const fullArgs = companionPath
      ? ["--companion-path", companionPath, ...args]
      : args;
    return await run(getIdbPath(), fullArgs);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err && err.code === "ENOENT") {
      throw new Error(
        "Facebook IDB is not installed or not on your PATH. Install it with one of these options:\n" +
          "- pipx install fb-idb\n" +
          "- brew install python && pip3 install --user fb-idb\n" +
          "- asdf install python latest && python -m pip install --user fb-idb\n" +
          "Then ensure the idb binary is on your PATH (often ~/.local/bin), or set IOS_SIMULATOR_MCP_IDB_PATH."
      );
    }
    throw error;
  }
}

// Read filtered tools from environment variable
const FILTERED_TOOLS =
  process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS?.split(",").map((tool) =>
    tool.trim()
  ) || [];

// Function to check if a tool is filtered
function isToolFiltered(toolName: string): boolean {
  return FILTERED_TOOLS.includes(toolName);
}

/**
 * Maps common parameter name guesses to their canonical names.
 * When an LLM sends an alias instead of the canonical name, we silently
 * resolve it and append a hint to the response.
 */
const PARAM_ALIASES: Record<string, string> = {
  // term (ui_describe_search, search_and_tap)
  query: "term",
  search: "term",
  searchTerm: "term",
  search_term: "term",
  searchQuery: "search_query",
  search_query: "term",
  keyword: "term",
  label: "term",
  filter: "term",
  pattern: "term",
  q: "term",
  find: "term",
  lookup: "term",
  searchText: "term",
  search_text: "term",
  searchString: "term",
  search_string: "term",

  // x / y (ui_tap, ui_describe_point)
  posX: "x",
  pos_x: "x",
  coordX: "x",
  coord_x: "x",
  tapX: "x",
  tap_x: "x",
  pointX: "x",
  point_x: "x",
  xCoord: "x",
  x_coord: "x",
  xPos: "x",
  x_pos: "x",
  locationX: "x",
  location_x: "x",
  screenX: "x",
  screen_x: "x",
  posY: "y",
  pos_y: "y",
  coordY: "y",
  coord_y: "y",
  tapY: "y",
  tap_y: "y",
  pointY: "y",
  point_y: "y",
  yCoord: "y",
  y_coord: "y",
  yPos: "y",
  y_pos: "y",
  locationY: "y",
  location_y: "y",
  screenY: "y",
  screen_y: "y",

  // x_start / y_start / x_end / y_end (ui_swipe)
  startX: "x_start",
  start_x: "x_start",
  fromX: "x_start",
  from_x: "x_start",
  xStart: "x_start",
  x_from: "x_start",
  xFrom: "x_start",
  x1: "x_start",
  originX: "x_start",
  origin_x: "x_start",
  sourceX: "x_start",
  source_x: "x_start",
  startY: "y_start",
  start_y: "y_start",
  fromY: "y_start",
  from_y: "y_start",
  yStart: "y_start",
  y_from: "y_start",
  yFrom: "y_start",
  y1: "y_start",
  originY: "y_start",
  origin_y: "y_start",
  sourceY: "y_start",
  source_y: "y_start",
  endX: "x_end",
  end_x: "x_end",
  toX: "x_end",
  to_x: "x_end",
  xEnd: "x_end",
  x_to: "x_end",
  xTo: "x_end",
  x2: "x_end",
  destinationX: "x_end",
  destination_x: "x_end",
  targetX: "x_end",
  target_x: "x_end",
  endY: "y_end",
  end_y: "y_end",
  toY: "y_end",
  to_y: "y_end",
  yEnd: "y_end",
  y_to: "y_end",
  yTo: "y_end",
  y2: "y_end",
  destinationY: "y_end",
  destination_y: "y_end",
  targetY: "y_end",
  target_y: "y_end",

  // delta (ui_swipe)
  step: "delta",
  stepSize: "delta",
  step_size: "delta",
  increment: "delta",

  // duration
  press_duration: "duration",
  pressDuration: "duration",
  hold_duration: "duration",
  holdDuration: "duration",
  tap_duration: "duration",
  tapDuration: "duration",
  swipe_duration: "duration",
  swipeDuration: "duration",
  hold_time: "duration",
  holdTime: "duration",

  // text (ui_type, ui_type_in_field)
  input: "text",
  inputText: "text",
  input_text: "text",
  value: "text",
  content: "text",
  message: "text",
  characters: "text",
  keys: "text",
  typeText: "text",
  type_text: "text",
  textToType: "text",
  text_to_type: "text",
  keystrokes: "text",
  textInput: "text",
  text_input: "text",

  // field_query (ui_type_in_field)
  field: "field_query",
  fieldQuery: "field_query",
  fieldName: "field_query",
  field_name: "field_query",
  fieldLabel: "field_query",
  field_label: "field_query",
  placeholder: "field_query",
  inputField: "field_query",
  input_field: "field_query",
  textField: "field_query",
  text_field: "field_query",
  fieldText: "field_query",
  field_text: "field_query",
  selector: "field_query",
  fieldId: "field_query",
  field_id: "field_query",

  // output_path (screenshot, record_video)
  path: "output_path",
  outputPath: "output_path",
  filePath: "output_path",
  file_path: "output_path",
  filename: "output_path",
  file_name: "output_path",
  fileName: "output_path",
  savePath: "output_path",
  save_path: "output_path",
  destination: "output_path",
  dest: "output_path",
  output: "output_path",
  outputFile: "output_path",
  output_file: "output_path",
  save_to: "output_path",
  saveTo: "output_path",
  file: "output_path",

  // type/format (screenshot)
  format: "type",
  imageFormat: "type",
  image_format: "type",
  image_type: "type",
  imageType: "type",
  ext: "type",
  extension: "type",
  fileType: "type",
  file_type: "type",
  outputFormat: "type",
  output_format: "type",

  // codec (record_video)
  videoCodec: "codec",
  video_codec: "codec",
  encoder: "codec",
  encoding: "codec",
  videoFormat: "codec",
  video_format: "codec",

  // force (record_video)
  overwrite: "force",

  // app_path (install_app)
  appPath: "app_path",
  bundlePath: "app_path",
  bundle_path: "app_path",
  appFile: "app_path",
  app_file: "app_path",
  ipaPath: "app_path",
  ipa_path: "app_path",
  appBundle: "app_path",
  app_bundle: "app_path",
  binaryPath: "app_path",
  binary_path: "app_path",
  app: "app_path",

  // bundle_id (launch_app)
  bundleId: "bundle_id",
  bundleIdentifier: "bundle_id",
  bundle_identifier: "bundle_id",
  appId: "bundle_id",
  app_id: "bundle_id",
  appIdentifier: "bundle_id",
  app_identifier: "bundle_id",
  identifier: "bundle_id",
  id: "bundle_id",
  packageName: "bundle_id",
  package_name: "bundle_id",
  appName: "bundle_id",
  app_name: "bundle_id",

  // terminate_running (launch_app)
  terminateRunning: "terminate_running",
  restart: "terminate_running",
  relaunch: "terminate_running",
  kill: "terminate_running",
  killFirst: "terminate_running",
  kill_first: "terminate_running",
  terminate: "terminate_running",
  fresh: "terminate_running",
  freshLaunch: "terminate_running",
  fresh_launch: "terminate_running",

  // compression (ui_describe_search, ui_describe_all)
  compressionMode: "compression",
  compression_mode: "compression",
  displayMode: "compression",
  display_mode: "compression",
  mode: "compression",

  // wait (tap_wait_and_describe)
  delay: "wait",
  wait_time: "wait",
  waitTime: "wait",
  pause: "wait",
  timeout: "wait",
  sleep: "wait",
};

/**
 * Extends a Zod schema shape by adding alias fields.
 * For each canonical param in the shape that has aliases in PARAM_ALIASES,
 * adds those aliases as optional fields with z.any() so they pass validation.
 */
function withAliases<T extends Record<string, z.ZodTypeAny>>(shape: T): T & Record<string, z.ZodTypeAny> {
  const extended: Record<string, z.ZodTypeAny> = { ...shape };
  const canonicalKeys = new Set(Object.keys(shape));

  for (const [alias, canonical] of Object.entries(PARAM_ALIASES)) {
    if (canonicalKeys.has(canonical) && !canonicalKeys.has(alias)) {
      extended[alias] = z.any().optional().describe(`Alias for '${canonical}'`);
    }
  }
  return extended as T & Record<string, z.ZodTypeAny>;
}

/**
 * Resolves aliased parameter names to their canonical names.
 * Returns the resolved args and a list of aliases that were used.
 */
function resolveAliases(args: Record<string, unknown>): {
  resolved: Record<string, unknown>;
  aliasHint: string;
} {
  const resolved: Record<string, unknown> = { ...args };
  const used: string[] = [];

  for (const [alias, canonical] of Object.entries(PARAM_ALIASES)) {
    if (alias in resolved && resolved[alias] != null) {
      // Only use alias if canonical is not already provided
      if (!(canonical in resolved) || resolved[canonical] == null) {
        resolved[canonical] = resolved[alias];
        used.push(`'${alias}' → '${canonical}'`);
      }
      delete resolved[alias];
    }
  }

  const aliasHint =
    used.length > 0
      ? `\nFYI: Resolved param aliases: ${used.join(", ")}. Prefer the canonical names next time.`
      : "";

  return { resolved, aliasHint };
}

const server = new McpServer({
  name: "ios-simulator",
  version: require("../package.json").version,
});

function toError(input: unknown): Error {
  if (input instanceof Error) return input;

  if (
    typeof input === "object" &&
    input &&
    "message" in input &&
    typeof input.message === "string"
  )
    return new Error(input.message);

  return new Error(JSON.stringify(input));
}

function troubleshootingLink(): string {
  return "[Troubleshooting Guide](https://github.com/joshuayoes/ios-simulator-mcp/blob/main/TROUBLESHOOTING.md) | [Plain Text Guide for LLMs](https://raw.githubusercontent.com/joshuayoes/ios-simulator-mcp/refs/heads/main/TROUBLESHOOTING.md)";
}

function errorWithTroubleshooting(message: string): string {
  return `${message}\n\nFor help, see the ${troubleshootingLink()}`;
}

async function getBootedDevice() {
  const { stdout, stderr } = await run("xcrun", ["simctl", "list", "devices"]);

  if (stderr) throw new Error(stderr);

  // Parse the output to find booted device
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (line.includes("Booted")) {
      // Extract the UUID - it's inside parentheses
      const match = line.match(/\(([-0-9A-F]+)\)/);
      if (match) {
        const deviceId = match[1];
        const deviceName = line.split("(")[0].trim();
        return {
          name: deviceName,
          id: deviceId,
        };
      }
    }
  }

  throw Error("No booted simulator found");
}

async function getBootedDeviceId(
  deviceId: string | undefined
): Promise<string> {
  // If deviceId not provided, get the currently booted simulator
  let actualDeviceId = deviceId;
  if (!actualDeviceId) {
    const { id } = await getBootedDevice();
    actualDeviceId = id;
  }
  if (!actualDeviceId) {
    throw new Error("No booted simulator found and no deviceId provided");
  }
  return actualDeviceId;
}

const UI_COMPRESSION_MODES = [
  "raw",
  "compact",
  "compact_full_precision",
  "compact_round",
  "table",
  "table_dedup",
] as const;
type UiCompressionMode = (typeof UI_COMPRESSION_MODES)[number];
const DEFAULT_UI_COMPRESSION_MODE: UiCompressionMode = "compact";

const UI_DROP_KEYS = new Set(["AXFrame", "role_description", "role"]);
const UI_KEY_MAP: Record<string, string> = {
  type: "t",
  AXLabel: "l",
  AXUniqueId: "id",
  children: "c",
  frame: "f",
  help: "h",
  title: "ti",
  AXValue: "v",
  custom_actions: "a",
  content_required: "cr",
  enabled: "e",
  subrole: "sr",
};
const UI_SEARCH_FIELDS = [
  "AXLabel",
  "title",
  "help",
  "AXValue",
  "AXUniqueId",
] as const;
const UI_TEXT_INPUT_TYPES = new Set([
  "TextField",
  "SecureTextField",
  "TextView",
  "SearchField",
]);
const UI_TEXT_INPUT_ROLES = new Set([
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pruneUiTree(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneUiTree);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null) continue;
    if (UI_DROP_KEYS.has(key)) continue;
    if (key === "enabled" && raw === true) continue;
    if (key === "content_required" && raw === false) continue;
    if (
      (key === "children" || key === "custom_actions") &&
      Array.isArray(raw) &&
      raw.length === 0
    )
      continue;

    const pruned = pruneUiTree(raw);
    if (
      (key === "children" || key === "custom_actions") &&
      Array.isArray(pruned) &&
      pruned.length === 0
    )
      continue;

    result[key] = pruned;
  }

  return result;
}

function normalizeFrame(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeFrame);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "frame" && isPlainObject(raw)) {
      const frame = raw as Record<string, unknown>;
      const x = frame.x;
      const y = frame.y;
      const width = frame.width;
      const height = frame.height;
      if (
        typeof x === "number" &&
        typeof y === "number" &&
        typeof width === "number" &&
        typeof height === "number"
      ) {
        result[key] = [x, y, width, height];
        continue;
      }
    }

    result[key] = normalizeFrame(raw);
  }

  return result;
}

function shortenKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(shortenKeys);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const mappedKey = UI_KEY_MAP[key] ?? key;
    result[mappedKey] = shortenKeys(raw);
  }

  return result;
}

function roundNumbers(value: unknown, decimals: number): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => roundNumbers(entry, decimals));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      result[key] = roundNumbers(raw, decimals);
    }
    return result;
  }
  if (typeof value === "number") {
    const factor = Math.pow(10, decimals);
    const rounded = Math.round(value * factor) / factor;
    const normalized =
      Math.abs(rounded - Math.round(rounded)) < 1e-9
        ? Math.round(rounded)
        : rounded;
    return Object.is(normalized, -0) ? 0 : normalized;
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify(
          (value as Record<string, unknown>)[key]
        )}`
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function dedupSiblings(value: unknown): { node: unknown; removed: number } {
  if (Array.isArray(value)) {
    let removed = 0;
    const list = value.map((entry) => {
      const { node, removed: entryRemoved } = dedupSiblings(entry);
      removed += entryRemoved;
      return node;
    });
    return { node: list, removed };
  }
  if (!isPlainObject(value)) {
    return { node: value, removed: 0 };
  }

  let removed = 0;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if ((key === "children" || key === "c") && Array.isArray(raw)) {
      const seen = new Set<string>();
      const children: unknown[] = [];
      for (const child of raw) {
        const { node: childNode, removed: childRemoved } = dedupSiblings(child);
        removed += childRemoved;
        const signature = stableStringify(childNode);
        if (seen.has(signature)) {
          removed += 1;
          continue;
        }
        seen.add(signature);
        children.push(childNode);
      }
      result[key] = children;
      continue;
    }

    const { node, removed: entryRemoved } = dedupSiblings(raw);
    removed += entryRemoved;
    result[key] = node;
  }

  return { node: result, removed };
}

function buildStringTable(value: unknown): { s: string[]; n: unknown } {
  const strings: string[] = [];
  const index = new Map<string, number>();

  const intern = (input: string) => {
    const existing = index.get(input);
    if (existing !== undefined) return existing;
    const id = strings.length;
    strings.push(input);
    index.set(input, id);
    return id;
  };

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (isPlainObject(node)) {
      const result: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(node)) {
        result[key] = walk(raw);
      }
      return result;
    }
    if (typeof node === "string") {
      return intern(node);
    }
    return node;
  };

  return { s: strings, n: walk(value) };
}

/**
 * Removes nodes whose frames are entirely outside the visible screen area.
 * Keeps nodes without frames (structural) and nodes with on-screen children.
 */
function pruneOffScreenNodes(
  value: unknown,
  screenWidth: number,
  screenHeight: number
): unknown {
  const overlapsScreen = (node: Record<string, unknown>): boolean => {
    const frame = getNodeFrame(node);
    if (!frame) return true;
    return (
      frame.x + frame.width > 0 &&
      frame.x < screenWidth &&
      frame.y + frame.height > 0 &&
      frame.y < screenHeight
    );
  };

  const visit = (node: unknown): unknown | null => {
    if (Array.isArray(node)) {
      return node.map(visit).filter((n): n is unknown => n !== null);
    }
    if (!isPlainObject(node)) return node;

    const onScreen = overlapsScreen(node);
    const rawChildren = node.children;

    if (Array.isArray(rawChildren)) {
      const filteredChildren = rawChildren
        .map(visit)
        .filter((n): n is unknown => n !== null);
      if (!onScreen && filteredChildren.length === 0) return null;
      const result = { ...node };
      result.children = filteredChildren;
      return result;
    }

    return onScreen ? node : null;
  };

  return visit(value);
}

function compressUiTree(value: unknown, mode: UiCompressionMode): unknown {
  if (mode === "raw") {
    return value;
  }

  let output = pruneUiTree(value);
  output = normalizeFrame(output);
  output = shortenKeys(output);

  if (
    mode === "compact" ||
    mode === "compact_round" ||
    mode === "table" ||
    mode === "table_dedup"
  ) {
    output = roundNumbers(output, 1);
  }

  if (mode === "table_dedup") {
    output = dedupSiblings(output).node;
  }

  if (mode === "table" || mode === "table_dedup") {
    output = buildStringTable(output);
  }

  return output;
}

function nodeMatchesSearch(node: Record<string, unknown>, needle: string): boolean {
  const lowered = needle.toLowerCase();
  for (const field of UI_SEARCH_FIELDS) {
    const value = node[field];
    if (typeof value === "string" && value.toLowerCase().includes(lowered)) {
      return true;
    }
  }
  return false;
}

function filterUiTree(value: unknown, term: string): unknown {
  const visit = (node: unknown): unknown | null => {
    if (!isPlainObject(node)) {
      return null;
    }

    const rawChildren = (node as Record<string, unknown>).children;
    const children = Array.isArray(rawChildren) ? rawChildren : [];
    const filteredChildren = children
      .map(visit)
      .filter((child): child is unknown => child !== null);
    const isMatch = nodeMatchesSearch(node, term);

    if (!isMatch && filteredChildren.length === 0) {
      return null;
    }

    const result: Record<string, unknown> = { ...node };
    if (rawChildren !== undefined || filteredChildren.length > 0) {
      result.children = filteredChildren;
    }

    return result;
  };

  if (Array.isArray(value)) {
    return value
      .map(visit)
      .filter((node): node is unknown => node !== null);
  }

  return visit(value) ?? [];
}

function isTextInputNode(node: Record<string, unknown>): boolean {
  const type = node.type;
  if (typeof type === "string" && UI_TEXT_INPUT_TYPES.has(type)) {
    return true;
  }

  const role = node.role;
  if (typeof role === "string" && UI_TEXT_INPUT_ROLES.has(role)) {
    return true;
  }

  return false;
}

function getNodeLabel(node: Record<string, unknown>): string {
  for (const field of UI_SEARCH_FIELDS) {
    const value = node[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return "<unlabeled>";
}

function getNodeId(node: Record<string, unknown>): string | null {
  const value = node.AXUniqueId;
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return null;
}

function getNodeFrame(
  node: Record<string, unknown>
): { x: number; y: number; width: number; height: number } | null {
  const frame = node.frame;
  if (Array.isArray(frame) && frame.length >= 4) {
    const [x, y, width, height] = frame;
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      return { x, y, width, height };
    }
  }

  if (isPlainObject(frame)) {
    const x = frame.x;
    const y = frame.y;
    const width = frame.width;
    const height = frame.height;
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      return { x, y, width, height };
    }
  }

  return null;
}

function getNodeFrameCenter(
  node: Record<string, unknown>
): { x: number; y: number } | null {
  const frame = node.frame;

  if (Array.isArray(frame) && frame.length >= 4) {
    const [x, y, width, height] = frame;
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      return {
        x: x + width / 2,
        y: y + height / 2,
      };
    }
  }

  if (isPlainObject(frame)) {
    const x = frame.x;
    const y = frame.y;
    const width = frame.width;
    const height = frame.height;
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      return {
        x: x + width / 2,
        y: y + height / 2,
      };
    }
  }

  return null;
}

function collectMatchingNodes(
  value: unknown,
  term: string
): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry);
      }
      return;
    }

    if (!isPlainObject(node)) {
      return;
    }

    if (nodeMatchesSearch(node, term)) {
      nodes.push(node);
    }

    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child);
      }
    }
  };

  visit(value);
  return nodes;
}

function collectTextInputNodes(value: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry);
      }
      return;
    }

    if (!isPlainObject(node)) {
      return;
    }

    if (isTextInputNode(node)) {
      nodes.push(node);
    }

    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child);
      }
    }
  };

  visit(value);
  return nodes;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function framesMatch(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
  decimals = 1
): boolean {
  const leftRounded = {
    x: roundToDecimals(left.x, decimals),
    y: roundToDecimals(left.y, decimals),
    width: roundToDecimals(left.width, decimals),
    height: roundToDecimals(left.height, decimals),
  };
  const rightRounded = {
    x: roundToDecimals(right.x, decimals),
    y: roundToDecimals(right.y, decimals),
    width: roundToDecimals(right.width, decimals),
    height: roundToDecimals(right.height, decimals),
  };

  return (
    leftRounded.x === rightRounded.x &&
    leftRounded.y === rightRounded.y &&
    leftRounded.width === rightRounded.width &&
    leftRounded.height === rightRounded.height
  );
}

function nodeMatchesCandidate(
  node: Record<string, unknown>,
  candidate: Record<string, unknown>
): boolean {
  const nodeId = getNodeId(node);
  const candidateId = getNodeId(candidate);
  if (nodeId && candidateId) {
    return nodeId === candidateId;
  }

  const nodeFrame = getNodeFrame(node);
  const candidateFrame = getNodeFrame(candidate);
  if (!nodeFrame || !candidateFrame) {
    return false;
  }

  const nodeLabel = getNodeLabel(node);
  const candidateLabel = getNodeLabel(candidate);
  if (nodeLabel === "<unlabeled>" || candidateLabel === "<unlabeled>") {
    return false;
  }

  if (nodeLabel !== candidateLabel) {
    return false;
  }

  return framesMatch(nodeFrame, candidateFrame, 1);
}

function subtreeContainsNode(
  root: Record<string, unknown>,
  candidate: Record<string, unknown>
): boolean {
  if (nodeMatchesCandidate(root, candidate)) {
    return true;
  }

  const children = root.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isPlainObject(child) && subtreeContainsNode(child, candidate)) {
        return true;
      }
    }
  }

  return false;
}

// Register tools only if they're not filtered
if (!isToolFiltered("get_booted_sim_id")) {
  server.tool(
    "get_booted_sim_id",
    "Get the ID of the currently booted iOS simulator",
    { title: "Get Booted Simulator ID", readOnlyHint: true, openWorldHint: true },
    async () => {
      try {
        const { id, name } = await getBootedDevice();

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Booted Simulator: "${name}". UUID: "${id}"`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("open_simulator")) {
  server.tool(
    "open_simulator",
    "Opens the iOS Simulator application",
    { title: "Open Simulator", readOnlyHint: false, openWorldHint: true },
    async () => {
      try {
        await run("open", ["-a", "Simulator.app"]);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "Simulator opened",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error opening Simulator.app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_all")) {
  server.tool(
    "ui_describe_all",
    "Returns screenshot + accessibility tree for visible on-screen elements. Use to understand current screen state.",
    withAliases({
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      compression: z
        .enum(UI_COMPRESSION_MODES)
        .optional()
        .describe(
          "Compression mode for the returned tree. raw, compact, compact_full_precision, table, or table_dedup. Default: compact."
        ),
      include_off_screen_elements: z
        .boolean()
        .optional()
        .describe(
          "Include elements outside the visible screen area (default: false). Enable for maps or content that extends beyond the viewport."
        ),
    }),
    { title: "Describe All UI Elements", readOnlyHint: true, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);
        const includeOffScreen = args.include_off_screen_elements as boolean | undefined;

        const { stdout } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        const uiData = JSON.parse(stdout);
        const screenFrame = uiData[0]?.frame;
        const visibleData = (!includeOffScreen && screenFrame)
          ? pruneOffScreenNodes(uiData, screenFrame.width, screenFrame.height)
          : uiData;
        const base64Data = await tryCapture(
          actualUdid,
          screenFrame ? { width: screenFrame.width, height: screenFrame.height } : undefined
        );

        const mode = (args.compression as UiCompressionMode | undefined) ?? DEFAULT_UI_COMPRESSION_MODE;
        const treeText = mode === "raw" ? JSON.stringify(visibleData) : JSON.stringify(compressUiTree(visibleData, mode));

        const content: ({ type: "image"; data: string; mimeType: "image/jpeg" } | { type: "text"; text: string })[] = [];
        if (base64Data) {
          content.push({ type: "image" as const, data: base64Data, mimeType: "image/jpeg" as const });
        }
        content.push({ type: "text" as const, text: treeText + aliasHint });

        return { isError: false, content };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing all of the ui: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_search")) {
  server.tool(
    "ui_describe_search",
    "Search visible UI elements by label text. Returns screenshot + filtered accessibility tree with only matches and their parents.",
    withAliases({
      term: z
        .string()
        .min(1)
        .describe(
          "Case-insensitive substring to match against accessibility labels and related fields"
        ),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      compression: z
        .enum(UI_COMPRESSION_MODES)
        .optional()
        .describe(
          "Compression mode for the returned tree. raw, compact, compact_full_precision, table, or table_dedup. Default: compact."
        ),
      include_off_screen_elements: z
        .boolean()
        .optional()
        .describe(
          "Include elements outside the visible screen area (default: false). Enable for maps or content that extends beyond the viewport."
        ),
    }),
    { title: "Search UI Elements", readOnlyHint: true, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const term = args.term as string | undefined;
        const includeOffScreen = args.include_off_screen_elements as boolean | undefined;
        if (!term) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: 'Missing required parameter "term": a search string to match against accessibility labels.',
              },
            ],
          };
        }

        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);

        const { stdout } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        const uiData = JSON.parse(stdout);
        const screenFrame = uiData[0]?.frame;
        const visibleData = (!includeOffScreen && screenFrame)
          ? pruneOffScreenNodes(uiData, screenFrame.width, screenFrame.height)
          : uiData;
        const base64Data = await tryCapture(
          actualUdid,
          screenFrame ? { width: screenFrame.width, height: screenFrame.height } : undefined
        );

        const filtered = filterUiTree(visibleData, term);
        const mode = (args.compression as UiCompressionMode | undefined) ?? DEFAULT_UI_COMPRESSION_MODE;
        const treeText = mode === "raw" ? JSON.stringify(filtered) : JSON.stringify(compressUiTree(filtered, mode));

        const content: ({ type: "image"; data: string; mimeType: "image/jpeg" } | { type: "text"; text: string })[] = [];
        if (base64Data) {
          content.push({ type: "image" as const, data: base64Data, mimeType: "image/jpeg" as const });
        }
        content.push({ type: "text" as const, text: treeText + aliasHint });

        return { isError: false, content };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error searching ui elements: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_tap")) {
  server.tool(
    "ui_tap",
    "Tap at (x, y). Returns no screen state - use tap_wait_and_describe instead if you need to see the result.",
    withAliases({
      duration: z
        .union([z.number(), z.string()])
        .optional()
        .describe("Press duration in seconds (e.g. 1 or 0.5)"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x: z.coerce.number().describe("The x-coordinate"),
      y: z.coerce.number().describe("The y-coordinate"),
    }),
    { title: "UI Tap", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const x = args.x as number;
        const y = args.y as number;
        const duration = args.duration != null ? String(args.duration) : undefined;
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);

        const roundedX = Math.round(x);
        const roundedY = Math.round(y);
        const wasRounded = roundedX !== x || roundedY !== y;

        const { stderr } = await idb(
          "ui",
          "tap",
          "--udid",
          actualUdid,
          ...(duration ? ["--duration", duration] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(roundedX),
          String(roundedY)
        );

        if (stderr) throw new Error(stderr);

        const message = `Tapped (${roundedX}, ${roundedY})`;

        return {
          isError: false,
          content: [{ type: "text", text: message + aliasHint }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error tapping on the screen: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("search_and_tap")) {
  server.tool(
    "search_and_tap",
    "Search by label and tap if exactly one match. Fails with coordinates if multiple matches - use ui_tap to pick one.",
    withAliases({
      term: z
        .string()
        .min(1)
        .describe(
          "Case-insensitive substring to match against accessibility labels and related fields"
        ),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      duration: z
        .union([z.number(), z.string()])
        .optional()
        .describe("Press duration in seconds (e.g. 1 or 0.5)"),
    }),
    { title: "Search And Tap", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const term = args.term as string | undefined;
        const duration = args.duration != null ? String(args.duration) : undefined;
        if (!term) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: 'Missing required parameter "term": a search string to match against accessibility labels.',
              },
            ],
          };
        }

        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);

        const { stdout } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        const uiData = JSON.parse(stdout);
        let matches = collectMatchingNodes(uiData, term);

        if (matches.length === 0) {
          throw new Error(`No matching elements found for "${term}".`);
        }

        // When multiple substring matches exist, prefer exact matches
        if (matches.length > 1) {
          const lowered = term.toLowerCase();
          const exactMatches = matches.filter((node) => {
            for (const field of UI_SEARCH_FIELDS) {
              const value = (node as Record<string, unknown>)[field];
              if (typeof value === "string" && value.toLowerCase() === lowered) {
                return true;
              }
            }
            return false;
          });
          if (exactMatches.length === 1) {
            matches = exactMatches;
          }
        }

        if (matches.length > 1) {
          const details = matches
            .slice(0, 5)
            .map((node) => {
              const label = getNodeLabel(node);
              const center = getNodeFrameCenter(node);
              return center
                ? `"${label}" at (${Math.round(center.x)}, ${Math.round(center.y)})`
                : `"${label}"`;
            })
            .join(", ");
          throw new Error(
            `${matches.length} matches for "${term}": ${details}. Use a more specific term or ui_tap with coordinates.`
          );
        }

        const target = matches[0];
        const center = getNodeFrameCenter(target);
        if (!center) {
          throw new Error(
            `Matched element "${getNodeLabel(target)}" does not have a valid frame.`
          );
        }

        const tapX = Math.round(center.x);
        const tapY = Math.round(center.y);

        const { stdout: pointStdout } = await idb(
          "ui",
          "describe-point",
          "--udid",
          actualUdid,
          "--json",
          "--",
          String(tapX),
          String(tapY)
        );

        const pointData = JSON.parse(pointStdout);
        let pointNode: Record<string, unknown> | null = null;
        if (Array.isArray(pointData) && pointData.length > 0) {
          const first = pointData[0];
          if (isPlainObject(first)) {
            pointNode = first;
          }
        } else if (isPlainObject(pointData)) {
          pointNode = pointData;
        }

        if (!pointNode) {
          throw new Error(
            `Could not determine element at (${tapX}, ${tapY}) to validate visibility.`
          );
        }

        if (!subtreeContainsNode(target, pointNode)) {
          throw new Error(
            `Element "${getNodeLabel(
              target
            )}" is obstructed by "${getNodeLabel(pointNode)}" at (${tapX}, ${tapY}).`
          );
        }

        const { stderr } = await idb(
          "ui",
          "tap",
          "--udid",
          actualUdid,
          ...(duration ? ["--duration", duration] : []),
          "--json",
          "--",
          String(tapX),
          String(tapY)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Tapped "${getNodeLabel(target)}" at (${tapX}, ${tapY})` + aliasHint,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error searching and tapping "${(rawArgs as Record<string, unknown>).term ?? (rawArgs as Record<string, unknown>).query ?? ""}": ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("tap_wait_and_describe")) {
  server.tool(
    "tap_wait_and_describe",
    "Tap at (x, y), wait for UI to settle, then return screenshot + accessibility tree. Preferred over ui_tap when you need to see the result.",
    withAliases({
      x: z.coerce.number().describe("The x-coordinate to tap"),
      y: z.coerce.number().describe("The y-coordinate to tap"),
      duration: z
        .union([z.number(), z.string()])
        .optional()
        .describe("Tap hold duration in seconds (e.g. 1 or 0.5)"),
      wait: z
        .coerce.number()
        .optional()
        .describe("Seconds to wait after tap before capturing UI state (default: 2)"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      compression: z
        .enum(UI_COMPRESSION_MODES)
        .optional()
        .describe(
          "Compression mode for the returned tree. raw, compact, compact_full_precision, table, or table_dedup. Default: compact."
        ),
      include_off_screen_elements: z
        .boolean()
        .optional()
        .describe(
          "Include elements outside the visible screen area (default: false). Enable for maps or content that extends beyond the viewport."
        ),
    }),
    { title: "Tap Wait And Describe", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const x = args.x as number;
        const y = args.y as number;
        const duration = args.duration != null ? String(args.duration) : undefined;
        const waitSeconds = (args.wait as number | undefined) ?? 2;
        const includeOffScreen = args.include_off_screen_elements as boolean | undefined;
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);

        const roundedX = Math.round(x);
        const roundedY = Math.round(y);

        // 1. Tap
        const { stderr } = await idb(
          "ui",
          "tap",
          "--udid",
          actualUdid,
          ...(duration ? ["--duration", duration] : []),
          "--json",
          "--",
          String(roundedX),
          String(roundedY)
        );
        if (stderr) throw new Error(stderr);

        // 2. Wait for UI to settle
        await new Promise((r) => setTimeout(r, waitSeconds * 1000));

        // 3. Describe the UI
        const { stdout } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );
        const uiData = JSON.parse(stdout);

        // 4. Screenshot
        const screenFrame = uiData[0]?.frame;
        const visibleData = (!includeOffScreen && screenFrame)
          ? pruneOffScreenNodes(uiData, screenFrame.width, screenFrame.height)
          : uiData;
        const base64Data = await tryCapture(
          actualUdid,
          screenFrame ? { width: screenFrame.width, height: screenFrame.height } : undefined
        );

        // 5. Compress UI tree
        const mode = (args.compression as UiCompressionMode | undefined) ?? DEFAULT_UI_COMPRESSION_MODE;
        const treeText = mode === "raw" ? JSON.stringify(visibleData) : JSON.stringify(compressUiTree(visibleData, mode));

        const tapMessage = `Tapped (${roundedX}, ${roundedY}), waited ${waitSeconds}s`;

        const content: ({ type: "image"; data: string; mimeType: "image/jpeg" } | { type: "text"; text: string })[] = [];
        content.push({ type: "text" as const, text: tapMessage + aliasHint });
        if (base64Data) {
          content.push({ type: "image" as const, data: base64Data, mimeType: "image/jpeg" as const });
        }
        content.push({ type: "text" as const, text: treeText });

        return { isError: false, content };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error in tap_wait_and_describe: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_type")) {
  server.tool(
    "ui_type",
    "Type text into the currently focused field. Tap a field first or use ui_type_in_field to find and focus one.",
    withAliases({
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      text: z
        .string()
        .max(500)
        .regex(/^[\x20-\x7E]+$/)
        .describe("Text to input"),
    }),
    { title: "UI Type", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const text = args.text as string;
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);

        const { stderr } = await idb(
          "ui",
          "text",
          "--udid",
          actualUdid,
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          text
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Typed" + aliasHint }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error typing text into the iOS Simulator: ${
                  toError(error).message
                }`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_type_in_field")) {
  server.tool(
    "ui_type_in_field",
    "Find a text field by label, tap to focus it, and type text. Preferred over ui_type when the field isn't already focused.",
    withAliases({
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      field_query: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Case-insensitive substring used to find a text input by AXLabel, AXUniqueId, title, help, or AXValue"
        ),
      text: z
        .string()
        .max(500)
        .regex(/^[\x20-\x7E]+$/)
        .describe("Text to input"),
    }),
    { title: "UI Type In Field", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const field_query = args.field_query as string;
        const text = args.text as string;
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);

        const { stdout } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );
        const uiData = JSON.parse(stdout);

        const textInputs = collectTextInputNodes(uiData);
        const matches = textInputs.filter((node) =>
          nodeMatchesSearch(node, field_query)
        );

        if (matches.length === 0) {
          const availableFields = textInputs
            .slice(0, 5)
            .map((node) => getNodeLabel(node))
            .join(", ");
          throw new Error(
            availableFields.length > 0
              ? `No matching text field found for "${field_query}". Available text fields: ${availableFields}`
              : `No text input fields found on screen for "${field_query}".`
          );
        }

        const target = matches[0];
        const center = getNodeFrameCenter(target);
        if (!center) {
          throw new Error(
            `Matched text field "${getNodeLabel(target)}" does not have a valid frame.`
          );
        }

        const tapX = Math.round(center.x);
        const tapY = Math.round(center.y);

        const { stderr: tapError } = await idb(
          "ui",
          "tap",
          "--udid",
          actualUdid,
          "--json",
          "--",
          String(tapX),
          String(tapY)
        );
        if (tapError) throw new Error(tapError);

        const { stderr: typeError } = await idb(
          "ui",
          "text",
          "--udid",
          actualUdid,
          "--",
          text
        );
        if (typeError) throw new Error(typeError);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Typed into "${getNodeLabel(target)}" at (${tapX}, ${tapY})` + aliasHint,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error typing into text field: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_swipe")) {
  server.tool(
    "ui_swipe",
    "Swipe from (x_start, y_start) to (x_end, y_end). For simple scrolling, use ui_scroll instead.",
    withAliases({
      duration: z
        .union([z.number(), z.string()])
        .optional()
        .describe("Swipe duration in seconds (e.g. 1 or 0.5)"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x_start: z.coerce.number().describe("The starting x-coordinate"),
      y_start: z.coerce.number().describe("The starting y-coordinate"),
      x_end: z.coerce.number().describe("The ending x-coordinate"),
      y_end: z.coerce.number().describe("The ending y-coordinate"),
      delta: z
        .coerce.number()
        .optional()
        .describe("The size of each step in the swipe (default is 1)")
        .default(1),
    }),
    { title: "UI Swipe", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const x_start = args.x_start as number;
        const y_start = args.y_start as number;
        const x_end = args.x_end as number;
        const y_end = args.y_end as number;
        const duration = args.duration != null ? String(args.duration) : undefined;
        const delta = args.delta as number | undefined;
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);

        const rXStart = Math.round(x_start);
        const rYStart = Math.round(y_start);
        const rXEnd = Math.round(x_end);
        const rYEnd = Math.round(y_end);
        const wasRounded =
          rXStart !== x_start || rYStart !== y_start || rXEnd !== x_end || rYEnd !== y_end;

        const { stderr } = await idb(
          "ui",
          "swipe",
          "--udid",
          actualUdid,
          ...(duration ? ["--duration", duration] : []),
          ...(delta ? ["--delta", String(delta)] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(rXStart),
          String(rYStart),
          String(rXEnd),
          String(rYEnd)
        );

        if (stderr) throw new Error(stderr);

        const message = `Swiped (${rXStart},${rYStart}) to (${rXEnd},${rYEnd})`;

        return {
          isError: false,
          content: [{ type: "text", text: message + aliasHint }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error swiping on the screen: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_scroll")) {
  server.tool(
    "ui_scroll",
    "Scroll the screen in a direction. Use instead of ui_swipe when you just want to scroll content. Provide x/y to target a specific scrollable area.",
    withAliases({
      direction: z
        .enum(["up", "down", "left", "right"])
        .describe(
          "Scroll direction: 'down' reveals content below, 'up' reveals content above"
        ),
      amount: z
        .coerce.number()
        .optional()
        .describe(
          "Scroll distance in points (default: 300). Smaller values for precise scrolling."
        ),
      x: z
        .coerce.number()
        .optional()
        .describe(
          "X-coordinate center of the scrollable area (default: screen center). Use to target a specific scroll view."
        ),
      y: z
        .coerce.number()
        .optional()
        .describe(
          "Y-coordinate center of the scrollable area (default: screen center). Use to target a specific scroll view."
        ),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
    }),
    { title: "Scroll Screen", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const direction = args.direction as string;
        const amount = (args.amount as number | undefined) ?? 300;
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);

        // Get screen dimensions
        const { stdout: describeOut } = await idb(
          "ui", "describe-all", "--udid", actualUdid, "--json", "--nested"
        );
        const uiData = JSON.parse(describeOut);
        const screenFrame = uiData[0]?.frame;
        const sw = screenFrame?.width ?? 390;
        const sh = screenFrame?.height ?? 844;
        const centerX = Math.round((args.x as number | undefined) ?? sw / 2);
        const centerY = Math.round((args.y as number | undefined) ?? sh / 2);

        let x_start: number, y_start: number, x_end: number, y_end: number;

        switch (direction) {
          case "down": // finger moves up to scroll content down
            x_start = centerX; y_start = Math.round(centerY + amount / 2);
            x_end = centerX; y_end = Math.round(centerY - amount / 2);
            break;
          case "up": // finger moves down to scroll content up
            x_start = centerX; y_start = Math.round(centerY - amount / 2);
            x_end = centerX; y_end = Math.round(centerY + amount / 2);
            break;
          case "left": // finger moves right to scroll content left
            x_start = Math.round(centerX + amount / 2); y_start = centerY;
            x_end = Math.round(centerX - amount / 2); y_end = centerY;
            break;
          case "right": // finger moves left to scroll content right
            x_start = Math.round(centerX - amount / 2); y_start = centerY;
            x_end = Math.round(centerX + amount / 2); y_end = centerY;
            break;
          default:
            throw new Error(`Invalid direction: ${direction}`);
        }

        const { stderr } = await idb(
          "ui", "swipe", "--udid", actualUdid,
          "--duration", "0.5",
          "--json", "--",
          String(x_start), String(y_start),
          String(x_end), String(y_end)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: `Scrolled ${direction}` + aliasHint }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error scrolling: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_point")) {
  server.tool(
    "ui_describe_point",
    "Get the accessibility element at (x, y). Use to identify what's at a specific coordinate.",
    withAliases({
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x: z.coerce.number().describe("The x-coordinate"),
      y: z.coerce.number().describe("The y-coordinate"),
    }),
    { title: "Describe UI Point", readOnlyHint: true, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const x = args.x as number;
        const y = args.y as number;
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);

        const roundedX = Math.round(x);
        const roundedY = Math.round(y);

        const { stdout, stderr } = await idb(
          "ui",
          "describe-point",
          "--udid",
          actualUdid,
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(roundedX),
          String(roundedY)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: stdout + aliasHint }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing point: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

const SCREENSHOT_TIMEOUT_MS = 10_000;

/**
 * Attempts to capture a screenshot with a timeout.
 * Returns the base64 JPEG string on success, or null if it fails/times out.
 */
async function tryCapture(
  udid: string,
  screenFrame?: { width: number; height: number }
): Promise<string | null> {
  try {
    const result = await Promise.race([
      captureCompressedScreenshot(udid, screenFrame),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), SCREENSHOT_TIMEOUT_MS)
      ),
    ]);
    return result;
  } catch {
    return null;
  }
}

/**
 * Captures a compressed screenshot of the simulator and returns it as a base64 JPEG.
 * If screenFrame is provided, uses those dimensions; otherwise fetches them via describe-all.
 */
async function captureCompressedScreenshot(
  udid: string,
  screenFrame?: { width: number; height: number }
): Promise<string> {
  let pointWidth: number;
  let pointHeight: number;

  if (screenFrame) {
    pointWidth = screenFrame.width;
    pointHeight = screenFrame.height;
  } else {
    const { stdout: uiDescribeOutput } = await idb(
      "ui",
      "describe-all",
      "--udid",
      udid,
      "--json",
      "--nested"
    );
    const uiData = JSON.parse(uiDescribeOutput);
    const frame = uiData[0]?.frame;
    if (!frame) {
      throw new Error("Could not determine screen dimensions");
    }
    pointWidth = frame.width;
    pointHeight = frame.height;
  }

  const ts = Date.now();
  const rawPng = path.join(TMP_ROOT_DIR, `ui-view-${ts}-raw.png`);
  const compressedJpg = path.join(TMP_ROOT_DIR, `ui-view-${ts}-compressed.jpg`);

  try {
    await run("xcrun", [
      "simctl",
      "io",
      udid,
      "screenshot",
      "--type=png",
      "--",
      rawPng,
    ]);

    await run("sips", [
      "-z",
      String(pointHeight),
      String(pointWidth),
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "80",
      rawPng,
      "--out",
      compressedJpg,
    ]);

    const imageData = fs.readFileSync(compressedJpg);
    return imageData.toString("base64");
  } finally {
    try { fs.unlinkSync(rawPng); } catch {}
    try { fs.unlinkSync(compressedJpg); } catch {}
  }
}

if (!isToolFiltered("ui_view")) {
  server.tool(
    "ui_view",
    "Get a screenshot only (no accessibility tree). Use ui_describe_all if you also need element info.",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
    },
    { title: "View Screenshot", readOnlyHint: true, openWorldHint: true },
    async ({ udid }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);
        const base64Data = await captureCompressedScreenshot(actualUdid);

        return {
          isError: false,
          content: [
            {
              type: "image",
              data: base64Data,
              mimeType: "image/jpeg",
            },
            {
              type: "text",
              text: "Screenshot",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error capturing screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

function ensureAbsolutePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Handle ~/something paths in the provided filePath
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  // Determine the default directory from env var or fallback to ~/Downloads
  let defaultDir = path.join(os.homedir(), "Downloads");
  const customDefaultDir = process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR;

  if (customDefaultDir) {
    // also expand tilde for the custom directory path
    if (customDefaultDir.startsWith("~/")) {
      defaultDir = path.join(os.homedir(), customDefaultDir.slice(2));
    } else {
      defaultDir = customDefaultDir;
    }
  }

  // Join the relative filePath with the resolved default directory
  return path.join(defaultDir, filePath);
}

if (!isToolFiltered("screenshot")) {
  server.tool(
    "screenshot",
    "Takes a screenshot of the iOS Simulator, saved to 'output_path'",
    withAliases({
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      output_path: z
        .string()
        .max(1024)
        .describe(
          "File path where the screenshot will be saved. If relative, it uses the directory specified by the `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` env var, or `~/Downloads` if not set."
        ),
      type: z
        .enum(["png", "tiff", "bmp", "gif", "jpeg"])
        .optional()
        .describe(
          "Image format (png, tiff, bmp, gif, or jpeg). Default is png."
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          "Display to capture (internal or external). Default depends on device type."
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          "For non-rectangular displays, handle the mask by policy (ignored, alpha, or black)"
        ),
    }),
    { title: "Take Screenshot", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const output_path = args.output_path as string;
        const type = args.type as "png" | "tiff" | "bmp" | "gif" | "jpeg" | undefined;
        const display = args.display as "internal" | "external" | undefined;
        const mask = args.mask as "ignored" | "alpha" | "black" | undefined;
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);
        const absolutePath = ensureAbsolutePath(output_path);

        // command is weird, it responds with stderr on success and stdout is blank
        const { stderr: stdout } = await run("xcrun", [
          "simctl",
          "io",
          actualUdid,
          "screenshot",
          ...(type ? [`--type=${type}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          absolutePath,
        ]);

        // throw if we don't get the expected success message
        if (stdout && !stdout.includes("Wrote screenshot to")) {
          throw new Error(stdout);
        }

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: stdout + aliasHint,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error taking screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("record_video")) {
  server.tool(
    "record_video",
    "Records a video of the iOS Simulator, optionally saved to 'output_path'",
    withAliases({
      output_path: z
        .string()
        .max(1024)
        .optional()
        .describe(
          `Optional output path. If not provided, a default name will be used. The file will be saved in the directory specified by \`IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR\` or in \`~/Downloads\` if the environment variable is not set.`
        ),
      codec: z
        .enum(["h264", "hevc"])
        .optional()
        .describe(
          'Specifies the codec type: "h264" or "hevc". Default is "hevc".'
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          'Display to capture: "internal" or "external". Default depends on device type.'
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          'For non-rectangular displays, handle the mask by policy: "ignored", "alpha", or "black".'
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Force the output file to be written to, even if the file already exists."
        ),
    }),
    { title: "Record Video", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const output_path = args.output_path as string | undefined;
        const codec = args.codec as "h264" | "hevc" | undefined;
        const display = args.display as "internal" | "external" | undefined;
        const mask = args.mask as "ignored" | "alpha" | "black" | undefined;
        const force = args.force as boolean | undefined;

        const defaultFileName = `simulator_recording_${Date.now()}.mp4`;
        const outputFile = ensureAbsolutePath(output_path ?? defaultFileName);

        // Start the recording process
        const recordingProcess = spawn("xcrun", [
          "simctl",
          "io",
          "booted",
          "recordVideo",
          ...(codec ? [`--codec=${codec}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          ...(force ? ["--force"] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          outputFile,
        ]);

        // Wait for recording to start
        await new Promise((resolve, reject) => {
          let errorOutput = "";

          recordingProcess.stderr.on("data", (data) => {
            const message = data.toString();
            if (message.includes("Recording started")) {
              resolve(true);
            } else {
              errorOutput += message;
            }
          });

          // Set timeout for start verification
          setTimeout(() => {
            if (recordingProcess.killed) {
              reject(new Error("Recording process terminated unexpectedly"));
            } else {
              resolve(true);
            }
          }, 3000);
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Recording to ${outputFile}. Use stop_recording to finish.` + aliasHint,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error starting recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("stop_recording")) {
  server.tool(
    "stop_recording",
    "Stops the simulator video recording using killall",
    {},
    { title: "Stop Recording", readOnlyHint: false, openWorldHint: true },
    async () => {
      try {
        await run("pkill", ["-SIGINT", "-f", "simctl.*recordVideo"]);

        // Wait a moment for the video to finalize
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "Recording stopped",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error stopping recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("install_app")) {
  server.tool(
    "install_app",
    "Installs an app bundle at 'app_path' (.app or .ipa) on the iOS Simulator",
    withAliases({
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      app_path: z
        .string()
        .max(1024)
        .describe(
          "Path to the app bundle (.app directory or .ipa file) to install"
        ),
    }),
    { title: "Install App", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const app_path = args.app_path as string;
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);
        const absolutePath = path.isAbsolute(app_path)
          ? app_path
          : path.resolve(app_path);

        // Check if the app bundle exists
        if (!fs.existsSync(absolutePath)) {
          throw new Error(`App bundle not found at: ${absolutePath}`);
        }

        // run() will throw if the command fails (non-zero exit code)
        await run("xcrun", ["simctl", "install", actualUdid, absolutePath]);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Installed ${absolutePath}` + aliasHint,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error installing app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("launch_app")) {
  server.tool(
    "launch_app",
    "Launches an app on the iOS Simulator by 'bundle_id' (e.g., com.apple.mobilesafari)",
    withAliases({
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      bundle_id: z
        .string()
        .max(256)
        .describe(
          "Bundle identifier of the app to launch (e.g., com.apple.mobilesafari)"
        ),
      terminate_running: z
        .boolean()
        .optional()
        .describe(
          "Terminate the app if it is already running before launching"
        ),
    }),
    { title: "Launch App", readOnlyHint: false, openWorldHint: true },
    async (rawArgs) => {
      try {
        const { resolved: args, aliasHint } = resolveAliases(rawArgs as Record<string, unknown>);
        const bundle_id = args.bundle_id as string;
        const terminate_running = args.terminate_running as boolean | undefined;
        const actualUdid = await getBootedDeviceId(args.udid as string | undefined);

        // run() will throw if the command fails (non-zero exit code)
        const { stdout } = await run("xcrun", [
          "simctl",
          "launch",
          ...(terminate_running ? ["--terminate-running-process"] : []),
          actualUdid,
          bundle_id,
        ]);

        // Extract PID from output if available
        // simctl launch outputs the PID as the first token in stdout
        const pidMatch = stdout.match(/^(\d+)/);
        const pid = pidMatch ? pidMatch[1] : null;

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: (pid
                ? `Launched ${bundle_id} (PID ${pid})`
                : `Launched ${bundle_id}`) + aliasHint,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error launching app: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);

process.stdin.on("close", () => {
  console.log("iOS Simulator MCP Server closed");
  server.close();
  try {
    fs.rmSync(TMP_ROOT_DIR, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
});
