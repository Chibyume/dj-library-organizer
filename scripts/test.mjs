import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import path from 'node:path'
import electron from 'electron'
await build({
  entryPoints: ['tests/integration.ts'],
  outfile: 'dist/tests.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['better-sqlite3', 'music-metadata'],
})
execFileSync(electron, ['--test', 'dist/tests.cjs'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
