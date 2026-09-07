import { useEffect, useRef } from 'react'
import type { Artifact, Conversation, ID, ProjectFile } from '@shared/domain'
import type { ArtifactContent } from '@shared/contracts'
import { ArtifactPreview } from './ArtifactPreview'
import { formatBytes } from '../lib/attachments'

interface ContextPanelProps {
  open: boolean
  projectFiles: ProjectFile[]
  artifacts: Artifact[]
  conversations: Conversation[]
  activeConversationId: ID | null
  selectedArtifactId: ID | null
  artifactContent: ArtifactContent | null
  attachedFileIds: ID[]
  onClose: () => void
  onAddFiles: () => void
  onImportArtifacts: () => void
  onAttachFile: (file: ProjectFile) => void
  onSelectArtifact: (artifactId: ID) => void
  onRevealArtifact: (artifactId: ID) => void
  onReferenceArtifact: (artifactId: ID, conversationId: ID) => void
}

/** Files and artifacts live here, opened on request — never as a permanent
 *  column. "Files you added" and "Things Antigravity produced" stay
 *  separate because their provenance and actions differ. */
export function ContextPanel({
  open,
  projectFiles,
  artifacts,
  conversations,
  activeConversationId,
  selectedArtifactId,
  artifactContent,
  attachedFileIds,
  onClose,
  onAddFiles,
  onImportArtifacts,
  onAttachFile,
  onSelectArtifact,
  onRevealArtifact,
  onReferenceArtifact
}: ContextPanelProps): JSX.Element | null {
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const selected = artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null

  return (
    <aside className="context-panel" ref={panelRef} tabIndex={-1} aria-label="Project files and artifacts">
      <div className="context-head">
        <h2>Project</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
          <CloseGlyph />
        </button>
      </div>

      <div className="context-scroll">
        <section className="context-section">
          <div className="context-section-head">
            <h3>Files you added</h3>
            <button type="button" className="ghost" onClick={onAddFiles}>
              Add
            </button>
          </div>
          {projectFiles.length === 0 ? (
            <p className="context-empty">No files yet.</p>
          ) : (
            <ul className="context-list">
              {projectFiles.map((file) => {
                const attached = attachedFileIds.includes(file.id)
                return (
                  <li key={file.id}>
                    <button
                      type="button"
                      className={`context-row${attached ? ' attached' : ''}`}
                      onClick={() => onAttachFile(file)}
                      title={file.originalPath}
                    >
                      <span className="context-row-name">{file.name}</span>
                      <span className="context-row-meta">{attached ? 'Attached' : formatBytes(file.byteSize)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="context-section">
          <div className="context-section-head">
            <h3>Things Antigravity produced</h3>
            <button type="button" className="ghost" onClick={onImportArtifacts}>
              Import
            </button>
          </div>
          {artifacts.length === 0 ? (
            <p className="context-empty">Nothing yet.</p>
          ) : (
            <ul className="context-list">
              {artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <button
                    type="button"
                    className={`context-row${artifact.id === selectedArtifactId ? ' selected' : ''}`}
                    onClick={() => onSelectArtifact(artifact.id)}
                  >
                    <span className="context-row-name">{artifact.name}</span>
                    <span className="context-row-meta">{artifact.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {selected ? (
          <section className="context-section">
            <div className="context-section-head">
              <h3>Preview</h3>
              <button type="button" className="ghost" onClick={() => onRevealArtifact(selected.id)}>
                Reveal
              </button>
            </div>
            <ArtifactPreview artifact={selected} content={artifactContent} />
            {conversations.length > 1 ? (
              <div className="context-reference">
                <span className="context-reference-label">Reference in</span>
                {conversations
                  .filter((conversation) => conversation.id !== activeConversationId)
                  .map((conversation) => (
                    <button key={conversation.id} type="button" className="ghost" onClick={() => onReferenceArtifact(selected.id, conversation.id)}>
                      {conversation.title}
                    </button>
                  ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  )
}

function CloseGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
