import { useState } from 'react'
import type { SyntheticEvent } from 'react'

interface SavedSearch {
  id: string
  name: string
  filters: Record<string, unknown>
  created_at: string
}

interface Props {
  searches: SavedSearch[]
  onSave: (name: string) => void
  onLoad: (search: SavedSearch) => void
  onDelete: (id: string) => void
}

export function SavedSearchesPanel({ searches, onSave, onLoad, onDelete }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  const handleSave = (e: SyntheticEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    onSave(name.trim())
    setName('')
  }

  return (
    <div className="saved-searches">
      <button
        type="button"
        className="saved-searches-toggle"
        onClick={() => { setOpen(v => !v) }}
        aria-expanded={open}
      >
        <span>Saved filters</span>
        {searches.length > 0 && (
          <span className="saved-searches-count">{searches.length}</span>
        )}
        <span className="saved-searches-arrow" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="saved-searches-body">
          <form className="saved-searches-save-row" onSubmit={handleSave}>
            <input
              className="saved-searches-input"
              type="text"
              placeholder="Name these filters…"
              value={name}
              onChange={e => { setName(e.target.value) }}
              maxLength={60}
            />
            <button
              type="submit"
              className="saved-searches-save-btn"
              disabled={!name.trim()}
            >
              Save
            </button>
          </form>

          {searches.length === 0 ? (
            <p className="saved-searches-empty">No saved filters yet.</p>
          ) : (
            <ul className="saved-searches-list">
              {searches.map(s => (
                <li key={s.id} className="saved-search-row">
                  <button
                    type="button"
                    className="saved-search-load"
                    onClick={() => { onLoad(s); setOpen(false) }}
                    title={`Load "${s.name}"`}
                  >
                    {s.name}
                  </button>
                  <button
                    type="button"
                    className="saved-search-delete"
                    aria-label={`Delete "${s.name}"`}
                    onClick={() => { onDelete(s.id) }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
