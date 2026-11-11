/** Shared context for exam tools (AGENTS.md §9; P2-7 scope + realpath). */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ProtectionLimits } from "../shared/contracts.js";
import { resolvePublicAttachment, resolveWithin } from "./paths.js";
import { PathEscapeError } from "../shared/errors.js";

export interface ToolContext {
  /** Isolated per-attempt work dir: generated code + outputs live here. */
  workDir: string;
  /** Dataset public dir (used to resolve question-relative refs). */
  publicDir: string;
  /** Absolute paths of the CURRENT question's public attachments (allow-list).
   *  Tools may read ONLY these + the attempt work dir — not other questions. */
  questionFiles: string[];
  pythonInterpreter: string;
  tscEntry: string; // path to typescript/bin/tsc, run via node
  nodePath: string;
  limits: Pick<ProtectionLimits, "perToolTimeoutMs" | "maxOutputBytes" | "maxImagePixels">;
  /** Override lstat (tests) to simulate symlinks without OS privilege. */
  lstat?: (p: string) => { isSymbolicLink(): boolean };
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a tool file reference. Allowed ONLY:
 *   (a) a file whose REAL path is one of THIS question's allow-listed attachments, or
 *   (b) a file whose REAL path stays inside this attempt's work dir.
 *
 * R2-2 + P2-7: the REAL (symlink-resolved) target is what matters. A link inside
 * the work dir that points at ANOTHER question's public file (or any path outside
 * the work dir) is rejected — being "somewhere under publicDir" is NOT enough; the
 * public target must be this question's own allow-listed file.
 */
export function resolveToolRef(ctx: ToolContext, ref: string): string {
  // (a) this question's allow-listed attachments. The declared attachment must be
  // a REGULAR file: a symbolic link's real target is NOT this question's entity,
  // so refuse it (P2-G) rather than let a link silently authorize another file.
  const allowedLexical = new Set(ctx.questionFiles.map((f) => resolve(f)));
  const pubCandidate = resolve(ctx.publicDir, ref);
  if (allowedLexical.has(pubCandidate)) {
    return resolvePublicAttachment(ctx.publicDir, ref, ctx.lstat);
  }

  // (b) this attempt's work dir; the REAL target must stay inside it.
  let lexical: string;
  try {
    lexical = resolveWithin(ctx.workDir, ref);
  } catch {
    throw new PathEscapeError(`ref is not in this question's attachments or the attempt work dir: ${ref}`);
  }
  const real = safeRealpath(lexical);
  if (!real) throw new PathEscapeError(`ref does not resolve to an existing file in an allowed root: ${ref}`);
  const realWork = safeRealpath(resolve(ctx.workDir)) ?? resolve(ctx.workDir);
  if (real === realWork || real.startsWith(realWork + sep)) return real;
  throw new PathEscapeError(`ref resolves outside the attempt work dir (link escape?): ${ref}`);
}
