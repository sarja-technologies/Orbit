import { useEffect, useRef } from 'react'
import type { Artifact, Conversation, ID, ProjectFile } from '@shared/domain'
import type { ArtifactContent } from '@shared/contracts'
import { ArtifactPreview } from './ArtifactPreview'
import { formatBytes } from '../lib/attachments'

export type ContextTab = 'files' | 'artifacts'

interface ContextPanelProps {
  tab: ContextTab | null
  projectFiles: ProjectFile[]
  artifacts: Artifact[]
  conversations: Conversation[]
  activeConversationId: ID | null
  selectedArtifactId: ID | null
  artifactContent: ArtifactContent | null
  attachedFileIds: ID[]
  onClose: () => void
  onSelectTab: (tab: ContextTab) => void
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
  tab,
  projectFiles,
  artifacts,
  conversations,
  activeConversationId,
  selectedArtifactId,
  artifactContent,
  attachedFileIds,
  onClose,
  onSelectTab,
  onAddFiles,
  onImportArtifacts,
  onAttachFile,
  onSelectArtifact,
  onRevealArtifact,
  onReferenceArtifact
}: ContextPanelProps): JSX.Element | null {
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!tab) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [tab, onClose])

  if (!tab) return null

  const selected = artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null

  return (
    <aside className="context-panel" ref={panelRef} tabIndex={-1} aria-label="Project files and artifacts">
      {/* Two tabs rather than two stacked sections: files you brought and
          things Antigravity produced are different jobs, and only one is
          usually wanted at a time. */}
      <div className="context-head">
        <div className="context-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'files'}
            className={tab === 'files' ? 'context-tab active' : 'context-tab'}
            onClick={() => onSelectTab('files')}
          >
            Files
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'artifacts'}
            className={tab === 'artifacts' ? 'context-tab active' : 'context-tab'}
            onClick={() => onSelectTab('artifacts')}
          >
            Artifacts
          </button>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
          <CloseGlyph />
        </button>
      </div>

      <div className="context-scroll">
        {tab === 'files' ? (
        <section className="context-section">
          <button type="button" className="context-add" onClick={onAddFiles}>
            <PlusGlyph />
            <span>Add files</span>
          </button>
          <div className="context-section-head">
            <h3>Project files</h3>
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
        ) : null}

        {tab === 'artifacts' ? (
        <section className="context-section">
          <button type="button" className="context-add" onClick={onImportArtifacts}>
            <PlusGlyph />
            <span>Import artifacts</span>
          </button>
          <div className="context-section-head">
            <h3>Produced by Antigravity</h3>
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
        ) : null}

        {selected && tab === 'artifacts' ? (
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

function PlusGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function CloseGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
