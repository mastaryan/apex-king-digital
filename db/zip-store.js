// Minimal ZIP writer (STORE method, no compression).
// Zero dependencies — enough to bundle the 3-file public site for Netlify Drop.
"use strict";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// files: [{name, data: Buffer}]. Returns a Buffer with the .zip.
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dt = dosDateTime();
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    // local file header: 30 bytes
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(0, 8);           // STORE
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    name.copy(local, 30);
    chunks.push(local, data);
    central.push({ name, crc, size: data.length, offset });
    offset += local.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    // central directory header: 46 bytes
    const h = Buffer.alloc(46 + c.name.length);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);          // version made by
    h.writeUInt16LE(20, 6);          // version needed
    h.writeUInt16LE(0x0800, 8);      // flags
    h.writeUInt16LE(0, 10);          // STORE
    h.writeUInt16LE(dt.time, 12);
    h.writeUInt16LE(dt.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.size, 20);     // compressed
    h.writeUInt32LE(c.size, 24);     // uncompressed
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt16LE(0, 30);          // extra
    h.writeUInt16LE(0, 32);          // comment
    h.writeUInt16LE(0, 34);          // disk start
    h.writeUInt16LE(0, 36);          // internal attrs
    h.writeUInt32LE(0, 38);          // external attrs
    h.writeUInt32LE(c.offset, 42);   // local header offset
    c.name.copy(h, 46);
    chunks.push(h);
    cdSize += h.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  chunks.push(end);
  return Buffer.concat(chunks);
}

module.exports = { makeZip };
