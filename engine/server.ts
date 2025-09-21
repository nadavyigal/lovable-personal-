/// <reference path="./cors.d.ts" />
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { z } from "zod";
import dotenv from "dotenv";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envLocal = path.join(__dirname, ".env.local");
const envDefault = path.join(__dirname, ".env");
let ENV_SOURCE = "process-env-only";
if (fs.existsSync(envLocal)) {
  dotenv.config({ path: envLocal, override: true });
  ENV_SOURCE = ".env.local";
} else if (fs.existsSync(envDefault)) {
  dotenv.config({ path: envDefault, override: true });
  ENV_SOURCE = ".env";
} else {
  dotenv.config({ override: false });
  ENV_SOURCE = "process-env-only";
}
console.log("[engine] env loaded from:", ENV_SOURCE);
const OPENAI_KEY_PRESENT = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
if (!OPENAI_KEY_PRESENT) {
  console.warn("[engine] OPENAI_API_KEY not set");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Hard safety and configuration
const WORKSPACE = path.resolve(path.join(__dirname, "..", "workspace"));
const ALLOW_LISTED_DOMAINS = new Set([
  "raw.githubusercontent.com",
  "images.unsplash.com",
]);
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

// -----------------------------
// Feature flags
// -----------------------------
const ENABLE_DOWNLOAD = false;
const ENABLE_DEPS = false;
const ENABLE_DELETE = false;

function isPathInside(childPath: string, parentPath: string): boolean {
  const resolvedChild = path.resolve(childPath) + path.sep;
  const resolvedParent = path.resolve(parentPath) + path.sep;
  return resolvedChild.startsWith(resolvedParent);
}

// Blocks traversal and ensures path is within WORKSPACE
function safeJoin(base: string, ...segments: string[]): string {
  for (const seg of segments) {
    if (seg.includes("..")) {
      throw new Error("Path traversal blocked");
    }
  }
  const joined = path.join(base, ...segments);
  if (!isPathInside(joined, base)) {
    throw new Error("Path escapes workspace");
  }
  return joined;
}

// Normalize incoming file paths to be workspace-relative without leading separators or "workspace/" prefix
function normalizeWorkspaceRel(p: string): string {
  if (typeof p !== "string") throw new Error("file_path must be a string");
  let rel = p.replace(/^[\\/]+/, "").replace(/\\/g, "/");
  if (rel.toLowerCase().startsWith("workspace/")) rel = rel.slice("workspace/".length);
  return rel;
}

// Simple bounded fetch helper for remote resources (allow-listed only)
async function boundedDownload(url: string): Promise<Buffer> {
  const u = new URL(url);
  if (!ALLOW_LISTED_DOMAINS.has(u.host)) {
    throw new Error("Domain not allow-listed");
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download: ${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new Error("Download exceeds 5MB limit");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

// System prompt (loaded from file to preserve verbatim formatting including backticks)
const SYSTEM_PROMPT_PATH = path.join(__dirname, "system_prompt.txt");
const SYSTEM_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
console.log("system prompt loaded");

const ChatMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
});

const ChatRequest = z.object({
  messages: z.array(ChatMessage).min(1),
});

// -----------------------------
// OpenAI Tool Definitions (exact names and params)
// -----------------------------
const OPENAI_TOOLS: any[] = [
  {
    type: "function",
    function: {
      name: "lov-view",
      description:
        "Use this tool to read the contents of a file. If it's a project file, the file path should be relative to the project root. You can optionally specify line ranges to read using the lines parameter (e.g., \"1-800, 1001-1500\"). By default, the first 500 lines are read if lines is not specified.\n\nIMPORTANT GUIDELINES:\n- Do NOT use this tool if the file contents have already been provided in \n- Do NOT specify line ranges unless the file is very large (>500 lines) - rely on the default behavior which shows the first 500 lines\n- Only use line ranges when you need to see specific sections of large files that weren't shown in the default view\n- If you need to read multiple files, invoke this tool multiple times in parallel (not sequentially) for efficiency",
      parameters: {
        properties: {
          file_path: { example: "src/App.tsx", type: "string" },
          lines: { example: "1-800, 1001-1500", type: "string" },
        },
        required: ["file_path"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lov-search-files",
      description:
        "Regex-based code search with file filtering and context.\n\nSearch using regex patterns across files in your project.\n\nParameters:\n- query: Regex pattern to find (e.g., \"useState\")\n- include_pattern: Files to include using glob syntax (e.g., \"src/**\")\n- exclude_pattern: Files to exclude using glob syntax (e.g., \"**/*.test.tsx\")\n- case_sensitive: Whether to match case (default: false)\n\nTip: Use \\\\ to escape special characters in regex patterns.",
      parameters: {
        properties: {
          case_sensitive: { example: "false", type: "boolean" },
          exclude_pattern: { example: "src/components/ui/**", type: "string" },
          include_pattern: { example: "src/**", type: "string" },
          query: { example: "useEffect\\(", type: "string" },
        },
        required: ["query", "include_pattern"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lov-read-console-logs",
      description:
        "Use this tool to read the contents of the latest console logs at the moment the user sent the request.\nYou can optionally provide a search query to filter the logs. If empty you will get all latest logs.\nYou may not be able to see the logs that didn't happen recently.\nThe logs will not update while you are building and writing code. So do not expect to be able to verify if you fixed an issue by reading logs again. They will be the same as when you started writing code.\nDO NOT USE THIS MORE THAN ONCE since you will get the same logs each time.",
      parameters: {
        properties: {
          search: { example: "error", type: "string" },
        },
        required: ["search"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lov-read-network-requests",
      description:
        "Use this tool to read the contents of the latest network requests. You can optionally provide a search query to filter the requests. If empty you will get all latest requests. You may not be able to see the requests that didn't happen recently.",
      parameters: {
        properties: {
          search: { example: "error", type: "string" },
        },
        required: ["search"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lov-line-replace",
      description:
        "Line-Based Search and Replace Tool\n\nUse this tool to find and replace specific content in a file you have access to, using explicit line numbers. This is the PREFERRED and PRIMARY tool for editing existing files. Always use this tool when modifying existing code rather than rewriting entire files.\n\nProvide the following details to make an edit:\n\t1.\tfile_path - The path of the file to modify\n\t2.\tsearch - The content to search for (use ellipsis ... for large sections instead of writing them out in full)\n\t3.\tfirst_replaced_line - The line number of the first line in the search (1-indexed)\n\t4.\tlast_replaced_line - The line number of the last line in the search (1-indexed)\n\t5.\treplace - The new content to replace the found content\n\nThe tool will validate that search matches the content at the specified line range and then replace it with replace.\n\nIMPORTANT: When invoking this tool multiple times in parallel (multiple edits to the same file), always use the original line numbers from the file as you initially viewed it. Do not adjust line numbers based on previous edits.\n\nELLIPSIS USAGE:\nWhen replacing sections of code longer than ~6 lines, you should use ellipsis (...) in your search to reduce the number of lines you need to specify (writing fewer lines is faster).\n- Include the first few lines (typically 2-3 lines) of the section you want to replace\n- Add \"...\" on its own line to indicate omitted content\n- Include the last few lines (typically 2-3 lines) of the section you want to replace\n- The key is to provide enough unique context at the beginning and end to ensure accurate matching\n- Focus on uniqueness rather than exact line counts - sometimes 2 lines is enough, sometimes you need 4\n\n\n\nExample:\nTo replace a user card component at lines 22-42:\n\nOriginal content in file (lines 20-45):\n20:   return (\n21:     \n22:       \n23:         \n24:         {user.name}\n25:         {user.email}\n26:         {user.role}\n27:         {user.department}\n28:         {user.location}\n29:         \n30:            onEdit(user.id)}>Edit\n31:            onDelete(user.id)}>Delete\n32:            onView(user.id)}>View\n33:         \n34:         \n35:           Created: {user.createdAt}\n36:           Updated: {user.updatedAt}\n37:           Status: {user.status}\n38:         \n39:         \n40:           Permissions: {user.permissions.join(', ')}\n41:         \n42:       \n43:     \n44:   );\n45: }\n\nFor a large replacement like this, you must use ellipsis:\n- search: \"      \\n        \\n...\\n          Permissions: {user.permissions.join(', ')}\\n        \\n      \"\n- first_replaced_line: 22\n- last_replaced_line: 42\n- replace: \"      \\n        \\n           {\\n              e.currentTarget.src = '/default-avatar.png';\\n            }}\\n          />\\n        \\n        \\n          {user.name}\\n          {user.email}\\n          \\n            {user.role}\\n            {user.department}\\n          \\n        \\n        \\n           onEdit(user.id)}\\n            aria-label=\\\"Edit user profile\\\"\\n          >\\n            Edit Profile\\n          \\n        \\n      \"\n\nCritical guidelines:\n\t1. Line Numbers - Specify exact first_replaced_line and last_replaced_line (1-indexed, first line is line 1)\n\t2. Ellipsis Usage - For large sections (>6 lines), use ellipsis (...) to include only the first few and last few key identifying lines for cleaner, more focused matching\n\t3. Content Validation - The prefix and suffix parts of search (before and after ellipsis) must contain exact content matches from the file (without line numbers). The tool validates these parts against the actual file content\n\t4. File Validation - The file must exist and be readable\n\t5. Parallel Tool Calls - When multiple edits are needed, invoke necessary tools simultaneously in parallel. Do NOT wait for one edit to complete before starting the next\n\t6. Original Line Numbers - When making multiple edits to the same file, always use original line numbers from your initial view of the file",
      parameters: {
        properties: {
          file_path: { example: "src/components/TaskList.tsx", type: "string" },
          first_replaced_line: { description: "First line number to replace (1-indexed)", example: "15", type: "number" },
          last_replaced_line: { description: "Last line number to replace (1-indexed)", example: "28", type: "number" },
          replace: { description: "New content to replace the search content with (without line numbers)", example: "  const handleTaskComplete = useCallback((taskId: string) => {\n    const updatedTasks = tasks.map(task =>\n      task.id === taskId \n        ? { ...task, completed: !task.completed, completedAt: new Date() }\n        : task\n    );\n    setTasks(updatedTasks);\n    onTaskUpdate?.(updatedTasks);\n    \n    // Analytics tracking\n    analytics.track('task_completed', { taskId, timestamp: Date.now() });\n  }, [tasks, onTaskUpdate]);", type: "string" },
          search: { description: "Content to search for in the file (without line numbers). This should match the existing code that will be replaced.", example: "  const handleTaskComplete = (taskId: string) => {\n    setTasks(tasks.map(task =>\n...\n    ));\n    onTaskUpdate?.(updatedTasks);\n  };", type: "string" },
        },
        required: ["file_path", "search", "first_replaced_line", "last_replaced_line", "replace"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lov-write",
      description:
        "\nUse this tool to write to a file. Overwrites the existing file if there is one. The file path should be relative to the project root.\n\n  ### IMPORTANT: MINIMIZE CODE WRITING\n  - PREFER using lov-line-replace for most changes instead of rewriting entire files\n  - This tool is mainly meant for creating new files or as fallback if lov-line-replace fails\n  - When writing is necessary, MAXIMIZE use of \"// ... keep existing code\" to maintain unmodified sections\n  - ONLY write the specific sections that need to change - be as lazy as possible with your writes\n  \n  ### Using \"keep existing code\" (MANDATORY for large unchanged sections):\n  - Any unchanged code block over 5 lines MUST use \"// ... keep existing code\" comment\n  - The comment MUST contain the EXACT string \"... keep existing code\" \n  - Example: \"// ... keep existing code (user interface components)\"\n  - NEVER rewrite large sections of code that don't need to change\n  \n  Example with proper use of keep existing code:\n  ```\n  import React from 'react';\n  import './App.css';\n  \n  function App() {\n    // ... keep existing code (all UI components)\n    \n    // Only the new footer is being added\n    const Footer = () => (\n      New Footer Component\n    );\n    \n    return (\n      \n        // ... keep existing code (main content)\n        \n      \n    );\n  }\n  \n  export default App;\n  ```\n\n  ### Parallel Tool Usage\n  - If you need to create multiple files, it is very important that you create all of them at once instead of one by one, because it's much faster\n",
      parameters: {
        properties: {
          content: { example: "console.log('Hello, World!')", type: "string" },
          file_path: { example: "src/main.ts", type: "string" },
        },
        required: ["file_path", "content"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lov-rename",
      description:
        "You MUST use this tool to rename a file instead of creating new files and deleting old ones. The original and new file path should be relative to the project root.",
      parameters: {
        properties: {
          new_file_path: { example: "src/main_new2.ts", type: "string" },
          original_file_path: { example: "src/main.ts", type: "string" },
        },
        required: ["original_file_path", "new_file_path"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lov-delete",
      description:
        "Use this tool to delete a file. The file path should be relative to the project root.",
      parameters: {
        properties: {
          file_path: { example: "src/App.tsx", type: "string" },
        },
        required: ["file_path"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lov-download-to-repo",
      description:
        "Download a remote file (allow-listed domains only, max 5MB) and save it under workspace/public or workspace/src/assets.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", example: "https://raw.githubusercontent.com/user/repo/main/logo.png" },
          save_path: { type: "string", example: "public/images/logo.png" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lov-add-dependency",
      description:
        "Add one or more pinned dependencies (e.g., react@18.3.1). Blocked when dependency management is disabled.",
      parameters: {
        type: "object",
        properties: {
          packages: { type: "array", items: { type: "string" }, example: ["react@18.3.1"] },
          dev: { type: "boolean", example: false },
          workspace: { type: "string", example: "workspace" },
        },
        required: ["packages"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lov-remove-dependency",
      description:
        "Remove one or more dependencies by name. Blocked when dependency management is disabled.",
      parameters: {
        type: "object",
        properties: {
          packages: { type: "array", items: { type: "string" }, example: ["react"] },
          dev: { type: "boolean", example: false },
          workspace: { type: "string", example: "workspace" },
        },
        required: ["packages"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stripe--enable_stripe",
      description: "Enable Stripe integration (stub - returns not enabled).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// -----------------------------
// Tool Handlers
// -----------------------------
function parseLineRanges(input: string): Array<[number, number]> {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((range) => {
      const [startStr, endStr] = range.split("-").map((t) => t.trim());
      const start = Math.max(1, parseInt(startStr, 10));
      const end = Math.max(start, parseInt(endStr, 10));
      if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new Error("Invalid lines range format");
      }
      return [start, end] as [number, number];
    });
}

function globToRegExp(glob: string): RegExp {
  // Convert simple glob to regex: supports **, *, ? and path separators
  const escaped = glob
    .replace(/[.+^${}()|\[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*?/)?") // **/ -> any nested path
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$");
}

function walkWorkspaceFiles(): string[] {
  const results: string[] = [];
  const stack: string[] = [WORKSPACE];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  return results;
}

function isForbiddenPath(absPath: string): string | null {
  const rel = path.relative(WORKSPACE, absPath);
  if (rel.startsWith("..")) return "Path escapes workspace";
  const parts = rel.split(path.sep);
  if (parts.includes("node_modules")) return "Operation not allowed in node_modules";
  if (parts.includes(".git")) return "Operation not allowed in .git";
  const base = path.basename(absPath);
  if (base.startsWith(".env")) return "Operation not allowed on .env files";
  return null;
}

const toolHandlers: Record<string, (args: any) => Promise<string>> = {
  "lov-view": async ({ file_path, lines }: { file_path: string; lines?: string }) => {
    try {
      const rel = normalizeWorkspaceRel(file_path);
      const abs = safeJoin(WORKSPACE, rel);
      if (!fs.existsSync(abs)) return JSON.stringify({ error: "File not found. Use paths relative to workspace root, e.g. 'src/App.tsx' (no 'workspace/' prefix).", file: rel });
      const raw = fs.readFileSync(abs, "utf-8");
      const allLines = raw.split(/\r?\n/);
      let output = "";
      if (lines && lines.trim().length > 0) {
        const ranges = parseLineRanges(lines);
        const chunks: string[] = [];
        for (const [start, end] of ranges) {
          const slice = allLines.slice(start - 1, end).join("\n");
          chunks.push(slice);
        }
        output = chunks.join("\n");
      } else {
        output = allLines.slice(0, Math.min(500, allLines.length)).join("\n");
      }
      if (output.length > 20000) {
        output = output.slice(0, 20000);
      }
      return output;
    } catch (e: any) {
      return JSON.stringify({ error: String(e?.message || e) });
    }
  },
  "lov-search-files": async ({
    query,
    include_pattern,
    exclude_pattern,
    case_sensitive,
  }: {
    query: string;
    include_pattern: string;
    exclude_pattern?: string;
    case_sensitive?: boolean;
  }) => {
    try {
      const includeRe = globToRegExp(include_pattern);
      const excludeRe = exclude_pattern ? globToRegExp(exclude_pattern) : null;
      const flags = case_sensitive ? "g" : "gi";
      const re = new RegExp(query, flags);

      const files = walkWorkspaceFiles();
      const results: Array<{
        file_path: string;
        matches: Array<{ line: number; preview: string }>;
      }> = [];

      for (const full of files) {
        const rel = path.relative(WORKSPACE, full).replace(/\\\\/g, "/");
        if (!includeRe.test(rel)) continue;
        if (excludeRe && excludeRe.test(rel)) continue;

        const content = fs.readFileSync(full, "utf-8");
        const lines = content.split(/\r?\n/);
        const fileMatches: Array<{ line: number; preview: string }> = [];

        for (let i = 0; i < lines.length && fileMatches.length < 3; i++) {
          if (re.test(lines[i])) {
            fileMatches.push({ line: i + 1, preview: lines[i].slice(0, 200) });
          }
          re.lastIndex = 0; // reset for next line scan
        }

        if (fileMatches.length > 0) {
          results.push({ file_path: rel, matches: fileMatches });
        }
      }
      return JSON.stringify(results);
    } catch (e: any) {
      return JSON.stringify({ error: String(e?.message || e) });
    }
  },
  "lov-read-console-logs": async (_args: { search?: string }) => {
    return JSON.stringify([]);
  },
  "lov-read-network-requests": async (_args: { search?: string }) => {
    return JSON.stringify([]);
  },
  "lov-line-replace": async ({
    file_path,
    search,
    first_replaced_line,
    last_replaced_line,
    replace,
  }: {
    file_path: string;
    search: string;
    first_replaced_line: number;
    last_replaced_line: number;
    replace: string;
  }) => {
    try {
      const rel = normalizeWorkspaceRel(file_path);
      const abs = safeJoin(WORKSPACE, rel);
      const forbidden = isForbiddenPath(abs);
      if (forbidden) return JSON.stringify({ status: "error", file: rel, note: forbidden });
      if (!fs.existsSync(abs)) return JSON.stringify({ status: "error", file: rel, note: "File not found. Use paths relative to workspace root, e.g. 'src/App.tsx' (no 'workspace/' prefix)." });
      const raw = fs.readFileSync(abs, "utf-8");
      const lines = raw.split(/\r?\n/);
      const start = Math.max(1, Number(first_replaced_line));
      const end = Math.max(start, Number(last_replaced_line));
      if (Number.isNaN(start) || Number.isNaN(end)) {
        return JSON.stringify({ status: "error", file: rel, note: "Invalid line numbers" });
      }
      if (start > lines.length) {
        return JSON.stringify({ status: "error", file: rel, note: "Start line beyond EOF" });
      }
      const targetBlock = lines.slice(start - 1, Math.min(end, lines.length)).join("\n");
      const searchNorm = search.replace(/\r\n/g, "\n");
      const ellipsisToken = "\n...\n";
      if (searchNorm.includes("...")) {
        // Validate prefix/suffix around ellipsis
        let idx = searchNorm.indexOf(ellipsisToken);
        if (idx === -1) {
          // try flexible: ellipsis on its own line without both leading/trailing newlines
          const parts = searchNorm.split(/\n\.\.\.\n/);
          if (parts.length !== 2) {
            return JSON.stringify({ status: "error", file: rel, note: "Ellipsis must be on its own line" });
          }
          const [prefix, suffix] = parts;
          if (!targetBlock.startsWith(prefix) || !targetBlock.endsWith(suffix)) {
            return JSON.stringify({ status: "error", file: rel, note: "Prefix/suffix do not match target lines" });
          }
        } else {
          const prefix = searchNorm.slice(0, idx);
          const suffix = searchNorm.slice(idx + ellipsisToken.length);
          if (!targetBlock.startsWith(prefix) || !targetBlock.endsWith(suffix)) {
            return JSON.stringify({ status: "error", file: rel, note: "Prefix/suffix do not match target lines" });
          }
        }
      } else {
        if (targetBlock !== searchNorm) {
          return JSON.stringify({ status: "error", file: rel, note: "Search content mismatch in specified range" });
        }
      }

      // Backup
      try { fs.copyFileSync(abs, abs + ".bak"); } catch {}

      const replaceLines = replace.replace(/\r\n/g, "\n").split("\n");
      const newLines = [
        ...lines.slice(0, start - 1),
        ...replaceLines,
        ...lines.slice(end),
      ];
      fs.writeFileSync(abs, newLines.join("\n"), "utf-8");
      const newEnd = (start - 1) + replaceLines.length;
      return JSON.stringify({ status: "ok", file: rel, start, end: newEnd });
    } catch (e: any) {
      return JSON.stringify({ status: "error", file: String((file_path && normalizeWorkspaceRel(String(file_path))) || ""), note: String(e?.message || e) });
    }
  },
  "lov-write": async ({ file_path, content }: { file_path: string; content: string }) => {
    try {
      const rel = normalizeWorkspaceRel(file_path);
      if (typeof content !== "string") return JSON.stringify({ status: "error", file: rel, note: "Invalid content" });
      if (Buffer.byteLength(content, "utf-8") > 200 * 1024) {
        return JSON.stringify({ status: "error", file: rel, note: "Content exceeds 200KB; use lov-line-replace" });
      }
      const abs = safeJoin(WORKSPACE, rel);
      const forbidden = isForbiddenPath(abs);
      if (forbidden) return JSON.stringify({ status: "error", file: rel, note: forbidden });

      const exists = fs.existsSync(abs);
      if (exists) {
        const prev = fs.readFileSync(abs, "utf-8");
        const prevLines = prev.split(/\r?\n/);
        const newLines = content.replace(/\r\n/g, "\n").split("\n");
        // naive changed-lines count
        const maxLen = Math.max(prevLines.length, newLines.length);
        let changed = 0;
        for (let i = 0; i < maxLen; i++) {
          const a = prevLines[i] ?? "";
          const b = newLines[i] ?? "";
          if (a !== b) changed++;
          if (changed > 400) break;
        }
        if (changed > 400) {
          return JSON.stringify({ status: "error", file: rel, note: "Change exceeds 400 lines; use lov-line-replace" });
        }
        try { fs.copyFileSync(abs, abs + ".bak"); } catch {}
        fs.writeFileSync(abs, newLines.join("\n"), "utf-8");
        return JSON.stringify({ status: "ok", file: rel, note: "Overwritten with small changes" });
      } else {
        // ensure parent dir exists
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content.replace(/\r\n/g, "\n"), "utf-8");
        return JSON.stringify({ status: "ok", file: rel, note: "File created" });
      }
    } catch (e: any) {
      return JSON.stringify({ status: "error", file: String((file_path && normalizeWorkspaceRel(String(file_path))) || ""), note: String(e?.message || e) });
    }
  },
  "lov-rename": async ({ original_file_path, new_file_path, confirm }: { original_file_path: string; new_file_path: string; confirm?: boolean }) => {
    try {
      const relFrom = normalizeWorkspaceRel(original_file_path);
      const relTo = normalizeWorkspaceRel(new_file_path);
      const absFrom = safeJoin(WORKSPACE, relFrom);
      const absTo = safeJoin(WORKSPACE, relTo);
      const forbidFrom = isForbiddenPath(absFrom);
      const forbidTo = isForbiddenPath(absTo);
      if (forbidFrom) return JSON.stringify({ status: "error", file: relFrom, note: forbidFrom });
      if (forbidTo) return JSON.stringify({ status: "error", file: relTo, note: forbidTo });
      if (!fs.existsSync(absFrom)) return JSON.stringify({ status: "error", file: relFrom, note: "Source not found" });

      const relFromDir = path.dirname(path.relative(WORKSPACE, absFrom));
      const relToDir = path.dirname(path.relative(WORKSPACE, absTo));
      if (relFromDir !== relToDir) {
        return JSON.stringify({ status: "error", file: relFrom, note: "Cross-directory renames are blocked" });
      }

      if (fs.existsSync(absTo)) {
        if (!confirm) {
          return JSON.stringify({ status: "error", file: relTo, note: "Target exists; pass confirm:true to overwrite (backup will be created)" });
        }
        try { fs.renameSync(absTo, absTo + ".bak"); } catch {}
      }

      fs.renameSync(absFrom, absTo);
      return JSON.stringify({ status: "ok", file: relTo, note: "Renamed (target backup created if existed)" });
    } catch (e: any) {
      const relFallback = (new_file_path ? normalizeWorkspaceRel(String(new_file_path)) : (original_file_path ? normalizeWorkspaceRel(String(original_file_path)) : ""));
      return JSON.stringify({ status: "error", file: relFallback, note: String(e?.message || e) });
    }
  },
  "lov-delete": async ({ file_path, confirm }: { file_path: string; confirm?: boolean }) => {
    try {
      if (!ENABLE_DELETE) {
        return JSON.stringify({ status: "not_enabled", tool: "lov-delete" });
      }
      const rel = normalizeWorkspaceRel(file_path);
      const abs = safeJoin(WORKSPACE, rel);
      const forbidden = isForbiddenPath(abs);
      if (forbidden) return JSON.stringify({ status: "error", file: rel, note: forbidden });
      if (!fs.existsSync(abs)) return JSON.stringify({ status: "error", file: rel, note: "File not found. Use paths relative to workspace root, e.g. 'src/App.tsx' (no 'workspace/' prefix)." });
      const stat = fs.statSync(abs);
      const size = stat.size;
      if (!confirm) {
        return JSON.stringify({ status: "confirm_required", file: rel, note: `About to delete ${size} bytes. Re-run with confirm:true to proceed.` });
      }
      // Safety: do not actually delete here; return warning for chat confirmation flow
      return JSON.stringify({ status: "confirm", file: rel, note: `Deletion requested for ${size} bytes. Confirm in chat to proceed.` });
    } catch (e: any) {
      return JSON.stringify({ status: "error", file: String((file_path && normalizeWorkspaceRel(String(file_path))) || ""), note: String(e?.message || e) });
    }
  },
  "lov-download-to-repo": async (args: { url: string; save_path?: string }) => {
    try {
      if (!ENABLE_DOWNLOAD) {
        return JSON.stringify({ status: "not_enabled", tool: "lov-download-to-repo" });
      }
      const url = String((args as any)?.url || "");
      if (!url) return JSON.stringify({ status: "error", note: "Missing url" });

      const publicDir = path.join(WORKSPACE, "public");
      const assetsDir = path.join(WORKSPACE, "src", "assets");
      const hasPublic = fs.existsSync(publicDir);
      const hasAssets = fs.existsSync(assetsDir);

      let targetAbs: string;
      if ((args as any)?.save_path) {
        const rel = normalizeWorkspaceRel(String((args as any).save_path));
        const abs = safeJoin(WORKSPACE, rel);
        const insidePublic = hasPublic && isPathInside(abs, publicDir);
        const insideAssets = hasAssets && isPathInside(abs, assetsDir);
        if (!insidePublic && !insideAssets) {
          return JSON.stringify({ status: "error", note: "save_path must be under workspace/public or workspace/src/assets" });
        }
        targetAbs = abs;
      } else {
        const u = new URL(url);
        const filename = path.basename(u.pathname) || "download.bin";
        const base = hasPublic ? publicDir : assetsDir;
        if (!base) return JSON.stringify({ status: "error", note: "No allowed target directory (public or src/assets) exists" });
        targetAbs = path.join(base, filename);
      }

      const data = await boundedDownload(url);
      const ext = path.extname(targetAbs).toLowerCase();
      if (ext === ".svg") {
        const text = data.toString("utf-8");
        if (/<script[\s>]/i.test(text)) {
          return JSON.stringify({ status: "error", note: "Blocked: SVG contains <script>" });
        }
      }

      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, data);
      const relSaved = path.relative(WORKSPACE, targetAbs).replace(/\\\\/g, "/");
      return JSON.stringify({ status: "ok", file: relSaved, bytes: data.byteLength });
    } catch (e: any) {
      return JSON.stringify({ status: "error", note: String(e?.message || e) });
    }
  },
  "lov-add-dependency": async (args: { packages: string[]; dev?: boolean; workspace?: string }) => {
    try {
      if (!ENABLE_DEPS) {
        return JSON.stringify({ status: "not_enabled", tool: "lov-add-dependency" });
      }
      const pkgs = Array.isArray((args as any)?.packages) ? (args as any).packages as string[] : [];
      if (!pkgs.length) return JSON.stringify({ status: "error", note: "packages[] required" });
      const invalid: string[] = [];
      for (const spec of pkgs) {
        if (!isPinnedVersionSpec(spec)) invalid.push(spec);
      }
      if (invalid.length) {
        return JSON.stringify({ status: "error", note: `Unpinned or invalid versions: ${invalid.join(", ")}` });
      }
      // Intentionally do not modify package.json here.
      const auditTip = "Tip: run `npm audit --omit=dev` after installing.";
      return JSON.stringify({ status: "ok", note: "Validated pinned specs only (no changes applied)", audit: auditTip, packages: pkgs });
    } catch (e: any) {
      return JSON.stringify({ status: "error", note: String(e?.message || e) });
    }
  },
  "lov-remove-dependency": async (args: { packages: string[]; dev?: boolean; workspace?: string }) => {
    try {
      if (!ENABLE_DEPS) {
        return JSON.stringify({ status: "not_enabled", tool: "lov-remove-dependency" });
      }
      const pkgs = Array.isArray((args as any)?.packages) ? (args as any).packages as string[] : [];
      if (!pkgs.length) return JSON.stringify({ status: "error", note: "packages[] required" });
      const auditTip = "Tip: run `npm audit --omit=dev` after changes.";
      return JSON.stringify({ status: "ok", note: "Validated package names only (no changes applied)", audit: auditTip, packages: pkgs });
    } catch (e: any) {
      return JSON.stringify({ status: "error", note: String(e?.message || e) });
    }
  },
};

function isPinnedVersionSpec(spec: string): boolean {
  if (typeof spec !== "string" || !spec.trim()) return false;
  const lastAt = spec.lastIndexOf("@");
  if (lastAt <= 0 || lastAt === spec.length - 1) return false; // supports scoped packages
  const name = spec.slice(0, lastAt);
  const version = spec.slice(lastAt + 1);
  if (!name || !version) return false;
  if (/[~^><=*xX]/.test(version)) return false;
  // basic semver pin: 1.2.3 or with pre-release/build
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return false;
  return true;
}

app.post("/chat", async (req, res) => {
  try {
    const parse = ChatRequest.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Invalid request", details: parse.error.flatten() });
    }
    const { messages } = parse.data;

    // Prepend enforced system prompt, overriding any incoming system message
    const userAndAssistantMessages = messages.filter((m) => m.role !== "system");
    const withSystem = [
      { role: "system", content: SYSTEM_PROMPT },
      ...userAndAssistantMessages,
    ];

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1",
      messages: withSystem as any,
      tools: OPENAI_TOOLS,
      temperature: 0.3,
    });

    const assistantMessage = completion.choices[0]?.message;

    // If tools are requested, dispatch, then follow-up with tool responses
    if ((assistantMessage as any)?.tool_calls && Array.isArray((assistantMessage as any).tool_calls)) {
      const toolCalls = (assistantMessage as any).tool_calls as Array<any>;
      const toolMessages: any[] = [];

      for (const call of toolCalls) {
        const name = call.function?.name as string | undefined;
        const argsStr = call.function?.arguments ?? "{}";
        let content = "";
        try {
          const args = JSON.parse(argsStr);
          if (name && toolHandlers[name]) {
            content = await toolHandlers[name](args);
          } else if (name && (name.startsWith("secrets--") || name.startsWith("security--") || name === "stripe--enable_stripe")) {
            content = JSON.stringify({ status: "not_enabled", tool: name });
          } else {
            content = JSON.stringify({ error: `Unknown tool: ${name}` });
          }
        } catch (e: any) {
          content = JSON.stringify({ error: String(e?.message || e) });
        }
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content,
        });
      }

      const followUp = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4.1",
        messages: ([...withSystem, assistantMessage, ...toolMessages] as any),
        tools: OPENAI_TOOLS,
        temperature: 0.3,
      });

      const finalMessage = followUp.choices[0]?.message;
      return res.json({ message: finalMessage });
    }

    // No tools requested, return the first assistant message
    return res.json({ message: assistantMessage });
  } catch (err: any) {
    const status = 500;
    return res.status(status).json({ error: err?.message || "Server error" });
  }
});

// -----------------------------
// Health endpoint
// -----------------------------
app.get("/health", (_req, res) => {
  return res.json({
    download_enabled: ENABLE_DOWNLOAD,
    deps_enabled: ENABLE_DEPS,
    delete_enabled: ENABLE_DELETE,
    env: {
      source: ENV_SOURCE,
      openai_key_present: OPENAI_KEY_PRESENT,
      model: process.env.OPENAI_MODEL || "gpt-4.1",
    },
    workspace_root: WORKSPACE,
  });
});

const PORT = 8787;
app.listen(PORT, () => {
  console.log(`engine listening on http://localhost:${PORT}`);
  console.log(`workspace root: ${WORKSPACE}`);
});

// Export helpers for potential tests
export { WORKSPACE, safeJoin, boundedDownload };

