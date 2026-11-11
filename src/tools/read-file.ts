/** read_file: bounded read of a current-question attachment or a trial-generated file. */
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.js";
import { resolveToolRef } from "./context.js";
import { boundedUtf8 } from "../shared/utf8.js";

export function readFileTool(ctx: ToolContext): AgentTool {
  return {
    name: "read_file",
    label: "Read File",
    description:
      "Read a text or data file from the CURRENT question's attachments or this attempt's work dir. " +
      "References are confined to those; other questions' files and arbitrary host paths are rejected.",
    parameters: Type.Object({ path: Type.String(), maxBytes: Type.Optional(Type.Integer({ minimum: 1 })) }),
    execute: async (_id, args) => {
      const { path, maxBytes } = args as { path: string; maxBytes?: number };
      try {
        if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) throw new Error("maxBytes must be a positive safe integer");
        if (!Number.isSafeInteger(ctx.limits.maxOutputBytes) || ctx.limits.maxOutputBytes <= 0) throw new Error("invalid tool output byte limit");
        const abs = resolveToolRef(ctx, path);
        const fd = openSync(abs, "r");
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile()) throw new Error(`not a file: ${path}`);
          const cap = Math.min(maxBytes ?? 65536, ctx.limits.maxOutputBytes, stat.size);
          const buf = Buffer.alloc(cap);
          let bytes = 0;
          while (bytes < cap) {
            const read = readSync(fd, buf, bytes, cap - bytes, null);
            if (!read) break;
            bytes += read;
          }
          const truncated = stat.size > bytes;
          const decoder = new StringDecoder("utf8");
          const decoded = decoder.write(buf.subarray(0, bytes)) + (truncated ? "" : decoder.end());
          const marker = truncated ? `\n--- truncated (${stat.size} bytes total) ---` : "";
          const output = boundedUtf8(decoded + marker, ctx.limits.maxOutputBytes);
          return { content: [{ type: "text", text: output.text }], details: { path: abs, bytes, totalBytes: stat.size, truncated: truncated || output.truncated } };
        } finally { closeSync(fd); }
      } catch (e) {
        return { content: [{ type: "text", text: `read_file error: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  };
}
