import { TagsEditor, TableTags, PlaylistDialog, playlistLabel } from './Organization'
import { TrackTrashDialog } from './TrackTrash'
import { TrashDetails, TrashSelectionActions } from './TrashLibrary'
import type { OrganizationState, LibraryPlaylist } from '../organization-types'
import type { LibraryReviewOverview } from '../library-review-types'
import { AutomationSettings } from './Automation'
import { Preparation } from './Preparation'
import { ResearchSettings, TrackResearch } from './Research'
import packageInfo from '../../package.json'
import { RekordboxConnection } from './RekordboxConnection'
import { ClassificationSettings, TrackClassification } from './Classification'
import { TrackEvidence } from './TrackEvidence'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AudioLines,
  Music2,
  PanelRightClose,
  PanelRightOpen,
  Library,
  Sparkles,
  ListFilter,
  FolderOpen,
  Settings2,
  Search,
  ArrowDown,
  ArrowUp,
  RefreshCw,
  Plus,
  ShieldCheck,
  ChevronRight,
  X,
  Play,
  Pause,
  Volume2,
  FileAudio,
  ExternalLink,
  Check,
  CircleAlert,
  HardDrive,
  FlaskConical,
  SlidersHorizontal,
  Ban,
  Square,
  Link2,
  Download,
  Trash2,
  ListMusic,
  Tags,
  Pencil,
} from 'lucide-react'
import {
  CATEGORY_GROUPS,
  type Category,
  type ClassificationState,
  type LibraryQuery,
  type Playback,
  type ScanProgress,
  type Source,
  type Summary,
  type Track,
} from '../shared'

const api = window.organizer
const EMPTY_SUMMARY: Summary = {
  files: 0,
  trash: 0,
  classified: 0,
  review: 0,
  unavailable: 0,
  bytes: 0,
  lastScan: null,
  categoryCounts: {},
}
const EMPTY_PLAYER: Playback = {
  fileId: null,
  playing: false,
  position: 0,
  duration: 0,
  volume: 0.18,
  error: null,
}
const COLUMN_OPTIONS = [
  ['title', 'Title', 300],
  ['artist', 'Artist', 170],
  ['bpm', 'BPM', 75],
  ['year', 'Tagged Year', 105],
  ['genre', 'Tagged Genre', 140],
  ['category', 'Export genre', 155],
  ['organizationTags', 'Local tags', 240],
  ['review', 'Review Status', 200],
  ['duration', 'Duration', 85],
  ['filename', 'Filename', 240],
  ['availability', 'Availability', 120],
] as const
const INITIAL_COLUMNS = ['artist', 'title', 'bpm', 'organizationTags', 'review']
const COLUMN_MIN: Record<string, number> = {
  title: 260,
  artist: 160,
  bpm: 80,
  year: 120,
  genre: 144,
  category: 160,
  organizationTags: 220,
  review: 200,
  duration: 96,
  filename: 200,
  availability: 136,
}
function missingArtist(artist: string | null | undefined) {
  return !artist?.trim() || artist.trim().toLowerCase() === 'a'
}
function Artwork({ className = '' }: { className?: string }) {
  return (
    <div className={`artwork ${className}`} aria-hidden='true'>
      <Music2 />
    </div>
  )
}
function categoryTone(category: Category) {
  const group = Object.entries(CATEGORY_GROUPS).find(([, entries]) =>
    (entries as readonly string[]).includes(category)
  )?.[0]
  return group === 'LATIN' ? 'latin' : group === 'CLUB & PARTY' ? 'club' : 'hiphop'
}

function tablePreferences(): {
  columns: string[]
  widths: Record<string, number>
} {
  try {
    const saved = JSON.parse(
      localStorage.getItem('table-preferences-v2') ||
        localStorage.getItem('table-preferences-v1') ||
        'null'
    )
    if (!saved || ![1, 2].includes(saved.version)) return { columns: INITIAL_COLUMNS, widths: {} }
    const valid = new Set<string>(COLUMN_OPTIONS.map(c => c[0]))
    const columns = Array.isArray(saved.columns)
      ? [
          ...new Set<string>(
            saved.columns.filter((c: unknown) => typeof c === 'string' && valid.has(c))
          ),
        ]
      : INITIAL_COLUMNS
    if (saved.version === 1 && !columns.includes('organizationTags'))
      columns.push('organizationTags')
    const widths: Record<string, number> = {}
    if (saved.widths && typeof saved.widths === 'object')
      for (const [key, value] of Object.entries(saved.widths)) {
        if (valid.has(key) && typeof value === 'number' && Number.isFinite(value))
          widths[key] = Math.max(COLUMN_MIN[key] || 80, Math.min(600, value))
      }
    return { columns: columns.length ? columns : INITIAL_COLUMNS, widths }
  } catch {
    return { columns: INITIAL_COLUMNS, widths: {} }
  }
}

