import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
let text = `THIRD-PARTY NOTICES — DJ Library Organizer ${pkg.version}\n\nThis private development build includes the following runtime dependencies. Full license text follows each entry. Electron/Chromium notices are included separately. Apple frameworks are supplied by macOS; FFmpeg is used only by optional fixture tests and is not bundled.\n`
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev || entry.link) continue
  let pkg
  try {
    pkg = JSON.parse(await readFile(path.join(location, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  text += `\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nDeclared license: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)}\n${pkg.homepage || pkg.repository?.url || ''}\n`
  const files = (await readdir(location)).filter(name =>
    /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)
  )
  for (const file of files) {
    try {
      text += `\n--- ${file} ---\n` + (await readFile(path.join(location, file), 'utf8')) + '\n'
    } catch {}
  }
  if (!files.length) {
    let embedded
    try {
      const readme = await readFile(path.join(location, 'README.md'), 'utf8')
      embedded = readme.match(/(?:^|\n)#+ Licen[cs]e[^\n]*\n([\s\S]*?)(?=\n#+ |$)/i)?.[1]
    } catch {}
    if (!embedded) throw new Error(`Review missing license text: ${pkg.name}`)
    text += '\n--- License section from packaged README.md ---\n' + embedded + '\n'
  }
}
await writeFile('THIRD_PARTY_NOTICES.txt', text)
await mkdir('docs/third-party', { recursive: true })
await copyFile('node_modules/electron/dist/LICENSE', 'docs/third-party/Electron-LICENSE.txt')
await copyFile(
  'node_modules/electron/dist/LICENSES.chromium.html',
  'docs/third-party/Chromium-LICENSES.html'
)
console.log('Recorded runtime dependency licenses and Electron/Chromium notices.')
