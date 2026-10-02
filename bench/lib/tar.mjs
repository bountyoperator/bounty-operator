// Minimal deterministic ustar + gzip writer and reader (Node built-ins only), used for
// the public download archive. Regular files only; fixed mtime, mode and owner so the
// same inputs always give the same bytes.
import zlib from 'node:zlib';

const BLOCK = 512;

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  // ustar: prefix (<=155) + '/' + name (<=100), split at a slash
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i), rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest) return { name: rest, prefix };
  }
  throw new Error(`path too long for the archive: ${name}`);
}

function header(entryName, size) {
  const { name, prefix } = splitName(entryName);
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii'); // mtime 0
  h.write('        ', 148, 8, 'ascii');      // checksum placeholder
  h.write('0', 156, 1, 'ascii');             // regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** entries: [{ path: 'a/b.txt', data: Buffer|string }] -> gzipped tar Buffer. Entries are sorted by path. */
export function packTarGz(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks = [];
  for (const e of sorted) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    chunks.push(header(e.path, data.length), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** gzipped tar Buffer -> Map(path -> Buffer). */
export function unpackTarGz(buffer) {
  const tar = zlib.gunzipSync(buffer);
  const files = new Map();
  const str = (start, len) => { const s = tar.subarray(start, start + len); const end = s.indexOf(0); return s.subarray(0, end < 0 ? len : end).toString('utf8'); };
  for (let at = 0; at + BLOCK <= tar.length;) {
    if (tar.subarray(at, at + BLOCK).every((b) => b === 0)) break;
    const name = str(at, 100), prefix = str(at + 345, 155), type = str(at + 156, 1);
    const size = parseInt(str(at + 124, 12).trim() || '0', 8);
    const full = prefix ? `${prefix}/${name}` : name;
    if (type === '0' || type === '') files.set(full, Buffer.from(tar.subarray(at + BLOCK, at + BLOCK + size)));
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