function bytes(n: number) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < 3) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}
function time(n: number | null) {
  if (n === null) return '—'
  return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`
}
function scanDate(date: string | null) {
  if (!date) return 'not yet completed'
  const d = new Date(date)
  const day =
    d.toDateString() === new Date().toDateString()
      ? 'today'
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${day} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}
function ago(date: string | null | undefined) {
  if (!date) return 'Not yet'
  const d = Math.floor((Date.now() - Date.parse(date)) / 60000)
  return d < 1
    ? 'Just now'
    : d < 60
      ? `${d}m ago`
      : new Date(date).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
}
function statusClass(t: Track) {
  return t.availability !== 'available'
    ? 'danger'
    : t.review === 'Ready for Approval'
      ? 'ready'
      : t.review === 'Excluded'
        ? 'muted'
        : 'pending'
}
function Status({ track }: { track: Track }) {
  return (
    <span className={`status ${track.trash ? 'muted' : statusClass(track)}`}>
      <i />
      {track.trash
        ? track.trash.state === 'in-trash'
          ? 'In macOS Trash'
          : track.trash.state === 'original-kept'
            ? 'Removed · original kept'
            : 'Removed · location unconfirmed'
        : track.availability !== 'available'
          ? track.availability
          : track.preparationReason
            ? `Held: ${track.preparationReason}`
            : track.preparationApproved === false
              ? 'Needs playlist approval'
              : track.review === 'Ready for Approval'
                ? 'Genre assigned'
                : track.review}
    </span>
  )
}

export function App() {
  const [classification, setClassification] = useState<ClassificationState | null>(null)
  const [summary, setSummary] = useState(EMPTY_SUMMARY)
  const [sources, setSources] = useState<Source[]>([])
  const [organization, setOrganization] = useState<OrganizationState>({
    tags: [],
    playlists: [],
    practiceCount: 0,
    unsortedCount: 0,
    taggedCount: 0,
    pending: 0,
  })
  const [reviewOverview, setReviewOverview] = useState<LibraryReviewOverview>({
    total: 0,
    held: 0,
    needsApproval: 0,
    reasons: {},
  })
  const [playlistDestination, setPlaylistDestination] = useState('')
  const [playlistMode, setPlaylistMode] = useState<'create' | 'rename' | 'delete'>('create')
  const [trashChanges, setTrashChanges] = useState<{ id: string; revision: number }[]>([])
  const [trashScope, setTrashScope] = useState<'selected' | 'junk'>('selected')
  const [trashBusy, setTrashBusy] = useState(false)

  const [view, setView] = useState<LibraryQuery['view']>('practice')
  const [value, setValue] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sort, setSort] = useState('artist')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [tracks, setTracks] = useState<Track[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [selection, setSelection] = useState<{
    ids: Set<string>
    activeId: string | null
  }>(() => ({ ids: new Set(), activeId: null }))
  const selected = selection.ids
  const activeId = selection.activeId
  const setSelected = useCallback(
    (next: Set<string> | ((previous: Set<string>) => Set<string>)) => {
      setSelection(previous => {
        const ids = typeof next === 'function' ? next(previous.ids) : next
        return {
          ids,
          activeId:
            previous.activeId && ids.has(previous.activeId)
              ? previous.activeId
              : ids.values().next().value || null,
        }
      })
    },
    []
  )
  const setActiveId = useCallback(
    (id: string | null) => setSelection(previous => ({ ...previous, activeId: id })),
    []
  )
  const [player, setPlayer] = useState(EMPTY_PLAYER)
  const [nowPlaying, setNowPlaying] = useState<Track | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)
  const [modal, setModal] = useState<
    | 'settings'
    | 'columns'
    | 'xml'
    | 'scan'
    | 'classification'
    | 'research'
    | 'preparation'
    | 'playlist'
    | 'trash'
    | null
  >(null)
  const [columns, setColumns] = useState<string[]>(() => tablePreferences().columns)
  const [widths, setWidths] = useState<Record<string, number>>(() => tablePreferences().widths)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const latestRequest = useRef(0)
  const anchor = useRef<number | null>(null)
  const selectedTracks = useMemo(() => tracks.filter(t => selected.has(t.id)), [tracks, selected])
  const active = tracks.find(t => t.id === activeId) || null
  const scanning = summary.lastScan?.status === 'running'
  const shownColumns = COLUMN_OPTIONS.filter(
    c =>
      (columns.includes(c[0]) || (view === 'trash' && c[0] === 'review')) &&
      !(c[0] === 'artist' && columns.includes('title'))
  )
  const columnWidth = (c: (typeof COLUMN_OPTIONS)[number]) =>
    Math.max(COLUMN_MIN[c[0]] || 80, widths[c[0]] || c[2])
  function sortBy(key: LibraryQuery['sort']) {
    if (sort === key) setDirection(d => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSort(key)
      setDirection('asc')
    }
  }
  const virtual = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 52,
    overscan: 12,
    getItemKey: i => tracks[i]?.id || i,
  })
  const items = virtual.getVirtualItems()
  const top = items[0]?.start || 0
  const bottom = tracks.length ? virtual.getTotalSize() - (items.at(-1)?.end || 0) : 0
  const refresh = useCallback(async () => {
    const [s, r, c, o, review] = await Promise.all([
      api.summary(),
      api.sources(),
      api.classificationState(),
      api.organizationState(),
      api.libraryReviewOverview(),
    ])
    setClassification(c)
    setSummary(s)
    setSources(r)
    setOrganization(o)
    setReviewOverview(review)
  }, [])
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await fn()
        await refresh()
        setGeneration(n => n + 1)
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong.')
        return false
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )
  useEffect(() => {
    try {
      localStorage.setItem('table-preferences-v2', JSON.stringify({ version: 2, columns, widths }))
    } catch {
      /* A full profile must not prevent browsing. */
    }
  }, [columns, widths])
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 180)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    void refresh().catch(e => setError(e.message))
    return api.onChange(event => {
      if (event.kind === 'duplicate-progress') return
      if (event.xmlProgress && ['finding', 'reading', 'matching'].includes(event.xmlProgress.phase))
        return
      if (event.progress) setSummary(s => ({ ...s, lastScan: event.progress! }))
      if (event.kind !== 'scan' || event.progress?.status !== 'running') {
        void refresh().catch(e => setError(e.message))
        setGeneration(n => n + 1)
      } else if (event.progress && event.progress.audio % 10 === 0) {
        setGeneration(n => n + 1)
      }
    })
  }, [refresh])
  useEffect(() => {
    setPage(0)
    setSelected(new Set())
    setActiveId(null)
    anchor.current = null
  }, [view, value, debounced, sort, direction])
  useEffect(() => {
    const request = ++latestRequest.current
    setLoading(true)
    void api
      .list({
        search: debounced,
        view,
        value,
        sort,
        direction,
        offset: page * 500,
        limit: 500,
      })
      .then(result => {
        if (request !== latestRequest.current) return
        setTracks(result.tracks)
        setTotal(result.total)
        setSelected(old => new Set([...old].filter(id => result.tracks.some(t => t.id === id))))
        setLoading(false)
      })
      .catch(e => {
        if (request === latestRequest.current) {
          setError(e.message)
          setLoading(false)
        }
      })
    return () => {
      latestRequest.current++
    }
  }, [debounced, view, value, sort, direction, page, generation])
  useEffect(() => {
    if (!player.playing) return
    let stopped = false
    const timer = setInterval(() => {
      void api
        .playback('status')
        .then(p => {
          if (!stopped) setPlayer(p)
        })
        .catch(e => {
          if (!stopped) {
            setError(e.message)
            setPlayer(p => ({ ...p, playing: false }))
          }
        })
    }, 300)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [player.playing])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    setNotice(null)
  }, [view, value, debounced])
  useEffect(() => {
    setDetailsOpen(Boolean(activeId))
    document.getElementById('track-details')?.scrollTo({ top: 0 })
  }, [activeId])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
        event.preventDefault()
        searchInput.current?.focus()
      }
      if (event.key === 'Escape' && !trashBusy) setModal(null)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [trashBusy])
  useEffect(() => {
    if (!modal) return
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled),input,select')?.focus()
    return () => previous?.focus()
  }, [modal])
  function navigate(next: LibraryQuery['view'], nextValue = '') {
    setError(null)
    setView(next)
    setValue(nextValue)
    setSearch('')
  }
  function choose(t: Track, index: number, extend: boolean, toggle: boolean) {
    const previousAnchor = anchor.current
    if (!extend) anchor.current = index
    const range =
      extend && previousAnchor !== null
        ? tracks
            .slice(Math.min(index, previousAnchor), Math.max(index, previousAnchor) + 1)
            .map(track => track.id)
        : null
    setSelection(previous => {
      const next = range
        ? new Set([...previous.ids, ...range])
        : toggle
          ? new Set(previous.ids)
          : new Set<string>()
      if (!range) {
        if (toggle && next.has(t.id)) next.delete(t.id)
        else next.add(t.id)
      }
      return {
        ids: next,
        activeId: next.has(t.id) ? t.id : tracks.find(track => next.has(track.id))?.id || null,
      }
    })
  }
  async function load(t: Track, play = false) {
    if (view === 'trash') return
    try {
      const p = await api.playback('load', t.id)
      setNowPlaying(t)
      setPlayer(play ? await api.playback('play') : p)
    } catch (e) {
      setPlayer(p => ({ ...p, playing: false }))
      setError(e instanceof Error ? e.message : 'Preview unavailable')
    }
  }
  function resize(event: React.PointerEvent, key: string, startWidth: number) {
    event.preventDefault()
    const start = event.clientX
    const move = (e: PointerEvent) =>
      setWidths(w => ({
        ...w,
        [key]: Math.max(COLUMN_MIN[key] || 80, Math.min(600, startWidth + e.clientX - start)),
      }))
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
  }
  const currentPlaylist =
    view === 'playlist' ? organization.playlists.find(p => p.id === value) : undefined
  const directPlaylistExport = view === 'practice' || view === 'tag' || view === 'playlist'
  const isJunk = view === 'category' && value === '_JUNK'
  const junkCount = summary.categoryCounts._JUNK || 0
  const title =
    view === 'playlist'
      ? currentPlaylist?.name || 'Playlist'
      : view === 'practice'
        ? value === 'unsorted'
          ? 'Unsorted'
          : value || 'All Practice Tracks'
        : view === 'tag'
          ? value.slice(value.indexOf(':') + 1)
          : view === 'category'
            ? isJunk
              ? 'Junk'
              : value
            : view === 'source'
              ? sources.find(s => s.id === value)?.label || 'Source'
              : (
                  {
                    all: 'All Music',
                    new: 'Recently Added',
                    review: 'Review',
                    unavailable: 'Unavailable',
                    trash: 'Trash',
                  } as Record<string, string>
                )[view] || 'All Music'
  const genreCounts = organization.tags.filter(t => t.group === 'genre')
  const playlists = organization.playlists.filter(p => p.kind === 'playlist')
  function renderPlaylists(parentId: string | null, depth = 0): React.ReactNode {
    return organization.playlists
      .filter(p => p.parentId === parentId)
      .map(p => (
        <div key={p.id} style={{ paddingLeft: depth ? 12 : 0 }}>
          <Nav
            icon={p.kind === 'folder' ? <FolderOpen size={16} /> : <ListMusic size={16} />}
            label={p.name}
            count={p.count}
            active={view === 'playlist' && value === p.id}
            onClick={() => navigate('playlist', p.id)}
            playlistId={p.id}
          />
          {p.kind === 'folder' && depth < 8 ? renderPlaylists(p.id, depth + 1) : null}
        </div>
      ))
  }
  const selectedChanges = selectedTracks.map(t => ({
    id: t.id,
    revision: t.revision,
  }))
  return (
    <div className='app-shell'>
      <aside className='sidebar'>
        <div className='drag-title'>
          <span className='version'>LOCAL / {packageInfo.version}</span>
        </div>
        <div className='brand'>
          <div className='brand-icon'>
            <AudioLines size={23} />
          </div>
          <div>
            DJ Library<span>ORGANIZER</span>
          </div>
        </div>
        <div className='sidebar-scroll'>
          <section className='sidebar-section'>
            <div className='sidebar-heading'>MY LIBRARY</div>
            <nav aria-label='Library views'>
              <Nav
                icon={<Library size={17} />}
                label='All Music'
                count={summary.files}
                active={view === 'all'}
                onClick={() => navigate('all')}
                viewId='all'
              />
              <Nav
                icon={<Sparkles size={17} />}
                label='Recently Added'
                active={view === 'new'}
                onClick={() => navigate('new')}
                viewId='new'
              />
              <Nav
                icon={<ListFilter size={17} />}
                label='Review'
                count={reviewOverview.total}
                active={view === 'review'}
                onClick={() => navigate('review', 'all')}
                viewId='review'
              />
              <Nav
                icon={<Ban size={16} />}
                label='Junk'
                count={junkCount}
                active={isJunk}
                viewId='junk'
                onClick={() => navigate('category', '_JUNK')}
              />
              <Nav
                icon={<Trash2 size={16} />}
                label='Trash'
                count={summary.trash}
                active={view === 'trash'}
                viewId='trash'
                onClick={() => navigate('trash')}
              />
            </nav>
          </section>
          <section className='sidebar-section' aria-label='Practice library'>
            <div className='sidebar-heading'>PRACTICE LIBRARY</div>
            <Nav
              icon={<Music2 size={17} />}
              label='All Practice Tracks'
              count={organization.practiceCount}
              active={view === 'practice' && !value}
              onClick={() => navigate('practice')}
              viewId='practice'
            />
            <details className='practice-genres'>
              <summary>
                <ChevronRight size={15} />
                Genres <span>{genreCounts.length}</span>
              </summary>
              {genreCounts.map(tag => (
                <Nav
                  key={tag.value}
                  icon={<i className='category-dot club' />}
                  label={tag.value}
                  count={tag.count}
                  active={view === 'practice' && value === tag.value}
                  onClick={() => navigate('practice', tag.value)}
                />
              ))}
            </details>
            <Nav
              icon={<CircleAlert size={16} />}
              label='Unsorted'
              count={organization.unsortedCount}
              active={view === 'practice' && value === 'unsorted'}
              onClick={() => navigate('practice', 'unsorted')}
            />
          </section>
          <section className='sidebar-section' aria-label='My playlists'>
            <div className='sidebar-heading sources-heading'>
              MY PLAYLISTS
              <button
                id='playlist-new'
                aria-label='Create playlist or folder'
                onClick={() => {
                  setPlaylistMode('create')
                  setModal('playlist')
                }}
              >
                <Plus size={15} />
              </button>
            </div>
            {renderPlaylists(null)}
            {!organization.playlists.length ? (
              <p className='sidebar-empty'>
                Create a playlist, then add songs from any library view.
              </p>
            ) : null}
          </section>
          <section className='sidebar-section' aria-label='Preparation'>
            <div className='sidebar-heading'>PREPARATION</div>
            <Nav
              icon={<Tags size={16} />}
              label='Tools & Samples'
              active={view === 'tag' && value === 'use:Tools & Samples'}
              onClick={() => navigate('tag', 'use:Tools & Samples')}
            />
            <Nav
              icon={<AudioLines size={16} />}
              label='Full Mixes'
              active={view === 'tag' && value === 'use:Full Mix'}
              onClick={() => navigate('tag', 'use:Full Mix')}
            />
            <Nav
              icon={<HardDrive size={17} />}
              label='Unavailable'
              count={summary.unavailable}
              active={view === 'unavailable'}
              onClick={() => navigate('unavailable')}
            />
          </section>
          <section className='sidebar-section' aria-label='Sources'>
            <div className='sidebar-heading'>SOURCES</div>
            {sources.map(source => (
              <Nav
                key={source.id}
                icon={<FolderOpen size={16} />}
                label={source.label}
                count={source.fileCount}
                active={view === 'source' && value === source.id}
                onClick={() => navigate('source', source.id)}
              />
            ))}
          </section>
        </div>
        <div className='sidebar-footer'>
          <button onClick={() => setModal('xml')}>
            <Link2 size={16} /> Refresh Rekordbox Library
          </button>
          <button onClick={() => setModal('settings')}>
            <Settings2 size={16} /> Settings & sources
          </button>
          <div className='local-badge'>
            <ShieldCheck size={14} />
            Local-first · Review & cleanup
          </div>
        </div>
      </aside>
      <main className='workspace'>
        <div className='window-bar'>
          <span>
            <i /> YOUR MUSIC. YOUR MAC.
          </span>
          <div>
            <ShieldCheck size={13} />
            LOCAL LIBRARY MODE
            <span className='safety-copy'>Original files stay untouched.</span>
          </div>
        </div>
        <header className='library-header'>
          <div>
            <div className='eyebrow'>MUSIC LIBRARY</div>
            <h1>
              {title}
              <span>{total.toLocaleString()}</span>
            </h1>
            <p>
              {view === 'trash'
                ? 'Files moved to macOS Trash by this app, including earlier duplicate cleanup. Select songs to restore them.'
                : isJunk
                  ? 'Every song assigned to Junk. Move all Junk to macOS Trash in one batch, or select individual songs below.'
                  : sources.some(s => s.demo)
                    ? sources.every(s => s.demo)
                      ? 'Synthetic demo tones · no personal music was scanned'
                      : 'Includes synthetic demo tones alongside your selected sources'
                    : view === 'practice'
                      ? 'Every available track stays accessible for practice. Genre playlists update from local tags.'
                      : view === 'playlist'
                        ? 'Your selections reference the original files. Removing a playlist entry keeps the song in your library.'
                        : view === 'review'
                          ? 'The same held tracks and approval decisions used by Rekordbox preparation, in one place.'
                          : 'Browse your music, search tags, and add songs to your playlists.'}
            </p>
          </div>
          <div className='header-actions'>
            {isJunk ? (
              <button
                id='track-trash-all-junk'
                className='button secondary danger-text'
                disabled={busy || scanning || !junkCount}
                onClick={() => {
                  setTrashScope('junk')
                  setTrashChanges([])
                  setModal('trash')
                }}
              >
                <Trash2 size={16} /> Move all Junk to Trash
              </button>
            ) : null}
            {view !== 'trash' && !isJunk ? (
              <>
                <button
                  className='button accent'
                  aria-label={
                    directPlaylistExport ? 'Export current playlist' : 'Prepare for rekordbox'
                  }
                  disabled={busy || scanning || !summary.files}
                  onClick={() =>
                    directPlaylistExport
                      ? void run(async () => {
                          const result = await api.playlistExport(
                            view === 'playlist'
                              ? value
                              : {
                                  view: view as 'practice' | 'tag',
                                  value: value || undefined,
                                }
                          )
                          if (result)
                            setNotice(
                              `Saved ${result.tracks} playlist entries. Import the M3U8 playlist in Rekordbox.`
                            )
                        })
                      : setModal('preparation')
                  }
                >
                  <Download size={16} />{' '}
                  {directPlaylistExport ? 'Export playlist' : 'Prepare for rekordbox'}
                </button>
                <button
                  className='button secondary'
                  disabled={busy || scanning || !sources.length}
                  onClick={() => void run(() => api.scan('smart'))}
                >
                  <RefreshCw size={15} className={scanning ? 'spin' : ''} />
                  Smart Scan
                </button>
              </>
            ) : view === 'trash' ? (
              <span className='field-help'>
                Select songs to restore them. Nothing is permanently deleted.
              </span>
            ) : null}
          </div>
        </header>
        {error ? (
          <div className='message error' role='alert'>
            <CircleAlert size={17} />
            <span>{error}</span>
            <button aria-label='Dismiss error' onClick={() => setError(null)}>
              <X size={15} />
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className='message success' role='status'>
            <Check size={17} />
            <span>{notice}</span>
            <button aria-label='Dismiss notice' onClick={() => setNotice(null)}>
              <X size={15} />
            </button>
          </div>
        ) : null}
        {organization.pending ? (
          <div className='organization-status' role='status'>
            Organizing local tags · {organization.pending} remaining
          </div>
        ) : null}
        {view === 'review' ? (
          <div className='review-filter-bar'>
            <label htmlFor='review-filter'>Show</label>
            <select
              id='review-filter'
              value={value || 'all'}
              onChange={e => navigate('review', e.target.value)}
            >
              <option value='all'>All review items ({reviewOverview.total})</option>
              <option value='held'>Held for review ({reviewOverview.held})</option>
              <option value='approval'>
                Needs playlist approval ({reviewOverview.needsApproval})
              </option>
              {Object.entries(reviewOverview.reasons).map(([reason, count]) => (
                <option key={reason} value={reason}>
                  {reason} ({count})
                </option>
              ))}
            </select>
            <button
              className='button secondary compact'
              aria-label='Online research'
              onClick={() => setModal('research')}
            >
              Research selected tracks
            </button>
          </div>
        ) : null}
        {currentPlaylist ? (
          <div className='playlist-heading-actions'>
            <span>
              {currentPlaylist.kind === 'folder'
                ? 'Folder · includes songs in its playlists'
                : 'Custom playlist'}
            </span>
            <button
              className='text-button'
              onClick={() => {
                setPlaylistMode('rename')
                setModal('playlist')
              }}
            >
              <Pencil size={14} />
              Rename
            </button>
            <button
              className='text-button'
              onClick={() => {
                setPlaylistMode('delete')
                setModal('playlist')
              }}
            >
              Delete {currentPlaylist.kind}
            </button>
          </div>
        ) : null}
        <div className='library-toolbar'>
          <label className='search'>
            <Search size={17} />
            <input
              ref={searchInput}
              aria-label='Search music and tags'
              type='search'
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder='Search songs, artists, filenames or tags…'
            />
            <kbd>⌘ F</kbd>
          </label>
          <div className='toolbar-right'>
            {view !== 'trash' ? (
              <select
                className='tag-filter'
                aria-label='Browse by tag'
                value={view === 'tag' ? value : ''}
                onChange={e =>
                  e.target.value ? navigate('tag', e.target.value) : navigate('practice')
                }
              >
                <option value=''>Browse tags…</option>
                {organization.tags.map(tag => (
                  <option key={`${tag.group}:${tag.value}`} value={`${tag.group}:${tag.value}`}>
                    {tag.group}: {tag.value} ({tag.count})
                  </option>
                ))}
              </select>
            ) : null}
            <span className='track-count'>
              {loading ? 'Loading…' : `${total.toLocaleString()} files`}
            </span>
            <button
              className='icon-button'
              aria-label='Choose table columns'
              onClick={() => setModal('columns')}
            >
              <SlidersHorizontal size={17} />
            </button>
            <button
              className={`icon-button details-toggle ${detailsOpen ? 'active' : ''}`}
              aria-label={detailsOpen ? 'Hide track details' : 'Show track details'}
              aria-expanded={detailsOpen}
              aria-controls='track-details'
              onClick={() => setDetailsOpen(open => !open)}
            >
              {detailsOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
            </button>
          </div>
        </div>
        {selected.size ? (
          <div className='selection-toolbar' aria-label='Selected track actions'>
            <strong>{selected.size} selected</strong>
            {view === 'trash' ? (
              <TrashSelectionActions
                tracks={selectedTracks}
                busy={busy}
                run={run}
                onResult={result =>
                  setNotice(`${result.restored} restored · ${result.failed} need attention`)
                }
              />
            ) : (
              <>
                <select
                  id='playlist-destination'
                  aria-label='Destination playlist'
                  value={playlistDestination}
                  onChange={e => setPlaylistDestination(e.target.value)}
                >
                  <option value=''>Add to playlist…</option>
                  {playlists.map(p => (
                    <option key={p.id} value={p.id}>
                      {playlistLabel(p, organization.playlists)}
                    </option>
                  ))}
                </select>
                <button
                  id='playlist-add-selected'
                  className='button secondary compact'
                  disabled={busy || !playlistDestination}
                  onClick={() =>
                    void run(() =>
                      api.playlistMembers({
                        id: playlistDestination,
                        ids: [...selected],
                        action: 'add',
                      })
                    )
                  }
                >
                  Add selected
                </button>
                {currentPlaylist?.kind === 'playlist' ? (
                  <button
                    id='playlist-remove-selected'
                    className='button secondary compact'
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api.playlistMembers({
                          id: currentPlaylist.id,
                          ids: [...selected],
                          action: 'remove',
                        })
                      )
                    }
                  >
                    Remove from playlist
                  </button>
                ) : null}
                <button
                  className='button secondary compact'
                  disabled={busy}
                  onClick={() => setDetailsOpen(true)}
                >
                  <Tags size={14} />
                  Edit tags
                </button>
                <button
                  id='track-trash-selected'
                  className='button secondary compact danger-text'
                  disabled={busy}
                  onClick={() => {
                    setTrashScope('selected')
                    setTrashChanges(selectedChanges)
                    setModal('trash')
                  }}
                >
                  <Trash2 size={14} />
                  Move to Trash
                </button>
              </>
            )}
          </div>
        ) : null}
        <div className='library-content'>
          <section className='table-section' aria-label='Track library'>
            {!summary.files && !scanning && view !== 'trash' ? (
              <div className='empty-library'>
                <div className='empty-icon'>
                  <AudioLines size={36} />
                </div>
                <div className='eyebrow'>A CLEARER COLLECTION STARTS HERE</div>
                <h2>Bring your scattered music together.</h2>
                <p>
                  Discover accessible music across your Mac.
                  <br />
                  Listen, edit local tags, and build playlists without changing an audio file.
                </p>
                <button
                  className='button accent'
                  disabled={busy}
                  onClick={() => void run(() => api.discover())}
                >
                  <Search size={16} />
                  Discover My Music
                </button>
                <button
                  className='demo-button'
                  disabled={busy}
                  onClick={() => void run(() => api.demo())}
                >
                  <FlaskConical size={15} />
                  Explore a synthetic demo library
                  <ChevronRight size={14} />
                </button>
                <div className='empty-footnote'>
                  <ShieldCheck size={14} />
                  No account. No upload. Your audio stays untouched.
                </div>
              </div>
            ) : (
              <>
                <div className='table-viewport' ref={viewport}>
                  <table
                    role='grid'
                    aria-rowcount={total + 1}
                    aria-colcount={shownColumns.length + 1}
                    className='track-table'
                    style={{
                      width: shownColumns.reduce((n, c) => n + columnWidth(c), 104),
                    }}
                    aria-label='Music files'
                  >
                    <colgroup>
                      <col style={{ width: 44 }} />
                      <col style={{ width: 60 }} />
                      {shownColumns.map(c => (
                        <col key={c[0]} style={{ width: columnWidth(c) }} />
                      ))}
                    </colgroup>
                    <thead>
                      <tr>
                        <th className='checkbox-cell'>
                          <input
                            type='checkbox'
                            aria-label='Select all files on this page'
                            checked={tracks.length > 0 && selected.size === tracks.length}
                            onChange={e => {
                              setSelected(
                                e.target.checked ? new Set(tracks.map(t => t.id)) : new Set()
                              )
                              if (e.target.checked) setActiveId(tracks[0]?.id || null)
                            }}
                          />
                        </th>
                        <th className='artwork-cell'>
                          <span className='sr-only'>Artwork</span>
                        </th>
                        {shownColumns.map(c => (
                          <th
                            key={c[0]}
                            className={c[0] === 'review' ? 'review-cell' : undefined}
                            aria-sort={
                              sort === c[0]
                                ? direction === 'asc'
                                  ? 'ascending'
                                  : 'descending'
                                : 'none'
                            }
                          >
                            <div className='column-heading'>
                              {c[0] === 'organizationTags' ? (
                                <span className='column-label'>{c[1]}</span>
                              ) : (
                                <button className='sort-button' onClick={() => sortBy(c[0])}>
                                  {view === 'trash' && c[0] === 'review' ? 'Trash status' : c[1]}
                                  {sort === c[0] ? (
                                    direction === 'asc' ? (
                                      <ArrowUp size={12} />
                                    ) : (
                                      <ArrowDown size={12} />
                                    )
                                  ) : null}
                                </button>
                              )}
                              {c[0] === 'title' && columns.includes('artist') ? (
                                <button
                                  className='sort-button artist-sort'
                                  aria-label={`Sort by Artist${sort === 'artist' ? `, ${direction === 'asc' ? 'ascending' : 'descending'}` : ''}`}
                                  onClick={() => sortBy('artist')}
                                >
                                  Artist{' '}
                                  {sort === 'artist' ? (
                                    direction === 'asc' ? (
                                      <ArrowUp size={12} />
                                    ) : (
                                      <ArrowDown size={12} />
                                    )
                                  ) : null}
                                </button>
                              ) : null}
                            </div>
                            <button
                              className='resize-handle'
                              aria-label={`Resize ${c[1]} column`}
                              onPointerDown={e => resize(e, c[0], columnWidth(c))}
                              onKeyDown={e => {
                                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                                  e.preventDefault()
                                  setWidths(w => ({
                                    ...w,
                                    [c[0]]: Math.max(
                                      COLUMN_MIN[c[0]] || 80,
                                      columnWidth(c) + (e.key === 'ArrowRight' ? 15 : -15)
                                    ),
                                  }))
                                }
                              }}
                            />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {top > 0 ? (
                        <tr aria-hidden='true'>
                          <td
                            colSpan={shownColumns.length + 2}
                            style={{ height: top, padding: 0, border: 0 }}
                          />
                        </tr>
                      ) : null}
                      {items.map(item => {
                        const t = tracks[item.index]!
                        return (
                          <tr
                            key={t.id}
                            data-track-id={t.id}
                            aria-rowindex={page * 500 + item.index + 2}
                            className={selected.has(t.id) ? 'selected' : ''}
                            aria-selected={selected.has(t.id)}
                            tabIndex={activeId === t.id || (!activeId && item.index === 0) ? 0 : -1}
                            onClick={e => choose(t, item.index, e.shiftKey, e.metaKey || e.ctrlKey)}
                            onDoubleClick={() => {
                              if (view !== 'trash') void load(t, true)
                            }}
                            onKeyDown={e => {
                              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                e.preventDefault()
                                const index = Math.max(
                                  0,
                                  Math.min(
                                    tracks.length - 1,
                                    item.index + (e.key === 'ArrowDown' ? 1 : -1)
                                  )
                                )
                                const next = tracks[index]!
                                choose(next, index, e.shiftKey, false)
                                virtual.scrollToIndex(index)
                                requestAnimationFrame(() =>
                                  viewport.current
                                    ?.querySelector<HTMLElement>(`[data-track-id="${next.id}"]`)
                                    ?.focus()
                                )
                              } else if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                if (view !== 'trash') void load(t, true)
                              } else if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
                                e.preventDefault()
                                setSelected(new Set(tracks.map(x => x.id)))
                              }
                            }}
                          >
                            <td className='checkbox-cell'>
                              <input
                                type='checkbox'
                                checked={selected.has(t.id)}
                                aria-label={`Select ${t.title || t.filename}`}
                                onClick={e => e.stopPropagation()}
                                onChange={() => choose(t, item.index, false, true)}
                              />
                            </td>
                            <td className='artwork-cell'>
                              <Artwork />
                            </td>
                            {shownColumns.map(c => (
                              <td
                                key={c[0]}
                                className={
                                  c[0] === 'review'
                                    ? 'review-cell'
                                    : c[0] === 'title'
                                      ? 'title-cell'
                                      : c[0] === 'bpm' || c[0] === 'year' || c[0] === 'duration'
                                        ? 'numeric'
                                        : ''
                                }
                                title={c[0] === 'title' ? t.title || t.filename : undefined}
                              >
                                {c[0] === 'review' ? (
                                  <Status track={t} />
                                ) : c[0] === 'category' ? (
                                  t.category ? (
                                    <span className={`category-tag ${categoryTone(t.category)}`}>
                                      {t.category}
                                    </span>
                                  ) : (
                                    <span className='unknown'>Unclassified</span>
                                  )
                                ) : c[0] === 'duration' ? (
                                  time(t.duration)
                                ) : c[0] === 'title' ? (
                                  <div className='track-name'>
                                    <span className={t.title ? 'track-title' : 'filename-title'}>
                                      {t.title || t.filename}
                                    </span>
                                    {columns.includes('artist') ? (
                                      <span
                                        className={
                                          missingArtist(t.artist)
                                            ? 'track-artist missing-artist'
                                            : 'track-artist'
                                        }
                                      >
                                        {missingArtist(t.artist) ? 'Missing artist' : t.artist}
                                      </span>
                                    ) : null}
                                  </div>
                                ) : c[0] === 'organizationTags' ? (
                                  <TableTags track={t} />
                                ) : c[0] === 'artist' && missingArtist(t.artist) ? (
                                  <span className='missing-artist'>Missing artist</span>
                                ) : (
                                  <span
                                    className={t[c[0]] === null || t[c[0]] === '' ? 'unknown' : ''}
                                  >
                                    {t[c[0]] === null || t[c[0]] === '' ? '—' : t[c[0]]}
                                  </span>
                                )}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                      {bottom > 0 ? (
                        <tr aria-hidden='true'>
                          <td
                            colSpan={shownColumns.length + 2}
                            style={{ height: bottom, padding: 0, border: 0 }}
                          />
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                  {tracks.length === 0 ? (
                    <div className='no-results'>
                      <Search size={24} />
                      <h3>{scanning ? 'Discovering your files…' : 'No matching files'}</h3>
                      <p>
                        {scanning
                          ? 'Tracks appear as they are inspected.'
                          : 'Try another search, source, or category.'}
                      </p>
                    </div>
                  ) : null}
                </div>
                <div className='table-footer'>
                  <span>
                    {selected.size ? `${selected.size} selected · ` : ''}
                    {total
                      ? `${page * 500 + 1}–${Math.min(total, (page + 1) * 500)} of ${total.toLocaleString()}`
                      : '0 files'}
                    <span className='footer-hint'>
                      {view === 'trash'
                        ? 'Select to inspect removal and recovery details'
                        : 'Double-click to preview'}
                    </span>
                  </span>
                  {total > 500 ? (
                    <div>
                      <button
                        disabled={page === 0}
                        onClick={() => {
                          setPage(p => p - 1)
                          setSelected(new Set())
                        }}
                      >
                        Previous
                      </button>
                      <button
                        disabled={(page + 1) * 500 >= total}
                        onClick={() => {
                          setPage(p => p + 1)
                          setSelected(new Set())
                        }}
                      >
                        Next
                      </button>
                    </div>
                  ) : (
                    <span className='offline-label'>
                      <i />
                      Offline ready
                    </span>
                  )}
                </div>
              </>
            )}
          </section>
          <aside
            id='track-details'
            className={`review-panel ${detailsOpen ? '' : 'collapsed'}`}
            aria-label='Track details'
            inert={!detailsOpen}
          >
            <div className='review-panel-content'>
              <div className='panel-header'>
                <span>TRACK DETAILS</span>
                <button
                  className='icon-button'
                  aria-label='Collapse track details'
                  onClick={() => setDetailsOpen(false)}
                >
                  <PanelRightClose size={15} />
                </button>
              </div>
              {active ? (
                <>
                  <div className='selected-track'>
                    <Artwork className='detail-art' />
                    <h2>{active.title || active.filename}</h2>
                    <p className={missingArtist(active.artist) ? 'missing-artist' : undefined}>
                      {missingArtist(active.artist) ? 'Missing artist' : active.artist}
                    </p>
                    <Status track={active} />
                  </div>
                  <div className='panel-divider' />
                  <div className='detail-facts'>
                    <Fact label='BPM' value={active.bpm?.toString() || '—'} />
                    <Fact label='Tagged Year' value={active.year?.toString() || '—'} />
                    <Fact label='Duration' value={time(active.duration)} />
                    <Fact label='Musical key' value={active.key || '—'} />
                  </div>
                  <p className='evidence-note'>
                    BPM and tagged year come from embedded tags. Research and confirmed
                    recording/version years are shown separately below.
                  </p>
                  {view === 'trash' ? (
                    <TrashDetails track={active} />
                  ) : (
                    <>
                      <TrackResearch
                        key={`research-${active.id}`}
                        track={active}
                        generation={generation}
                        run={run}
                        busy={busy}
                        onOpen={() => setModal('research')}
                      />
                      <TagsEditor
                        key={active.id}
                        active={active}
                        tracks={selectedTracks}
                        generation={generation}
                        busy={busy}
                        run={run}
                      />
                      {view === 'review' ? (
                        <section className='panel-section'>
                          <div className='field-label'>REVIEW DECISION</div>
                          <p>
                            {active.preparationReason ||
                              'This track is eligible and needs playlist approval.'}
                          </p>
                          <p className='field-help'>
                            Use the genre tags above to correct a placement. Approval is completed
                            in Prepare for rekordbox.
                          </p>
                          <TrackClassification
                            key={active.id}
                            track={active}
                            generation={generation}
                            run={run}
                            busy={busy}
                          />
                          <div className='review-actions'>
                            <button
                              disabled={busy || !selectedTracks.length}
                              onClick={() => void run(() => api.review(selectedChanges, 'review'))}
                            >
                              Keep in Review
                            </button>
                            <button
                              disabled={busy || !selectedTracks.length}
                              onClick={() => void run(() => api.review(selectedChanges, 'exclude'))}
                            >
                              Exclude from prepared export
                            </button>
                          </div>
                        </section>
                      ) : null}
                    </>
                  )}
                  <div className='panel-section'>
                    <div className='field-label'>FILE & SOURCE</div>
                    <dl className='file-details'>
                      <dt>Genre</dt>
                      <dd>{active.genre || '—'}</dd>
                      <dt>Format</dt>
                      <dd>{active.format || '—'}</dd>
                      <dt>Sample rate</dt>
                      <dd>
                        {active.sampleRate ? `${(active.sampleRate / 1000).toFixed(1)} kHz` : '—'}
                      </dd>
                      <dt>Bitrate</dt>
                      <dd>{active.bitrate ? `${Math.round(active.bitrate / 1000)} kbps` : '—'}</dd>
                      <dt>Size</dt>
                      <dd>{bytes(active.size)}</dd>
                      <dt>Availability</dt>
                      <dd>{active.availability}</dd>
                    </dl>
                    {view !== 'trash' ? (
                      <>
                        <div className='path-label'>CURRENT PATH</div>
                        <p className='file-path'>{active.path}</p>
                      </>
                    ) : null}
                    {view !== 'trash' ? (
                      <button
                        className='text-button'
                        onClick={() => void run(() => api.reveal(active.id))}
                      >
                        <ExternalLink size={13} />
                        Reveal in Finder
                      </button>
                    ) : null}
                    {active.metadataError ? (
                      <p className='track-error'>{active.metadataError}</p>
                    ) : null}
                  </div>
                  {view !== 'trash' ? (
                    <TrackEvidence
                      track={active}
                      generation={generation}
                      onConnect={() => setModal('xml')}
                    />
                  ) : null}
                </>
              ) : (
                <div className='panel-empty'>
                  <FileAudio size={28} />
                  <h3>
                    Your next decision,
                    <br />
                    in one place.
                  </h3>
                  <p>Select a track to listen, edit local tags, and add it to your playlists.</p>
                  <div>
                    <i />
                    Original files stay untouched.
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
        <div className='scan-strip'>
          <button onClick={() => setModal('scan')}>
            <span className={scanning ? 'scan-led running' : 'scan-led'} />
            {scanning ? (
              <>
                <strong>
                  {summary.lastScan?.kind === 'smart' ? 'Smart Scan' : 'Discovery'} in progress
                </strong>
                <span>{summary.lastScan?.audio} audio paths checked</span>
              </>
            ) : (
              <>
                <strong>
                  {summary.lastScan
                    ? 'Last scanned ' + scanDate(summary.lastScan.finishedAt)
                    : 'Smart Scan is ready'}
                </strong>
                <span>
                  {summary.lastScan
                    ? `${summary.lastScan.newFiles} new · ${summary.lastScan.unchanged} unchanged · ${summary.lastScan.coverage === 'complete' ? 'selected locations checked' : 'some locations not checked'}`
                    : 'Choose sources to begin'}
                </span>
              </>
            )}
            <ChevronRight size={13} />
          </button>
          {scanning ? (
            <button className='cancel-button' onClick={() => void run(() => api.cancelScan())}>
              <Square size={10} />
              Cancel scan
            </button>
          ) : (
            <span>
              {summary.classified.toLocaleString()} placed in categories · {bytes(summary.bytes)}{' '}
              available audio
            </span>
          )}
        </div>
        <footer className='player'>
          <div className='player-track'>
            <Artwork className='mini-art' />
            <div>
              <strong>{nowPlaying?.title || nowPlaying?.filename || 'Preview a track'}</strong>
              <span>
                {nowPlaying?.artist ||
                  (view === 'trash'
                    ? 'Restore a track to preview it'
                    : 'Select a file, then press play')}
              </span>
            </div>
          </div>
          <button
            className='play-button'
            aria-label={player.playing ? 'Pause preview' : 'Play preview'}
            disabled={(!active || view === 'trash') && !player.fileId}
            onClick={() => {
              if (!player.fileId && active) {
                void load(active, true)
                return
              }
              void api
                .playback(player.playing ? 'pause' : 'play')
                .then(setPlayer)
                .catch(e => setError(e.message))
            }}
          >
            {player.playing ? (
              <Pause size={18} fill='currentColor' />
            ) : (
              <Play size={18} fill='currentColor' />
            )}
          </button>
          <span className='player-time'>{time(player.position)}</span>
          <input
            className='seek'
            style={
              {
                '--progress': `${player.duration ? Math.min(100, (player.position / player.duration) * 100) : 0}%`,
              } as React.CSSProperties
            }
            aria-label='Preview position'
            type='range'
            min={0}
            max={player.duration || 1}
            step={0.1}
            value={Math.min(player.position, player.duration || 1)}
            disabled={!player.fileId}
            onChange={e => {
              const value = Number(e.target.value)
              setPlayer(p => ({ ...p, position: value }))
              void api
                .playback('seek', undefined, value)
                .then(setPlayer)
                .catch(e => setError(e.message))
            }}
          />
          <span className='player-time'>{time(player.duration)}</span>
          <div className='volume'>
            <Volume2 size={16} />
            <input
              aria-label='Preview volume'
              style={
                {
                  '--progress': `${player.volume * 100}%`,
                } as React.CSSProperties
              }
              type='range'
              min={0}
              max={1}
              step={0.01}
              value={player.volume}
              onChange={e => {
                const value = Number(e.target.value)
                setPlayer(p => ({ ...p, volume: value }))
                void api.playback('volume', undefined, value).catch(e => setError(e.message))
              }}
            />
          </div>
          <span className='preview-label'>LOCAL PREVIEW</span>
        </footer>
      </main>
      {modal ? (
        <div
          className='modal-overlay'
          onClick={() => {
            if (!trashBusy) setModal(null)
          }}
        >
          <section
            ref={dialogRef}
            className={`modal ${modal === 'settings' ? 'settings-modal' : ''}${modal === 'xml' || modal === 'classification' || modal === 'research' || modal === 'preparation' || modal === 'trash' ? ' xml-modal' : ''}`}
            onKeyDown={e => {
              if (e.key !== 'Tab') return
              const buttons = [
                ...(dialogRef.current?.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"],summary,a[href]'
                ) || []),
              ]
              const first = buttons[0]
              const last = buttons.at(-1)
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault()
                last?.focus()
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault()
                first?.focus()
              }
            }}
            role='dialog'
            aria-modal='true'
            aria-label={
              modal === 'trash'
                ? 'Move to Trash and restore'
                : modal === 'playlist'
                  ? 'Edit playlists'
                  : modal === 'preparation'
                    ? 'Prepare for rekordbox'
                    : modal === 'research'
                      ? 'Online research'
                      : modal === 'classification'
                        ? 'Automatic classification'
                        : modal === 'xml'
                          ? 'Connect Your Rekordbox Library'
                          : modal === 'settings'
                            ? 'Settings and sources'
                            : modal === 'columns'
                              ? 'Table columns'
                              : 'Scan coverage'
            }
            onClick={e => e.stopPropagation()}
          >
            <button
              className='modal-close icon-button'
              aria-label='Close dialog'
              disabled={trashBusy}
              onClick={() => setModal(null)}
            >
              <X size={19} />
            </button>
            {modal === 'preparation' ? (
              <Preparation
                onReview={reason => {
                  setModal(null)
                  navigate('review', reason || 'held')
                }}
                onRefreshXML={() => setModal('xml')}
                selected={[...selected]}
                onPreview={async member => {
                  const p = await api.playback('load', member.track.id)
                  setNowPlaying(member.track as Track)
                  setPlayer(p.error ? p : await api.playback('play'))
                  if (p.error) throw new Error(p.error)
                }}
              />
            ) : null}
            {modal === 'playlist' ? (
              <PlaylistDialog
                key={`${playlistMode}:${currentPlaylist?.id || 'new'}`}
                mode={playlistMode}
                state={organization}
                playlist={playlistMode === 'create' ? undefined : currentPlaylist}
                onClose={() => setModal(null)}
                onSaved={id => {
                  void refresh()
                  setGeneration(n => n + 1)
                  if (id) navigate('playlist', id)
                  else if (playlistMode === 'delete') navigate('practice')
                }}
              />
            ) : null}
            {modal === 'trash' ? (
              <TrackTrashDialog
                changes={trashChanges}
                scope={trashScope}
                onClose={() => setModal(null)}
                onChanged={() => {
                  void refresh()
                  setGeneration(n => n + 1)
                }}
                onBusy={setTrashBusy}
                onBrowse={() => {
                  setModal(null)
                  navigate('trash')
                }}
              />
            ) : null}
            {modal === 'research' ? (
              <ResearchSettings
                selected={selectedTracks.length ? selectedTracks : active ? [active] : []}
                run={run}
                busy={busy}
              />
            ) : null}
            {modal === 'classification' ? (
              <ClassificationSettings state={classification} run={run} busy={busy} />
            ) : null}
            {modal === 'settings' ? (
              <>
                <div className='eyebrow'>LOCAL PREFERENCES</div>
                <h2>Settings & sources</h2>
                <p>Read-only discovery, XML snapshots and automatic local classification.</p>
                <div className='settings-safety'>
                  <ShieldCheck size={23} />
                  <div>
                    <strong>Playlist-only mode</strong>
                    <p>
                      Organization keeps audio and embedded tags untouched. Local tags and playlists
                      are saved inside this app. Move to Trash only runs when you explicitly choose
                      it.
                    </p>
                  </div>
                </div>
                <nav className='settings-nav' aria-label='Settings sections'>
                  {[
                    ['settings-sources', 'Sources'],
                    ['settings-tags', 'Tags & review'],
                    ['settings-automatic', 'Automatic sync'],
                    ['settings-rekordbox', 'Rekordbox'],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() =>
                        document.getElementById(id!)?.scrollIntoView({ block: 'start' })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </nav>
                <section className='settings-section' id='settings-sources' aria-label='Sources'>
                  <h3>Authorized sources</h3>
                  <p className='field-help'>
                    Pause a source to stop scans and preview access through it. Its catalog and
                    decisions are retained. Select sources in Automatic sync for automatic handling
                    of finished downloads.
                  </p>
                  {sources.map(s => (
                    <div className='source-card' key={s.id}>
                      <FolderOpen size={20} />
                      <div>
                        <strong>
                          {s.label}
                          {s.demo ? ' · synthetic tones' : ''}
                        </strong>
                        <p>{s.path}</p>
                        <small>
                          {s.fileCount} files · {s.enabled ? s.status : 'paused'} · last successful
                          scan {ago(s.lastScan)}
                        </small>
                      </div>
                      <button
                        disabled={scanning || busy}
                        onClick={() => void run(() => api.sourceEnabled(s.id, !s.enabled))}
                      >
                        {s.enabled ? 'Pause source' : 'Resume source'}
                      </button>
                    </div>
                  ))}
                  <button
                    className='button secondary'
                    disabled={scanning || busy}
                    onClick={() => void run(() => api.addSource())}
                  >
                    <Plus size={15} />
                    Add Source Folder
                  </button>
                  <div className='settings-buttons'>
                    <button
                      disabled={busy || scanning || !sources.length}
                      className='button secondary'
                      onClick={() => void run(() => api.scan('discovery'))}
                    >
                      <Search size={15} />
                      Full Discovery Scan
                    </button>
                    <button
                      disabled={busy || scanning}
                      className='button secondary'
                      onClick={() => void run(() => api.demo())}
                    >
                      <FlaskConical size={15} />
                      Load Synthetic Demo
                    </button>
                  </div>
                  <p className='field-help'>
                    Permission to read a source is not approval to organize files. Full discovery
                    covers authorized roots and reports exclusions; it cannot guarantee every song
                    on your Mac.
                  </p>
                </section>
                <section
                  className='settings-section'
                  id='settings-tags'
                  aria-label='Tags and classification'
                >
                  <h3>Automatic tags & review</h3>
                  <p>
                    Genre and version tags update from your catalog metadata. Your own tags and
                    playlists stay protected. Every available song stays in the practice library
                    while review is pending.
                  </p>
                  <button
                    id='classification-settings'
                    className='button secondary'
                    onClick={() => setModal('classification')}
                  >
                    Automatic classification & rules
                  </button>
                </section>
                <section
                  className='settings-section'
                  id='settings-automatic'
                  aria-label='Automatic sync'
                >
                  <h3>Automatic sync</h3>
                  <AutomationSettings sources={sources} />
                </section>
                <section
                  className='settings-section'
                  id='settings-rekordbox'
                  aria-label='Rekordbox'
                >
                  <h3>Rekordbox</h3>
                  <button className='button secondary' onClick={() => setModal('xml')}>
                    <Link2 size={16} />
                    Refresh Rekordbox Library
                  </button>
                </section>
              </>
            ) : null}
            {modal === 'columns' ? (
              <>
                <div className='eyebrow'>YOUR LIBRARY VIEW</div>
                <h2>Table columns</h2>
                <p>
                  Resize with the column dividers. BPM and year sort numerically; unknown values
                  stay last.
                </p>
                <div className='column-list'>
                  {COLUMN_OPTIONS.map(c => (
                    <label key={c[0]}>
                      <input
                        type='checkbox'
                        checked={columns.includes(c[0])}
                        disabled={columns.length === 1 && columns.includes(c[0])}
                        onChange={e =>
                          setColumns(old =>
                            e.target.checked ? [...old, c[0]] : old.filter(k => k !== c[0])
                          )
                        }
                      />
                      {c[1]}
                    </label>
                  ))}
                </div>
                <button
                  className='button secondary'
                  onClick={() => {
                    setColumns(INITIAL_COLUMNS)
                    setWidths({})
                  }}
                >
                  Restore Default Columns
                </button>
              </>
            ) : null}
            {modal === 'xml' ? <RekordboxConnection onClose={() => setModal(null)} /> : null}
            {modal === 'scan' ? (
              <>
                <div className='eyebrow'>SCAN COVERAGE</div>
                <h2>
                  {summary.lastScan
                    ? 'Latest ' + (summary.lastScan.kind === 'smart' ? 'Smart Scan' : 'Discovery')
                    : 'No scan yet'}
                </h2>
                <p>
                  Coverage describes the selected scope, with default exclusions. Discovery access
                  is read-only.
                </p>
                {summary.lastScan ? (
                  <ScanDetails progress={summary.lastScan} />
                ) : (
                  <p>Choose Discover My Music or load the synthetic demo.</p>
                )}
              </>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  )
}
function Nav({
  icon,
  label,
  count,
  active,
  onClick,
  viewId,
  playlistId,
}: {
  icon: React.ReactNode
  label: string
  count?: number
  active?: boolean
  onClick: () => void
  viewId?: string
  playlistId?: string
}) {
  return (
    <button
      title={label}
      data-view={viewId}
      data-playlist-id={playlistId}
      className={`nav-item ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {count !== undefined ? <small>{count.toLocaleString()}</small> : null}
    </button>
  )
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
function ScanDetails({ progress: p }: { progress: ScanProgress }) {
  return (
    <>
      <div className='scan-facts'>
        <Fact label='Status' value={p.status} />
        <Fact label='Coverage' value={p.coverage} />
        <Fact label='Audio paths checked' value={String(p.audio)} />
        <Fact label='New file instances' value={String(p.newFiles)} />
        <Fact label='Changed' value={String(p.changed)} />
        <Fact label='Cached' value={String(p.unchanged)} />
        <Fact label='Entries skipped' value={String(p.skipped)} />
        <Fact label='Finished' value={ago(p.finishedAt)} />
      </div>
      {p.status === 'running' ? <p className='file-path'>{p.currentPath}</p> : null}
      <h3>Issues, exclusions & unavailable locations</h3>
      {p.issues.length ? (
        <div className='issue-list'>
          {p.issues.map((issue, i) => (
            <div key={i}>
              <strong>{issue.reason}</strong>
              <p>{issue.path}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className='field-help'>
          No issues recorded. System folders, bundles, hidden files, caches, backups, and temporary
          downloads remain excluded.
        </p>
      )}
      <p className='field-help'>
        Cancelled scans can resume with the same scan action. Incomplete coverage never establishes
        that unvisited files were deleted. Smart Scan cannot discover music in entirely new
        locations outside its remembered scope.
      </p>
    </>
  )
}
