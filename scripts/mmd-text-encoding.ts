import type { Plugin } from 'vite'

/** The bundled r171 MMD parser reads all PMX text as UTF-16, despite the format's UTF-8 flag. */
export function mmdTextEncoding(): Plugin {
  return {
    name: 'mmd-text-encoding',
    enforce: 'pre',
    transform(source, id) {
      if (!id.replace(/\\/g, '/').endsWith('/three/examples/jsm/libs/mmdparser.module.js')) return
      const header = /metadata\.encoding = dv\.getUint8\(\);/
      const text = /var size = this\.getUint32\(\);\s*return this\.getUnicodeStrings\( size \);/
      if (!header.test(source) || !text.test(source)) throw new Error('Three.js MMD parser changed: review its text encoding adapter.')
      source = source.replace(header, 'metadata.encoding = dv.getUint8(); dv.encoding = metadata.encoding;')
      source = source.replace(text, `var size = this.getUint32();
        if (size > this.dv.byteLength - this.offset) throw new Error('PMX text length exceeds file bounds');
        var bytes = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.offset, size);
        this.offset += size;
        return new TextDecoder(this.encoding === 1 ? 'utf-8' : 'utf-16le').decode(bytes);`)
      return { code: source, map: null }
    }
  }
}
