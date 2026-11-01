// .tmp-max/p2000.ts
import * as fs from "fs";

// src/renderer/src/loaders/utils/compound-file.ts
var CompoundFile = class _CompoundFile {
  bytes;
  view;
  sectorSize;
  miniSectorSize;
  miniCutoff;
  fat;
  miniFat;
  entries;
  miniStream;
  static FREESECT = 4294967295;
  static ENDOFCHAIN = 4294967294;
  static MAXREGSECT = 4294967290;
  static NOSTREAM = 4294967295;
  constructor(buffer) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    if (this.bytes.length < 512 || this.bytes[0] !== 208 || this.bytes[1] !== 207 || this.bytes[2] !== 17 || this.bytes[3] !== 224) {
      throw new Error("\u4E0D\u662F\u6709\u6548\u7684 OLE \u590D\u5408\u6587\u6863");
    }
    const sectorShift = this.view.getUint16(30, true);
    const miniSectorShift = this.view.getUint16(32, true);
    this.sectorSize = 1 << sectorShift;
    this.miniSectorSize = 1 << miniSectorShift;
    this.miniCutoff = this.view.getUint32(56, true);
    this.fat = this.readFat();
    const directoryChain = this.readChain(this.view.getUint32(48, true));
    this.entries = this.readDirectory(directoryChain);
    const root2 = this.entries[0];
    this.miniStream = root2 ? { start: root2.start, size: root2.size } : { start: _CompoundFile.ENDOFCHAIN, size: 0 };
    this.miniFat = this.readMiniFat();
  }
  /** 按名字（不区分大小写）读取流；找不到返回 null */
  readStream(name) {
    const target = name.toLowerCase();
    const entry = this.entries.find((e) => e.type === 2 && e.name.toLowerCase() === target);
    if (!entry) return null;
    if (entry.size < this.miniCutoff) {
      return this.readMiniStream(entry.start, entry.size);
    }
    return this.readSectors(entry.start, entry.size);
  }
  sectorOffset(sector) {
    return (sector + 1) * this.sectorSize;
  }
  readFat() {
    const fatSectorCount = this.view.getUint32(44, true);
    const difatSector = this.view.getUint32(68, true);
    const fatSectors = [];
    for (let i = 0; i < 109; i++) {
      const sector = this.view.getUint32(76 + i * 4, true);
      if (sector <= _CompoundFile.MAXREGSECT) fatSectors.push(sector);
    }
    let difat = difatSector;
    let guard = 0;
    const entriesPerSector = this.sectorSize / 4;
    while (difat <= _CompoundFile.MAXREGSECT && guard++ < 4096) {
      const offset = this.sectorOffset(difat);
      if (offset + this.sectorSize > this.bytes.length) break;
      for (let i = 0; i < entriesPerSector - 1; i++) {
        const sector = this.view.getUint32(offset + i * 4, true);
        if (sector <= _CompoundFile.MAXREGSECT) fatSectors.push(sector);
      }
      difat = this.view.getUint32(offset + (entriesPerSector - 1) * 4, true);
    }
    const total = Math.max(fatSectorCount, fatSectors.length) * entriesPerSector;
    const fat = new Uint32Array(total);
    let cursor = 0;
    for (const sector of fatSectors) {
      const offset = this.sectorOffset(sector);
      if (offset + this.sectorSize > this.bytes.length) break;
      for (let i = 0; i < entriesPerSector; i++) {
        fat[cursor++] = this.view.getUint32(offset + i * 4, true);
      }
    }
    return fat;
  }
  readMiniFat() {
    const count = this.view.getUint32(64, true);
    if (count === 0) return new Uint32Array(0);
    const start = this.view.getUint32(60, true);
    const chain = this.readChain(start);
    const entriesPerSector = this.sectorSize / 4;
    const out = new Uint32Array(chain.length * entriesPerSector);
    let cursor = 0;
    for (const sector of chain) {
      const offset = this.sectorOffset(sector);
      for (let i = 0; i < entriesPerSector; i++) {
        out[cursor++] = this.view.getUint32(offset + i * 4, true);
      }
    }
    return out;
  }
  readChain(start) {
    const chain = [];
    let sector = start;
    let guard = 0;
    const maxIterations = this.fat.length + 8;
    while (sector <= _CompoundFile.MAXREGSECT && guard++ < maxIterations) {
      chain.push(sector);
      sector = this.fat[sector] ?? _CompoundFile.ENDOFCHAIN;
    }
    return chain;
  }
  readDirectory(chain) {
    const raw = new Uint8Array(chain.length * this.sectorSize);
    let cursor = 0;
    for (const sector of chain) {
      const offset = this.sectorOffset(sector);
      if (offset + this.sectorSize > this.bytes.length) break;
      raw.set(this.bytes.subarray(offset, offset + this.sectorSize), cursor);
      cursor += this.sectorSize;
    }
    const side = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const entries = [];
    for (let offset = 0; offset + 128 <= raw.length; offset += 128) {
      const nameLength = side.getUint16(offset + 64, true);
      const type = side.getUint8(offset + 66);
      if (type !== 1 && type !== 2 && type !== 5) {
        entries.push({ name: "", type: 0, start: _CompoundFile.ENDOFCHAIN, size: 0 });
        continue;
      }
      let name = "";
      const chars = Math.max(0, Math.min(31, nameLength / 2 - 1));
      for (let i = 0; i < chars; i++) {
        name += String.fromCharCode(side.getUint16(offset + i * 2, true));
      }
      const start = side.getUint32(offset + 116, true);
      const sizeLow = side.getUint32(offset + 120, true);
      const sizeHigh = side.getUint32(offset + 124, true);
      const size = sizeHigh === 0 ? sizeLow : sizeLow + sizeHigh * 4294967296;
      entries.push({ name, type, start, size });
    }
    return entries;
  }
  readSectors(start, size) {
    const chain = this.readChain(start);
    const out = new Uint8Array(size);
    let cursor = 0;
    for (const sector of chain) {
      if (cursor >= size) break;
      const offset = this.sectorOffset(sector);
      const available = Math.min(this.sectorSize, size - cursor);
      if (offset + available > this.bytes.length) break;
      out.set(this.bytes.subarray(offset, offset + available), cursor);
      cursor += available;
    }
    return out;
  }
  readMiniStream(start, size) {
    const out = new Uint8Array(size);
    if (this.miniStream.size === 0) return out;
    const miniStreamBytes = this.readSectors(this.miniStream.start, this.miniStream.size);
    let sector = start;
    let cursor = 0;
    let guard = 0;
    while (sector <= _CompoundFile.MAXREGSECT && cursor < size && guard++ < this.miniFat.length + 8) {
      const offset = sector * this.miniSectorSize;
      const available = Math.min(this.miniSectorSize, size - cursor);
      if (offset + available > miniStreamBytes.length) break;
      out.set(miniStreamBytes.subarray(offset, offset + available), cursor);
      cursor += available;
      sector = this.miniFat[sector] ?? _CompoundFile.ENDOFCHAIN;
    }
    return out;
  }
};

