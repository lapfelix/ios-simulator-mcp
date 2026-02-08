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
 * Runs the idb command with the given arguments
 * @param args - arguments to pass to the idb command
 * @returns The stdout and stderr of the command
 * @see https://fbidb.io/docs/commands for documentation of available idb commands
 */
async function idb(...args: string[]) {
  try {
    return await run(getIdbPath(), args);
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
              text: "Simulator.app opened successfully",
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
    "Describes accessibility information for the entire screen in the iOS Simulator",
    {
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
    },
    { title: "Describe All UI Elements", readOnlyHint: true, openWorldHint: true },
    async ({ udid, compression }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stdout } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        const mode = compression ?? DEFAULT_UI_COMPRESSION_MODE;
        if (mode === "raw") {
          return {
            isError: false,
            content: [{ type: "text", text: stdout }],
          };
        }

        const uiData = JSON.parse(stdout);
        const compressed = compressUiTree(uiData, mode);

        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(compressed) }],
        };
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
    "Describes accessibility info for elements whose labels match a search term, returning only matching elements and their parents",
    {
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
    },
    { title: "Search UI Elements", readOnlyHint: true, openWorldHint: true },
    async ({ term, udid, compression }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stdout } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        const uiData = JSON.parse(stdout);
        const filtered = filterUiTree(uiData, term);
        const mode = compression ?? DEFAULT_UI_COMPRESSION_MODE;

        if (mode === "raw") {
          return {
            isError: false,
            content: [{ type: "text", text: JSON.stringify(filtered) }],
          };
        }

        const compressed = compressUiTree(filtered, mode);

        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(compressed) }],
        };
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
    "Tap on the screen in the iOS Simulator",
    {
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Press duration"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The x-coordinate"),
    },
    { title: "UI Tap", readOnlyHint: false, openWorldHint: true },
    async ({ duration, udid, x, y }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

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
          String(x),
          String(y)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Tapped successfully" }],
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
    "Search accessibility labels and tap the only matching element",
    {
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
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Press duration"),
    },
    { title: "Search And Tap", readOnlyHint: false, openWorldHint: true },
    async ({ term, udid, duration }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stdout } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        const uiData = JSON.parse(stdout);
        const matches = collectMatchingNodes(uiData, term);

        if (matches.length === 0) {
          throw new Error(`No matching elements found for "${term}".`);
        }

        if (matches.length > 1) {
          const labels = matches
            .slice(0, 5)
            .map((node) => getNodeLabel(node))
            .join(", ");
          throw new Error(
            labels.length > 0
              ? `Multiple matching elements found for "${term}": ${labels}`
              : `Multiple matching elements found for "${term}".`
          );
        }

        const target = matches[0];
        const center = getNodeFrameCenter(target);
        if (!center) {
          throw new Error(
            `Matched element "${getNodeLabel(target)}" does not have a valid frame.`
          );
        }

        const tapX = roundToDecimals(center.x, 1);
        const tapY = roundToDecimals(center.y, 1);

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
              text: `Tapped "${getNodeLabel(target)}" at (${tapX}, ${tapY})`,
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
                `Error searching and tapping "${term}": ${toError(error).message}`
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
    "Input text into the iOS Simulator",
    {
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
    },
    { title: "UI Type", readOnlyHint: false, openWorldHint: true },
    async ({ udid, text }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

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
          content: [{ type: "text", text: "Typed successfully" }],
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
    "Find a text input field by label/accessibility text, focus it, and type into it in the iOS Simulator",
    {
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
    },
    { title: "UI Type In Field", readOnlyHint: false, openWorldHint: true },
    async ({ udid, field_query, text }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

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

        const tapX = roundToDecimals(center.x, 1);
        const tapY = roundToDecimals(center.y, 1);

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
              text: `Typed successfully into "${getNodeLabel(
                target
              )}" at (${tapX}, ${tapY})`,
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
                `Error typing into text field "${field_query}": ${
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

if (!isToolFiltered("ui_swipe")) {
  server.tool(
    "ui_swipe",
    "Swipe on the screen in the iOS Simulator",
    {
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Swipe duration in seconds (e.g., 0.1)"),
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x_start: z.number().describe("The starting x-coordinate"),
      y_start: z.number().describe("The starting y-coordinate"),
      x_end: z.number().describe("The ending x-coordinate"),
      y_end: z.number().describe("The ending y-coordinate"),
      delta: z
        .number()
        .optional()
        .describe("The size of each step in the swipe (default is 1)")
        .default(1),
    },
    { title: "UI Swipe", readOnlyHint: false, openWorldHint: true },
    async ({ duration, udid, x_start, y_start, x_end, y_end, delta }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

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
          String(x_start),
          String(y_start),
          String(x_end),
          String(y_end)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Swiped successfully" }],
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

if (!isToolFiltered("ui_describe_point")) {
  server.tool(
    "ui_describe_point",
    "Returns the accessibility element at given co-ordinates on the iOS Simulator's screen",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target, can also be set with the IDB_UDID env var"),
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The y-coordinate"),
    },
    { title: "Describe UI Point", readOnlyHint: true, openWorldHint: true },
    async ({ udid, x, y }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

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
          String(x),
          String(y)
        );

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: stdout }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing point (${x}, ${y}): ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_view")) {
  server.tool(
    "ui_view",
    "Get the image content of a compressed screenshot of the current simulator view",
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

        // Get screen dimensions in points from ui_describe_all
        const { stdout: uiDescribeOutput } = await idb(
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested"
        );

        const uiData = JSON.parse(uiDescribeOutput);
        const screenFrame = uiData[0]?.frame;
        if (!screenFrame) {
          throw new Error("Could not determine screen dimensions");
        }

        const pointWidth = screenFrame.width;
        const pointHeight = screenFrame.height;

        // Generate unique file names with timestamp
        const ts = Date.now();
        const rawPng = path.join(TMP_ROOT_DIR, `ui-view-${ts}-raw.png`);
        const compressedJpg = path.join(
          TMP_ROOT_DIR,
          `ui-view-${ts}-compressed.jpg`
        );

        // Capture screenshot as PNG
        await run("xcrun", [
          "simctl",
          "io",
          actualUdid,
          "screenshot",
          "--type=png",
          "--",
          rawPng,
        ]);

        // Resize to match point dimensions and compress to JPEG using sips
        await run("sips", [
          "-z",
          String(pointHeight), // height in points
          String(pointWidth), // width in points
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "80", // 80% quality
          rawPng,
          "--out",
          compressedJpg,
        ]);

        // Read and encode the compressed image
        const imageData = fs.readFileSync(compressedJpg);
        const base64Data = imageData.toString("base64");

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
              text: "Screenshot captured",
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
    "Takes a screenshot of the iOS Simulator",
    {
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
    },
    { title: "Take Screenshot", readOnlyHint: false, openWorldHint: true },
    async ({ udid, output_path, type, display, mask }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);
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
              text: stdout,
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
    "Records a video of the iOS Simulator using simctl directly",
    {
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
    },
    { title: "Record Video", readOnlyHint: false, openWorldHint: true },
    async ({ output_path, codec, display, mask, force }) => {
      try {
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
              text: `Recording started. The video will be saved to: ${outputFile}\nTo stop recording, use the stop_recording command.`,
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
              text: "Recording stopped successfully.",
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
    "Installs an app bundle (.app or .ipa) on the iOS Simulator",
    {
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
    },
    { title: "Install App", readOnlyHint: false, openWorldHint: true },
    async ({ udid, app_path }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);
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
              text: `App installed successfully from: ${absolutePath}`,
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
    "Launches an app on the iOS Simulator by bundle identifier",
    {
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
    },
    { title: "Launch App", readOnlyHint: false, openWorldHint: true },
    async ({ udid, bundle_id, terminate_running }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

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
              text: pid
                ? `App ${bundle_id} launched successfully with PID: ${pid}`
                : `App ${bundle_id} launched successfully`,
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
