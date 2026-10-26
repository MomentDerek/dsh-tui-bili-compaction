#!/usr/bin/env node
/** Dependency-free sanity check for the dsh-tui Community v0.15 manifest. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'dsh-plugin.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const fail = (message) => { console.error(`FAIL: ${message}`); process.exit(1) }
const text = (value) => typeof value === 'string' && value.trim() !== ''

if (manifest.$schema !== 'https://dsh.community/schemas/dsh-plugin-0.15.json') fail('$schema must be the Community v0.15 schema URL')
if (manifest.manifestVersion !== '0.15') fail('manifestVersion must be "0.15"')
if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/.test(manifest.id ?? '')) fail('id must be a namespaced identifier')
if (!text(manifest.name)) fail('name is required')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) fail('version must be semver')
if (manifest.version !== pkg.version) fail('manifest version must match package.json')
if (manifest.facets?.host?.apiVersion !== 'v1alpha1') fail('facets.host.apiVersion must be v1alpha1')
const entry = manifest.facets?.host?.entry
if (!text(entry) || !existsSync(join(root, entry))) fail(`facets.host.entry does not exist: ${String(entry)}`)
for (const key of ['requires', 'permissions', 'contributes', 'subscriptions']) {
  if (!(key in manifest)) fail(`missing ${key}`)
}
if (!Array.isArray(manifest.requires.contracts)) fail('requires.contracts must be an array')
if (!Array.isArray(manifest.permissions)) fail('permissions must be an array')
if (!Array.isArray(manifest.contributes.commands)) fail('contributes.commands must be an array')
if (!Array.isArray(manifest.subscriptions)) fail('subscriptions must be an array')
if (!pkg.files?.includes('dsh-plugin.json')) fail('package.json files must include dsh-plugin.json')
console.log(`manifest ok: ${manifest.id} -> ${entry}`)