// .tmp-max/p2000.ts
var file = "C:/Users/GUDGA/Desktop/\u6A21\u578B\u6709\u5173/\u573A\u666F\u53C2\u8003/2/Decorative_set_4/Decorative_set_4_CORONA.max";
var scene = new CompoundFile(new Uint8Array(fs.readFileSync(file))).readStream("Scene");
var view = new DataView(scene.buffer, scene.byteOffset, scene.byteLength);
var rh = (off, limit) => {
  if (off + 6 > limit) return null;
  const id = view.getUint16(off, true), raw = view.getUint32(off + 2, true);
  if (raw !== 0) return { id, start: off, end: off + (raw & 2147483647), hdr: 6, c: (raw & 2147483648) !== 0 };
  const lo = view.getUint32(off + 6, true), hi = view.getUint32(off + 10, true);
  return { id, start: off, end: off + ((hi & 2147483647) * 4294967296 + lo), hdr: 14, c: (hi & 2147483648) !== 0 };
};
var children = (r) => {
  const out = [];
  let o = r.start + r.hdr;
  while (o < r.end) {
    const c = rh(o, r.end);
    if (!c) break;
    out.push(c);
    o = c.end;
  }
  return out;
};
var root = rh(0, scene.length);
var items = children(root);
var item = items[1084];
var p2000 = children(item).find((c) => c.id === 8192);
console.log("0x2000 size", p2000.end - p2000.start - p2000.hdr, "container", p2000.c);
var dump = (r, depth = 0) => {
  console.log("  ".repeat(depth) + `0x${r.id.toString(16)} len=${r.end - r.start - r.hdr} cont=${r.c}`);
  if (r.c && depth < 3) for (const k of children(r)) dump(k, depth + 1);
  if (!r.c) {
    const bytes = scene.subarray(r.start + r.hdr, Math.min(r.end, r.start + r.hdr + 64));
    console.log("  ".repeat(depth + 1) + Buffer.from(bytes).toString("hex"));
    const floats = [];
    for (let i = 0; i + 4 <= Math.min(64, r.end - r.start - r.hdr); i += 4) floats.push(+view.getFloat32(r.start + r.hdr + i, true).toFixed(2));
    console.log("  ".repeat(depth + 1) + "f32:", floats.join(","));
  }
};
dump(p2000);
