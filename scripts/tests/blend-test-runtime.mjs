import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from '@swc/core'

export async function compileBlendLoader(root, temp) {
  for (const name of ['BlendLoader', 'utils/binary-reader', 'utils/triangulation', 'utils/blend-modifiers']) {
    const source = fs.readFileSync(path.join(root, 'src/renderer/src/loaders', name + '.ts'), 'utf8')
      .replace(/(['"])\.\/(?:utils\/)?(binary-reader|triangulation|blend-modifiers)\1/g, "'./$2.mjs'")
    fs.writeFileSync(path.join(temp, path.basename(name) + '.mjs'), transformSync(source, {
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'es6' }
    }).code)
  }
  return import(pathToFileURL(path.join(temp, 'BlendLoader.mjs')).href)
}

export function cleanupBlendTest(root, temp) {
  if (path.dirname(temp) !== root || !path.basename(temp).startsWith('.tmp-blend-test-')) throw new Error('Unsafe test cleanup path')
  fs.rmSync(temp, { recursive: true, force: true })
}
