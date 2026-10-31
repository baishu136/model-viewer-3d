/**
 * Fast endian-aware binary reader wrapper around DataView for binary 3D format parsing.
 */
export class BinaryReader {
  private view: DataView
  private cursor: number = 0
  private littleEndian: boolean = true

  constructor(buffer: ArrayBuffer | ArrayBufferLike, offset: number = 0, byteLength?: number) {
    this.view = new DataView(buffer, offset, byteLength ?? (buffer.byteLength - offset))
  }

  get position(): number {
    return this.cursor
  }

  set position(pos: number) {
    this.cursor = Math.max(0, Math.min(pos, this.view.byteLength))
  }

  get length(): number {
    return this.view.byteLength
  }

  get remaining(): number {
    return Math.max(0, this.view.byteLength - this.cursor)
  }

  setLittleEndian(le: boolean): void {
    this.littleEndian = le
  }

  isLittleEndian(): boolean {
    return this.littleEndian
  }

  seek(offset: number): void {
    this.position = offset
  }

  skip(bytes: number): void {
    this.cursor = Math.min(this.view.byteLength, this.cursor + bytes)
  }

  readUint8(): number {
    const val = this.view.getUint8(this.cursor)
    this.cursor += 1
    return val
  }

  readInt8(): number {
    const val = this.view.getInt8(this.cursor)
    this.cursor += 1
    return val
  }

  readUint16(littleEndian = this.littleEndian): number {
    const val = this.view.getUint16(this.cursor, littleEndian)
    this.cursor += 2
    return val
  }

  readInt16(littleEndian = this.littleEndian): number {
    const val = this.view.getInt16(this.cursor, littleEndian)
    this.cursor += 2
    return val
  }

  readUint32(littleEndian = this.littleEndian): number {
    const val = this.view.getUint32(this.cursor, littleEndian)
    this.cursor += 4
    return val
  }

  readInt32(littleEndian = this.littleEndian): number {
    const val = this.view.getInt32(this.cursor, littleEndian)
    this.cursor += 4
    return val
  }

  readUint64(littleEndian = this.littleEndian): bigint {
    const val = this.view.getBigUint64(this.cursor, littleEndian)
    this.cursor += 8
    return val
  }

  readFloat32(littleEndian = this.littleEndian): number {
    const val = this.view.getFloat32(this.cursor, littleEndian)
    this.cursor += 4
    return val
  }

  readFloat64(littleEndian = this.littleEndian): number {
    const val = this.view.getFloat64(this.cursor, littleEndian)
    this.cursor += 8
    return val
  }

  readString(length: number): string {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.cursor, length)
    this.cursor += length
    return new TextDecoder('utf-8').decode(bytes)
  }

  readAscii(length: number): string {
    let s = ''
    for (let i = 0; i < length; i++) {
      const code = this.view.getUint8(this.cursor++)
      if (code === 0) {
        this.cursor += (length - i - 1)
        break
      }
      s += String.fromCharCode(code)
    }
    return s
  }

  readBytes(length: number): Uint8Array {
    const arr = new Uint8Array(this.view.buffer, this.view.byteOffset + this.cursor, length)
    this.cursor += length
    return arr
  }

  readFourCC(): string {
    return this.readAscii(4)
  }
}
