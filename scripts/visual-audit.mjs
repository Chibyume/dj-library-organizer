// Presentation-only assertions against the real renderer in the synthetic profile.
// No personal library or live network is used.
const delay = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms))
const ensure = (value, message) => {
  if (!value) throw new Error(`Visual audit: ${message}`)
}
export async function auditContrast(win) {
  return win.webContents.executeJavaScript(
    `(${function () {
      const root = document.querySelector('.modal') || document.body
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const rgb = value => (value.match(/[\d.]+/g) || []).map(Number)
      const mix = (top, bottom) =>
        top.slice(0, 3).map((v, i) => v * (top[3] ?? 1) + bottom[i] * (1 - (top[3] ?? 1)))
      const luminance = values =>
        values
          .map(v => v / 255)
          .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
      const failures = []
      let checked = 0,
        minimum = Infinity
      while (walker.nextNode()) {
        const node = walker.currentNode,
          el = node.parentElement
        if (!node.textContent.trim() || !el || ['STYLE', 'SCRIPT', 'OPTION'].includes(el.tagName))
          continue
        const style = getComputedStyle(el),
          rect = el.getBoundingClientRect()
        if (
          !el.checkVisibility() ||
          rect.bottom <= 0 ||
          rect.top >= innerHeight ||
          rect.right <= 0 ||
          rect.left >= innerWidth
        )
          continue
        if (el.closest('[inert]')) continue
        let parent = el,
          layers = [],
          hidden = false
        while (parent) {
          const ps = getComputedStyle(parent),
            pr = parent.getBoundingClientRect()
          if (
            /(auto|hidden|scroll)/.test(ps.overflow) &&
            (rect.bottom <= pr.top ||
              rect.top >= pr.bottom ||
              rect.left >= pr.right ||
              rect.right <= pr.left)
          )
            hidden = true
          layers.push(rgb(ps.backgroundColor))
          parent = parent.parentElement
        }
        if (hidden) continue
        let background = [21, 21, 21]
        for (const layer of layers.reverse()) background = mix(layer, background)
        const foreground = mix(rgb(style.color), background),
          a = luminance(foreground),
          b = luminance(background)
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        checked++
        minimum = Math.min(minimum, ratio)
        if (ratio < 4.5)
          failures.push({
            text: node.textContent.trim().slice(0, 90),
            ratio,
            color: style.color,
            background,
          })
      }
      return { checked, minimum, failures }
    }.toString()})()`
  )
}
export async function auditPresentation(win) {
  const js = code => win.webContents.executeJavaScript(code)
  const click = text =>
    js(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`
    )
  await js("document.querySelector('.modal-close')?.click()")
  await click('New Music')
  await delay()
  await click('All Music')
  await delay()
  ensure(
    await js("document.querySelector('.review-panel').getBoundingClientRect().width === 0"),
    'empty detail panel must collapse'
  )
  await js("document.querySelector('tr[data-track-id]').click()")
  await delay()
  ensure(
    await js(
      "document.querySelector('.detail-art').getBoundingClientRect().top >= document.querySelector('.review-panel').getBoundingClientRect().top"
    ),
    'new selection must reveal artwork and title'
  )
  await js("document.querySelector('.details-toggle').click()")
  await delay()
  ensure(
    await js(
      "document.querySelector('.review-panel').inert && document.querySelector('.review-panel').getBoundingClientRect().width === 0"
    ),
    'collapsed panel must leave no hidden keyboard targets'
  )
  await js("document.querySelector('.artist-sort').click()")
  await delay()
  ensure(
    await js(
      `(async()=>{ const expected=await window.organizer.list({search:'',view:'all',sort:'artist',direction:'desc',offset:0,limit:500});return document.querySelector('tr[data-track-id]').dataset.trackId===expected.tracks[0].id; })()`
    ),
    'artist header must still sort the actual library'
  )
  await js("document.querySelector('.artist-sort').click()")
  await delay()
  await js("document.querySelector('tr[data-track-id]').click()")
  await delay()
  await js("document.querySelector('.save-button').click()")
  await delay(600)
  ensure(await js("!!document.querySelector('.message.success')"), 'save feedback must appear')
  await delay(4200)
  ensure(
    await js("!document.querySelector('.message.success')"),
    'save feedback must expire after four seconds'
  )
  await click('New Music')
  await delay()
  await click('All Music')
  await delay()
  ensure(
    await js("!document.querySelector('.message.success')"),
    'view changes must not recreate save feedback'
  )
  await js(
    "Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')?.includes('columns')).click()"
  )
  await delay()
  await js(
    "Array.from(document.querySelectorAll('.column-list label')).find(l=>l.textContent==='Title').querySelector('input').click()"
  )
  await delay()
  await js("document.querySelector('.modal-close').click()")
  await delay()
  ensure(
    await js(
      "Array.from(document.querySelectorAll('.sort-button')).some(b=>b.textContent.includes('Artist'))"
    ),
    'artist-only column layout remains available'
  )
  await js(
    "Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')?.includes('columns')).click()"
  )
  await delay()
  await click('Restore Default Columns')
  await delay()
  await js("document.querySelector('.modal-close').click()")
  await delay()
  const geometry = []
  for (const [width, height] of [
    [1480, 920],
    [1100, 700],
  ]) {
    win.setSize(width, height)
    await delay()
    const measurement = await js(
      `(()=>{const view=document.querySelector('.table-viewport');view.scrollLeft=view.scrollWidth;const th=Array.from(document.querySelectorAll('th')).find(e=>e.textContent.includes('Review Status'));const nav=document.querySelector('nav[aria-label="Library views"]');const scroll=document.querySelector('.sidebar-scroll');return {width:innerWidth,bodyWidth:document.body.scrollWidth,rowHeight:document.querySelector('tr[data-track-id]').getBoundingClientRect().height,reviewWidth:th.getBoundingClientRect().width,reviewRight:th.getBoundingClientRect().right,viewportRight:view.getBoundingClientRect().right,sidebarNoOverlap:scroll.getBoundingClientRect().top>=nav.getBoundingClientRect().bottom};})()`
    )
    ensure(measurement.bodyWidth === measurement.width, 'window must not overflow horizontally')
    ensure(
      measurement.rowHeight >= 48 && measurement.rowHeight <= 52,
      'row height must stay within requested range'
    )
    ensure(
      measurement.reviewWidth >= 200 && measurement.reviewRight <= measurement.viewportRight + 1,
      'Review Status must be fully reachable by horizontal scroll'
    )
    ensure(measurement.sidebarNoOverlap, 'category scroll area must not overlap Unavailable')
    geometry.push(measurement)
    await js("document.querySelector('.table-viewport').scrollLeft=0")
  }
  win.setSize(1480, 920)
  await delay()
  const contrast = await auditContrast(win)
  ensure(
    contrast.failures.length === 0,
    `text contrast below 4.5:1: ${JSON.stringify(contrast.failures)}`
  )
  return {
    geometry,
    contrast,
    artistSort: true,
    columnVisibility: true,
    detailCollapse: true,
    detailScrollReset: true,
    saveNoticeExpires: true,
    viewChangesDoNotShowNotice: true,
  }
}
