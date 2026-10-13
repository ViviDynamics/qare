import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Execute the checkout's source, never the image's compiled qare. Node's
// transformer handles parameter properties too; strip-only mode cannot.
const source = new URL('../../packages/core/src/', import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.startsWith(source)) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context)
    }
    try {
      return next(specifier, context)
    } catch (error) {
      // The raw checkout has no dependencies. YAML is a production dependency
      // the published image already ships; no test runner or install is needed.
      if (specifier !== 'yaml' || error.code !== 'ERR_MODULE_NOT_FOUND') throw error
      const yaml = createRequire('/opt/qare/lib/packages/core/package.json').resolve('yaml')
      return next(pathToFileURL(yaml).href, context)
    }
  },
  load(url, context, next) {
    if (!url.startsWith(source) || !url.endsWith('.ts')) return next(url, context)
    return {
      format: 'module',
      shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    }
  },
})
