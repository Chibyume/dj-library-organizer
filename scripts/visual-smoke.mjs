// Runs the existing native smoke flow with an isolated synthetic profile, then
// captures presentation states. The production entry point is never modified.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
const phase = process.argv[2] === 'before' ? 'before' : 'after'
const root = process.cwd()
const output = path.resolve(root, '../ui-restyle', phase)
const profile = path.resolve(root, '../../work', `visual-${phase}-profile`)
await mkdir(output, { recursive: true })
await rm(profile, { recursive: true, force: true })
await mkdir(profile, { recursive: true })
await writeFile(path.join(profile, 'research-key.encrypted'), 'synthetic opaque retired credential')
const extra = `
    if (${JSON.stringify(phase)} === "after") {
      const audit = await auditPresentation(win!);
      await writeFile(path.join(${JSON.stringify(output)}, "visual-audit.json"), JSON.stringify(audit, null, 2));
    }

    const out = ${JSON.stringify(output)};
    const settle = () => new Promise(r => setTimeout(r, 450));
    const js = async (code: string) => { try { return await win!.webContents.executeJavaScript(code); } catch(e) { throw new Error(code + String(e)); } };
    const clickText = (text: string) => js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent?.includes(' + JSON.stringify(text) + '))?.click()');
    const shot = async (name: string) => { await settle(); if (${JSON.stringify(phase)} === 'after') { const contrast = await auditContrast(win!); if(contrast.failures.length) throw new Error(name + ' contrast: ' + JSON.stringify(contrast.failures)); } await writeFile(path.join(out, name + '.png'), (await win!.webContents.capturePage()).toPNG()); };
    await js('document.querySelector(".modal-close")?.click()');
    await clickText('New Music');
    await settle();
    await clickText('All Music');
    await settle();
    await shot('library-default');
    await js('document.querySelector("tr[data-track-id]")?.click()');
    await shot('track-details');
    win!.setSize(1100, 700);
    await shot('library-narrow');
    const geometry = await js('({width:innerWidth,bodyWidth:document.body.scrollWidth,rowHeight:document.querySelector("tr[data-track-id]")?.getBoundingClientRect().height,tableWidth:document.querySelector(".track-table")?.getBoundingClientRect().width,viewportWidth:document.querySelector(".table-viewport")?.clientWidth,reviewHeader:Array.from(document.querySelectorAll("th")).find(e=>e.textContent.includes("Review Status"))?.getBoundingClientRect().width})');
    win!.setSize(1480, 920);
    await clickText('Settings & sources');
    await shot('settings');
    await js('document.querySelector(".modal-close")?.click()');
    await js('Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")?.includes("columns"))?.click()');
    await shot('columns');
    await js('document.querySelector(".modal-close")?.click()');
    await clickText('Research genre & year');
    await shot('research');
    await js('document.querySelector(".modal-close")?.click()');
    await clickText('Refresh Rekordbox Library');
    await shot('rekordbox');
    await writeFile(path.join(out, 'geometry.json'), JSON.stringify(geometry, null, 2));
`
const source = (
  'import { auditPresentation, auditContrast } from "../scripts/visual-audit.mjs";\n' +
  (await readFile('src/main.ts', 'utf8'))
).replace('    app.quit();\n  }\n}', extra + '    app.quit();\n  }\n}')
if (!source.includes('const geometry')) throw new Error('Visual smoke insertion failed')
await build({
  stdin: { contents: source, resolveDir: path.join(root, 'src'), loader: 'ts' },
  outfile: 'dist/visual-main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron', 'better-sqlite3', 'music-metadata', 'strtok3'],
})
const child = spawn(
  path.join(root, 'node_modules/.bin/electron'),
  [
    'dist/visual-main.cjs',
    `--test-profile=${profile}`,
    `--smoke-report=${path.join(output, 'native-smoke.json')}`,
  ],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } }
)
const timeout = setTimeout(() => child.kill(), 120000)
const code = await new Promise((resolve, reject) => {
  child.on('error', reject)
  child.on('exit', resolve)
})
clearTimeout(timeout)
await rm('dist/visual-main.cjs', { force: true })
if (code !== 0) throw new Error(`Visual smoke exited ${code}`)
console.log(`Synthetic native UI screenshots: ${output}`)
