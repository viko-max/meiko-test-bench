/** 使用平台编码器按 UTF-8 字节限制文本，保留完整字符。 */
export function boundedUtf8(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("UTF-8 byte limit must be a nonnegative safe integer");
  const buffer = new Uint8Array(Math.min(maxBytes, Buffer.byteLength(text, "utf8")));
  const result = new TextEncoder().encodeInto(text, buffer);
  return { text: Buffer.from(buffer.subarray(0, result.written)).toString("utf8"), bytes: result.written, truncated: result.read < text.length };
}
