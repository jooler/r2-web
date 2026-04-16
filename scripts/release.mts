/// <reference types="node" />

import path from 'node:path'
import fs from 'node:fs/promises'
import pkg from '../package.json' with { type: 'json' }

const constantsFile = path.resolve(import.meta.dirname, '../src/js/constants.js')

let constantsString = await fs.readFile(constantsFile, 'utf-8')

constantsString = constantsString.replace(
  /export const VERSION = ['"](.*?)['"];?/g,
  `export const VERSION = '${pkg.version}'`,
)

constantsString = constantsString.replace(
  /export const UPDATED_AT = ['"](.*?)['"];?/g,
  `export const UPDATED_AT = '${new Date().toISOString()}'`,
)

await fs.writeFile(constantsFile, constantsString)
