import { packager } from '@electron/packager'
import { rebuild } from '@electron/rebuild'
import { readFile, mkdir, cp, rm, readdir, readlink, access, symlink } from 'node:fs/promises'
import path from 'node:path'
const root = process.cwd()
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
await rebuild({
  buildPath: root,
  electronVersion: pkg.devDependencies.electron,
  arch: 'arm64',
  onlyModules: ['better-sqlite3'],
})
const buildRoot = path.resolve(root, '../../work/package')
await mkdir(buildRoot, { recursive: true })
// Reuse the already downloaded runtime when packaging offline.
const electronCache = path.resolve(root, '../../work/electron-cache')
let electronZipDir
for (const entry of await readdir(electronCache, { withFileTypes: true }).catch(() => [])) {
  if (!entry.isDirectory()) continue
  const candidate = path.join(electronCache, entry.name)
  try {
    await access(path.join(candidate, `electron-v${pkg.devDependencies.electron}-darwin-arm64.zip`))
    electronZipDir = candidate
    break
  } catch {
    /* Try the next cached artifact. */
  }
}
const paths = await packager({
  dir: root,
  out: buildRoot,
  name: 'DJ Library Organizer',
  icon: path.join(root, 'assets/organizer.icns'),
  platform: 'darwin',
  arch: 'arm64',
  electronVersion: pkg.devDependencies.electron,
  appBundleId: 'local.djlibrary.organizer',
  appCategoryType: 'public.app-category.music',
  overwrite: true,
  ...(electronZipDir ? { electronZipDir } : { download: { cacheRoot: electronCache } }),
  asar: false,
  prune: true,
  ignore: [
    /^\/src($|\/)/,
    /^\/assets($|\/)/,
    /^\/tests($|\/)/,
    /^\/docs($|\/)/,
    /^\/native($|\/)/,
    /^\/scripts($|\/)/,
    /^\/release($|\/)/,
    /^\/\.git($|\/)/,
    /^\/dist\/demo-library($|\/)/,
    /^\/dist\/native($|\/)/,
    /^\/dist\/(?:tests(?:-.*)?|.*-tests)\.cjs$/,
    /^\/dist\/track-trash-native-smoke\.cjs$/,
    /^\/dist\/organization-(?:.*preview|diagnose)\.cjs$/,
    /^\/dist\/visual-main\.cjs$/,
  ],
  extraResource: [
    path.join(root, 'dist/native'),
    path.join(root, 'THIRD_PARTY_NOTICES.txt'),
    path.join(root, 'docs/third-party'),
    path.join(root, 'dist/demo-library'),
  ],
})
const destination = path.resolve(root, `../DJ Library Organizer ${pkg.version}.app`)
await rm(destination, { recursive: true, force: true })
await cp(path.join(paths[0], 'DJ Library Organizer.app'), destination, {
  recursive: true,
  verbatimSymlinks: true,
})
const demoLoop = path.join(destination, 'Contents/Resources/demo-library/loop')
await rm(demoLoop, { force: true })
await symlink('.', demoLoop)
await validatePortableBundle(destination)
console.log(
  `Packaged local development build: ${destination}\nNot Developer ID signed or notarized. No security settings were changed.`
)

async function validatePortableBundle(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await readlink(file)
      const resolved = path.resolve(directory, target)
      const relative = path.relative(destination, resolved)
      if (path.isAbsolute(target) || relative === '..' || relative.startsWith('..' + path.sep))
        throw new Error(`Nonportable bundle symlink: ${path.relative(destination, file)}`)
    } else if (entry.isDirectory()) await validatePortableBundle(file)
  }
}
