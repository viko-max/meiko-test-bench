/** Path resolution confined to allowed roots; rejects escapes and symlink tricks. */
import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { PathEscapeError } from "../shared/errors.js";

export function resolveWithin(root: string, ref: string): string {
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, ref);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new PathEscapeError(`ref escapes root: ${ref}`);
  }
  return target;
}

export function resolvePublicAttachment(
  publicDir: string,
  ref: string,
  stat: (path: string) => { isSymbolicLink(): boolean } = lstatSync,
): string {
  const candidate = resolveWithin(publicDir, ref);
  let symbolic: boolean;
  try {
    symbolic = stat(candidate).isSymbolicLink();
  } catch (e) {
    throw new PathEscapeError(`missing attachment: ${ref}: ${(e as Error).message}`);
  }
  if (symbolic) throw new PathEscapeError(`attachment is a symbolic link (refused): ${ref}`);
  // 根目录可有真实路径映射，附件及其父目录不得改变声明的相对路径。
  const real = realpathSync(candidate);
  const expected = join(realpathSync(resolve(publicDir)), relative(resolve(publicDir), candidate));
  if (real !== expected) throw new PathEscapeError(`attachment resolves outside its declared path (parent link?): ${ref}`);
  if (!lstatSync(real).isFile()) throw new PathEscapeError(`attachment is not a regular file: ${ref}`);
  return real;
}

/** Resolve a ref within the first root that contains it; verify via realpath. */
export function resolveInRoots(roots: string[], ref: string): string {
  let lastErr: unknown;
  for (const root of roots) {
    let candidate: string;
    try {
      candidate = resolveWithin(root, ref);
    } catch (e) {
      lastErr = e;
      continue;
    }
    // Confirm the real (symlink-resolved) path is still inside a root.
    try {
      const real = realpathSync(candidate);
      const inRoot = roots.some((r) => {
        const ra = resolve(r);
        return real === ra || real.startsWith(ra + sep);
      });
      if (!inRoot) throw new PathEscapeError(`symlink escapes roots: ${ref}`);
      return real;
    } catch (e) {
      if (e instanceof PathEscapeError) throw e;
      lastErr = e;
      continue;
    }
  }
  throw lastErr instanceof Error ? lastErr : new PathEscapeError(`no allowed root for ${ref}`);
}
