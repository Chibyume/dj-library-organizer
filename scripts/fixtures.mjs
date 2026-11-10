import { mkdir, writeFile, copyFile, symlink, rm } from 'node:fs/promises'
import path from 'node:path'
export function wav({
  title = 'Synthetic Test Tone',
  artist = 'Fixture Artist',
  bpm = '128',
  year = '2008',
  genre = 'Test',
  duration = 2,
  frequency = 220,
} = {}) {
  const rate = 22050
  const samples = Math.floor(rate * duration)
  const audio = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 200, (samples - i) / 200)
    audio.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 1100 * fade),
      i * 2
    )
  }
  const frames = []
  for (const [id, value] of Object.entries({
    TIT2: title,
    TPE1: artist,
    TBPM: bpm,
    TYER: year,
    TCON: genre,
  })) {
    if (!value) continue
    const text = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(value, 'utf16le')])
    const h = Buffer.alloc(10)
    h.write(id)
    h.writeUInt32BE(text.length, 4)
    frames.push(h, text)
  }
  const frameData = Buffer.concat(frames)
  const id3 = Buffer.alloc(10)
  id3.write('ID3')
  id3[3] = 3
  let size = frameData.length
  for (let i = 9; i >= 6; i--) {
    id3[i] = size & 127
    size >>= 7
  }
  const tags = Buffer.concat([id3, frameData])
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(rate, 4)
  fmt.writeUInt32LE(rate * 2, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  function chunk(id, data) {
    const h = Buffer.alloc(8)
    h.write(id)
    h.writeUInt32LE(data.length, 4)
    return Buffer.concat([h, data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])])
  }
  const body = Buffer.concat([
    Buffer.from('WAVE'),
    chunk('fmt ', fmt),
    chunk('data', audio),
    chunk('id3 ', tags),
  ])
  const h = Buffer.alloc(8)
  h.write('RIFF')
  h.writeUInt32LE(body.length, 4)
  return Buffer.concat([h, body])
}
export async function createDemo(root) {
  const examples = [
    ['Luna Mar', 'Bajo Las Luces', '94', '2007', 'Reggaeton'],
    ['Luna Mar', 'Bajo Las Luces — 2024 Remix', '102', '2024', 'Reggaeton'],
    ['Isla Norte', 'Movimiento', '112', '2018', 'Dembow'],
    ['Sol de Medianoche', 'Dos Pasos', '128', '2016', 'Merengue'],
    ['La Costa', 'Otra Noche', '126', '2011', 'Bachata'],
    ['Nia Sol', 'Después de Ti', '82', '2021', 'Latin R&B'],
    ['Club Atlas', 'Side Street', '135', '2023', 'Jersey Club'],
    ['Marble City', 'Low End', '98', '2019', 'Hip Hop'],
    ['Velvet Current', 'Stay Awhile', '76', '2020', 'R&B'],
    ['Mira Vale', 'Electric Sky', '118', '2022', 'Pop'],
    ['North Circuit', 'After Hours', '124', '2025', 'Dance'],
    ['Isla Norte', 'Sin Fecha', '96', '', 'Reggaeton'],
  ]
  await mkdir(root, { recursive: true })
  for (let i = 0; i < examples.length; i++) {
    const [artist, title, bpm, year, genre] = examples[i]
    const dir = path.join(root, i < 6 ? 'Latin' : 'Other')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, `${String(i + 1).padStart(2, '0')} ${title}.wav`),
      wav({
        artist,
        title,
        bpm,
        year,
        genre,
        frequency: 180 + i * 20,
        duration: 3,
      })
    )
  }
  await copyFile(
    path.join(root, 'Latin', '01 Bajo Las Luces.wav'),
    path.join(root, 'Other', 'Bajo Las Luces — extra copy.wav')
  )
  await writeFile(
    path.join(root, 'unfinished.wav.crdownload'),
    Buffer.from('partial download fixture')
  )
  await writeFile(path.join(root, 'unreadable-format.mp3'), Buffer.from('not a valid audio file'))
  const excluded = path.join(root, 'Caches')
  await mkdir(excluded, { recursive: true })
  await writeFile(path.join(excluded, 'excluded.wav'), wav())
  await rm(path.join(root, 'loop'), { force: true })
  try {
    await symlink('.', path.join(root, 'loop'))
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}
