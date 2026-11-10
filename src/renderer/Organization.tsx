import { useEffect, useState } from 'react'
import { Plus, X, Tags, FolderPlus, ListMusic } from 'lucide-react'
import type { Track } from '../shared'
import {
  ORGANIZATION_GROUPS,
  PRACTICE_GENRES,
  type OrganizationGroup,
  type OrganizationState,
  type OrganizationTrack,
  type LibraryPlaylist,
} from '../organization-types'

const api = window.organizer
type Run = (fn: () => Promise<unknown>) => Promise<boolean>
const LABELS: Record<OrganizationGroup, string> = {
  genre: 'Genre',
  version: 'Version',
  use: 'Use',
  familiarity: 'Familiarity',
}
const VALUES: Record<OrganizationGroup, readonly string[]> = {
  genre: PRACTICE_GENRES,
  version: [
    'Intro / Edit',
    'Remix',
    'Clean',
    'Explicit',
    'Acoustic',
    'A Cappella',
    'Instrumental',
    'Short / Incomplete',
  ],
  use: ['Warm-up', 'Singalong', 'Peak', 'Closing', 'Tools & Samples', 'Full Mix'],
  familiarity: ['unheard', 'learning', 'known'],
}

export function TagsEditor({
  active,
  tracks,
  generation,
  busy,
  run,
}: {
  active: Track
  tracks: Track[]
  generation: number
  busy: boolean
  run: Run
}) {
  const [data, setData] = useState<OrganizationTrack | null>(null)
  const [group, setGroup] = useState<OrganizationGroup>('genre')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setError(null)
    setData(null)
    void api
      .organizationTrack(active.id)
      .then(d => {
        if (current) setData(d)
      })
      .catch(e => {
        if (current) setError(e.message)
      })
    return () => {
      current = false
    }
  }, [active.id, generation])
  const changes = tracks.map(t => ({ id: t.id, revision: t.revision }))
  async function update(action: 'add' | 'remove', tagGroup = group, tagValue = value) {
    if (!tagValue.trim() || !changes.length) return
    const ok = await run(() =>
      api.organizationTagsUpdate({
        changes,
        group: tagGroup,
        value: tagValue.trim(),
        action,
      })
    )
    if (ok) setValue('')
  }
  return (
    <section
      data-active-track-id={active.id}
      className='panel-section organization-editor'
      aria-label='Local organization tags'
    >
      <div className='field-label'>
        <Tags size={14} /> LOCAL TAGS {tracks.length > 1 ? `· ${tracks.length} SELECTED` : ''}
      </div>
      <div className='organization-tags'>
        {(data?.tags || active.organizationTags || [])
          .filter(tag => tag.group !== 'familiarity')
          .map(tag => (
            <span
              className={`organization-tag ${tag.origin}`}
              key={`${tag.group}:${tag.value}`}
              title={`${LABELS[tag.group]} · ${tag.origin}`}
            >
              <small>{LABELS[tag.group]}</small>
              {tag.value}
              <button
                aria-label={`Remove ${tag.value} tag${tracks.length > 1 ? ' from selected tracks' : ''}`}
                disabled={busy || !changes.length}
                onClick={() => void update('remove', tag.group, tag.value)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        {data && !data.tags.length ? (
          <span className='field-help'>
            No tags yet. This song is still available in All Practice Tracks.
          </span>
        ) : null}
      </div>
      {error ? (
        <p role='alert' className='track-error'>
          {error}
        </p>
      ) : null}
      <label className='field-label' htmlFor='organization-tag-group'>
        {tracks.length > 1 ? 'TAG SELECTED TRACKS' : 'ADD A TAG'}
      </label>
      <div className='tag-entry'>
        <select
          id='organization-tag-group'
          value={group}
          onChange={e => {
            setGroup(e.target.value as OrganizationGroup)
            setValue('')
          }}
        >
          {ORGANIZATION_GROUPS.filter(g => g !== 'familiarity').map(g => (
            <option key={g} value={g}>
              {LABELS[g]}
            </option>
          ))}
        </select>
        <input
          id='organization-tag-value'
          aria-label='Tag value'
          list='organization-tag-values'
          value={value}
          maxLength={80}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void update('add')
            }
          }}
          placeholder={group === 'genre' ? 'Choose or type a genre' : 'Choose or type a tag'}
        />
        <datalist id='organization-tag-values'>
          {VALUES[group].map(v => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <button
          id='organization-tag-add'
          className='button secondary'
          disabled={busy || !changes.length || !value.trim()}
          onClick={() => void update('add')}
        >
          <Plus size={14} />
          Add
        </button>
      </div>
      <label className='field-label' htmlFor='practice-familiarity'>
        PRACTICE FAMILIARITY
      </label>
      <select
        id='practice-familiarity'
        disabled={busy || !changes.length}
        value={
          data?.familiarity ||
          active.organizationTags?.find(t => t.group === 'familiarity')?.value ||
          'unheard'
        }
        onChange={e =>
          void run(() =>
            api.organizationFamiliarity({
              changes,
              value: e.target.value as 'unheard' | 'learning' | 'known',
            })
          )
        }
      >
        <option value='unheard'>Haven’t listened</option>
        <option value='learning'>Learning</option>
        <option value='known'>Know it</option>
      </select>
      <p className='field-help'>
        Saved inside this app. Original files and embedded tags stay untouched. Genre edits also
        update the genre used for prepared playlists.
      </p>
      {data?.playlists.length ? (
        <p className='field-help'>In: {data.playlists.map(p => p.name).join(' · ')}</p>
      ) : null}
    </section>
  )
}

export function PlaylistDialog({
  state,
  playlist,
  mode,
  onClose,
  onSaved,
}: {
  state: OrganizationState
  playlist?: LibraryPlaylist
  mode: 'create' | 'rename' | 'delete'
  onClose: () => void
  onSaved: (id?: string) => void
}) {
  const [name, setName] = useState(playlist?.name || '')
  const [kind, setKind] = useState<'folder' | 'playlist'>('playlist')
  const [parent, setParent] = useState(playlist?.parentId || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      let id = playlist?.id
      if (mode === 'delete' && playlist) await api.playlistDelete(playlist.id)
      else if (mode === 'rename' && playlist) await api.playlistRename({ id: playlist.id, name })
      else id = (await api.playlistCreate({ name, kind, parentId: parent || null })).id
      onSaved(mode === 'delete' ? undefined : id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save playlist.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className='playlist-editor'>
      <div className='eyebrow'>YOUR PLAYLISTS</div>
      <h2>
        {mode === 'delete'
          ? `Delete ${playlist?.kind || 'playlist'}?`
          : mode === 'rename'
            ? 'Rename playlist or folder'
            : 'Create a playlist or folder'}
      </h2>
      <form id='playlist-create-form' onSubmit={e => void save(e)}>
        {mode === 'delete' ? (
          <p>
            Remove “{playlist?.name}”{playlist?.kind === 'folder' ? ' and its playlists' : ''} from
            your playlists. Songs remain in your library and practice playlists.
          </p>
        ) : (
          <>
            <label className='field-label' htmlFor='playlist-name'>
              NAME
            </label>
            <input
              autoFocus
              id='playlist-name'
              required
              maxLength={120}
              value={name}
              onChange={e => setName(e.target.value)}
            />
            {mode === 'create' ? (
              <>
                <label className='field-label' htmlFor='playlist-kind'>
                  CREATE
                </label>
                <select
                  id='playlist-kind'
                  value={kind}
                  onChange={e => setKind(e.target.value as 'folder' | 'playlist')}
                >
                  <option value='playlist'>Playlist</option>
                  <option value='folder'>Folder</option>
                </select>
                <label className='field-label' htmlFor='playlist-parent'>
                  INSIDE
                </label>
                <select
                  id='playlist-parent'
                  value={parent}
                  onChange={e => setParent(e.target.value)}
                >
                  <option value=''>My Playlists</option>
                  {state.playlists
                    .filter(p => p.kind === 'folder')
                    .map(p => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </>
            ) : null}
          </>
        )}
        {error ? (
          <p className='track-error' role='alert'>
            {error}
          </p>
        ) : null}
        <div className='dialog-actions'>
          <button type='button' className='button secondary' disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            id='playlist-create'
            className={`button ${mode === 'delete' ? 'danger' : 'accent'}`}
            disabled={busy || (mode !== 'delete' && !name.trim())}
            type='submit'
          >
            {mode === 'delete' ? (
              'Delete playlist'
            ) : mode === 'rename' ? (
              'Save name'
            ) : kind === 'folder' ? (
              <>
                <FolderPlus size={15} />
                Create folder
              </>
            ) : (
              <>
                <ListMusic size={15} />
                Create playlist
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}

export function playlistLabel(playlist: LibraryPlaylist, all: LibraryPlaylist[]) {
  const names = [playlist.name]
  let parent = playlist.parentId
  const visited = new Set([playlist.id])
  while (parent && !visited.has(parent)) {
    visited.add(parent)
    const p = all.find(p => p.id === parent)
    if (!p) break
    names.unshift(p.name)
    parent = p.parentId
  }
  return names.join(' / ')
}

export function TableTags({ track }: { track: Track }) {
  const tags = (track.organizationTags || []).filter(tag => tag.group !== 'familiarity')
  const genres = tags.filter(tag => tag.group === 'genre')
  const versions = tags.filter(tag => tag.group === 'version')
  const uses = tags.filter(tag => tag.group === 'use')
  const shown = [genres[0], versions[0], ...genres.slice(1), ...versions.slice(1), ...uses].filter(
    (tag): tag is NonNullable<typeof tag> => Boolean(tag)
  )
  return (
    <span className='table-tags' title={tags.map(tag => `${tag.group}: ${tag.value}`).join('; ')}>
      {shown.length ? (
        shown.slice(0, 2).map(tag => <span key={`${tag.group}:${tag.value}`}>{tag.value}</span>)
      ) : (
        <span className='unknown'>Unsorted</span>
      )}
      {shown.length > 2 ? <b className='tag-more'>+{shown.length - 2}</b> : null}
    </span>
  )
}
