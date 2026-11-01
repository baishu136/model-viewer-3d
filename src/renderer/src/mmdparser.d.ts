declare module 'three/examples/jsm/libs/mmdparser.module.js' {
  export class Parser {
    parsePmd(buffer: ArrayBuffer, leftToRight: boolean): { materials: unknown[] }
    parsePmx(buffer: ArrayBuffer, leftToRight: boolean): { materials: unknown[] }
  }
}
