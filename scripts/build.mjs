import { build } from 'esbuild'
import { build as buildVite } from 'vite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDemo } from './fixtures.mjs'
import './notices.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(path.join(root, 'dist', 'native'), { recursive: true })
const cache = path.resolve(root, '../../work/swift-cache')
await mkdir(cache, { recursive: true })
execFileSync(
  '/usr/bin/clang',
  [
    '-O2',
    '-fobjc-arc',
    '-framework',
    'Foundation',
    '-framework',
    'AVFoundation',
    '-o',
    path.join(root, 'dist/native/organizer-helper'),
    path.join(root, 'native/macos/Helper.m'),
  ],
  { stdio: 'inherit', env: { ...process.env, CLANG_MODULE_CACHE_PATH: cache } }
)
for (const entry of ['main', 'preload', 'service', 'metadata-worker', 'xml-worker', 'hash-worker'])
  await build({
    entryPoints: [path.join(root, `src/${entry}.ts`)],
    outfile: path.join(root, `dist/${entry}.cjs`),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron', 'better-sqlite3', 'music-metadata', 'strtok3'],
    sourcemap: false,
  })
await buildVite({
  root,
  base: './',
  build: { outDir: 'dist/ui', emptyOutDir: true },
  logLevel: 'warn',
})
await createDemo(path.join(root, 'dist/demo-library'))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
await writeFile(
  path.join(root, 'dist/build-info.json'),
  JSON.stringify(
    {
      version: pkg.version,
      builtAt: new Date().toISOString(),
      architecture: process.arch,
      milestone:
        'Tagged practice library, custom playlists, unified review and recoverable song Trash',
      audioOperations:
        'Explicit selected-song and verified duplicate Trash/restore; local organization tags only, embedded audio/tags read-only',
    },
    null,
    2
  )
)
console.log('Built UI, background services, native helper, and synthetic demo library.')
