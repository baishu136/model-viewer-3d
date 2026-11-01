/**
 * 极简 OLE 复合文档（Compound File Binary, .max/.doc 等的容器格式）读取器。
 *
 * 只做一件事：按名字取出某个流的原始字节。相比通用 CFB 库，它直接把扇区拼接成
 * Uint8Array，不生成逐字节的普通数组，因此几十 MB 的 Scene 流也能在毫秒级读出。
 */
export class CompoundFile {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private readonly sectorSize: number
  private readonly miniSectorSize: number
  private readonly miniCutoff: number
  private readonly fat: Uint32Array
  private readonly miniFat: Uint32Array
  private readonly entries: CompoundEntry[]
  private readonly miniStream: { start: number; size: number }

  private static readonly FREESECT = 0xffffffff
  private static readonly ENDOFCHAIN = 0xfffffffe
  private static readonly MAXREGSECT = 0xfffffffa
  private static readonly NOSTREAM = 0xffffffff

  constructor(buffer: ArrayBuffer | Uint8Array) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)

    if (
      this.bytes.length < 512 ||
      this.bytes[0] !== 0xd0 ||
      this.bytes[1] !== 0xcf ||
      this.bytes[2] !== 0x11 ||
      this.bytes[3] !== 0xe0
    ) {
      throw new Error('不是有效的 OLE 复合文档')
    }

    const sectorShift = this.view.getUint16(0x1e, true)
    const miniSectorShift = this.view.getUint16(0x20, true)
    this.sectorSize = 1 << sectorShift
    this.miniSectorSize = 1 << miniSectorShift
    this.miniCutoff = this.view.getUint32(0x38, true)

    this.fat = this.readFat()
    const directoryChain = this.readChain(this.view.getUint32(0x30, true))
    this.entries = this.readDirectory(directoryChain)

    const root = this.entries[0]
    this.miniStream = root ? { start: root.start, size: root.size } : { start: CompoundFile.ENDOFCHAIN, size: 0 }
    this.miniFat = this.readMiniFat()
  }

  /** 按名字（不区分大小写）读取流；找不到返回 null */
  readStream(name: string): Uint8Array | null {
    const target = name.toLowerCase()
    const entry = this.entries.find((e) => e.type === 2 && e.name.toLowerCase() === target)
    if (!entry) return null

    if (entry.size < this.miniCutoff) {
      return this.readMiniStream(entry.start, entry.size)
    }
    return this.readSectors(entry.start, entry.size)
  }

  private sectorOffset(sector: number): number {
    return (sector + 1) * this.sectorSize
  }

  private readFat(): Uint32Array {
    const fatSectorCount = this.view.getUint32(0x2c, true)
    const difatSector = this.view.getUint32(0x44, true)

    const fatSectors: number[] = []
    for (let i = 0; i < 109; i++) {
      const sector = this.view.getUint32(0x4c + i * 4, true)
      if (sector <= CompoundFile.MAXREGSECT) fatSectors.push(sector)
    }

    let difat = difatSector
    let guard = 0
    const entriesPerSector = this.sectorSize / 4
    while (difat <= CompoundFile.MAXREGSECT && guard++ < 4096) {
      const offset = this.sectorOffset(difat)
      if (offset + this.sectorSize > this.bytes.length) break
      for (let i = 0; i < entriesPerSector - 1; i++) {
        const sector = this.view.getUint32(offset + i * 4, true)
        if (sector <= CompoundFile.MAXREGSECT) fatSectors.push(sector)
      }
      difat = this.view.getUint32(offset + (entriesPerSector - 1) * 4, true)
    }

    const total = Math.max(fatSectorCount, fatSectors.length) * entriesPerSector
    const fat = new Uint32Array(total)
    let cursor = 0
    for (const sector of fatSectors) {
      const offset = this.sectorOffset(sector)
      if (offset + this.sectorSize > this.bytes.length) break
      for (let i = 0; i < entriesPerSector; i++) {
        fat[cursor++] = this.view.getUint32(offset + i * 4, true)
      }
    }
    return fat
  }

  private readMiniFat(): Uint32Array {
    const count = this.view.getUint32(0x40, true)
    if (count === 0) return new Uint32Array(0)

    const start = this.view.getUint32(0x3c, true)
    const chain = this.readChain(start)
    const entriesPerSector = this.sectorSize / 4
    const out = new Uint32Array(chain.length * entriesPerSector)
    let cursor = 0
    for (const sector of chain) {
      const offset = this.sectorOffset(sector)
      for (let i = 0; i < entriesPerSector; i++) {
        out[cursor++] = this.view.getUint32(offset + i * 4, true)
      }
    }
    return out
  }

  private readChain(start: number): number[] {
    const chain: number[] = []
    let sector = start
    let guard = 0
    const maxIterations = this.fat.length + 8
    while (sector <= CompoundFile.MAXREGSECT && guard++ < maxIterations) {
      chain.push(sector)
      sector = this.fat[sector] ?? CompoundFile.ENDOFCHAIN
    }
    return chain
  }

  private readDirectory(chain: number[]): CompoundEntry[] {
    const raw = new Uint8Array(chain.length * this.sectorSize)
    let cursor = 0
    for (const sector of chain) {
      const offset = this.sectorOffset(sector)
      if (offset + this.sectorSize > this.bytes.length) break
      raw.set(this.bytes.subarray(offset, offset + this.sectorSize), cursor)
      cursor += this.sectorSize
    }

    const side = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    const entries: CompoundEntry[] = []
    for (let offset = 0; offset + 128 <= raw.length; offset += 128) {
      const nameLength = side.getUint16(offset + 0x40, true)
      const type = side.getUint8(offset + 0x42)
      if (type !== 1 && type !== 2 && type !== 5) {
        entries.push({ name: '', type: 0, start: CompoundFile.ENDOFCHAIN, size: 0 })
        continue
      }

      let name = ''
      const chars = Math.max(0, Math.min(31, nameLength / 2 - 1))
      for (let i = 0; i < chars; i++) {
        name += String.fromCharCode(side.getUint16(offset + i * 2, true))
      }

      const start = side.getUint32(offset + 0x74, true)
      const sizeLow = side.getUint32(offset + 0x78, true)
      const sizeHigh = side.getUint32(offset + 0x7c, true)
      const size = sizeHigh === 0 ? sizeLow : sizeLow + sizeHigh * 4294967296

      entries.push({ name, type, start, size })
    }
    return entries
  }

  private readSectors(start: number, size: number): Uint8Array {
    const chain = this.readChain(start)
    const out = new Uint8Array(size)
    let cursor = 0
    for (const sector of chain) {
      if (cursor >= size) break
      const offset = this.sectorOffset(sector)
      const available = Math.min(this.sectorSize, size - cursor)
      if (offset + available > this.bytes.length) break
      out.set(this.bytes.subarray(offset, offset + available), cursor)
      cursor += available
    }
    return out
  }

  private readMiniStream(start: number, size: number): Uint8Array {
    const out = new Uint8Array(size)
    if (this.miniStream.size === 0) return out

    const miniStreamBytes = this.readSectors(this.miniStream.start, this.miniStream.size)
    let sector = start
    let cursor = 0
    let guard = 0
    while (sector <= CompoundFile.MAXREGSECT && cursor < size && guard++ < this.miniFat.length + 8) {
      const offset = sector * this.miniSectorSize
      const available = Math.min(this.miniSectorSize, size - cursor)
      if (offset + available > miniStreamBytes.length) break
      out.set(miniStreamBytes.subarray(offset, offset + available), cursor)
      cursor += available
      sector = this.miniFat[sector] ?? CompoundFile.ENDOFCHAIN
    }
    return out
  }
}

interface CompoundEntry {
  name: string
  type: number
  start: number
  size: number
}
