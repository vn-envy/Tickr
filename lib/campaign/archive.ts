import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export function safeOutputPath(directory: string, filename: string): string {
  if (!filename || filename !== basename(filename) || !/^[a-z0-9][a-z0-9._-]*$/i.test(filename) || filename.includes("..") || isAbsolute(filename)) throw new Error("Invalid campaign filename.");
  return join(resolve(directory), filename);
}

export function hashBytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Local ZIP store format: no commands, remote service, directory entries or path traversal. */
export function buildZip(entries: readonly { filename: string; bytes: Buffer }[]): Buffer {
  if (entries.length > 100 || new Set(entries.map((entry) => entry.filename)).size !== entries.length) throw new Error("Invalid archive inventory.");
  if (entries.reduce((sum, item) => sum + item.bytes.length, 0) > 100_000_000) throw new Error("The campaign archive exceeds the local size limit.");
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    safeOutputPath("/tmp", entry.filename);
    const name = Buffer.from(entry.filename, "utf8");
    const crc = crc32(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); // DOS date 1980-01-01, stable across exports.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(entry.bytes.length, 18); header.writeUInt32LE(entry.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(entry.bytes.length, 20); directory.writeUInt32LE(entry.bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, entry.bytes); central.push(directory, name); offset += header.length + name.length + entry.bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

export async function writeVerifiedArchive(directory: string, files: readonly { filename: string; sha256: string }[], filename = "campaign-concept.zip"): Promise<{ bytes: number; sha256: string }> {
  const entries = await Promise.all(files.map(async (file) => {
    const bytes = await readFile(safeOutputPath(directory, file.filename));
    if (hashBytes(bytes) !== file.sha256) throw new Error("A campaign file changed after review. Rebuild the concept archive.");
    return { filename: file.filename, bytes };
  }));
  const archive = buildZip(entries);
  await writeFile(safeOutputPath(directory, filename), archive);
  return { bytes: archive.length, sha256: hashBytes(archive) };
}
