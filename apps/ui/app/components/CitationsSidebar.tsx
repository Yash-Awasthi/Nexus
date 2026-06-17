import React, { useState } from 'react'
import type { Citation } from './CitationCard'

interface CitationsSidebarProps {
  citations: Citation[]
  isOpen: boolean
  onClose: () => void
}

function confidenceLabel(score: number): { label: string; color: string } {
  if (score >= 0.7) return { label: `${Math.round(score * 100)}%`, color: '#22c55e' }
  if (score >= 0.4) return { label: `${Math.round(score * 100)}%`, color: '#eab308' }
  return { label: `${Math.round(score * 100)}%`, color: '#ef4444' }
}

export function CitationsSidebar({ citations, isOpen, onClose }: CitationsSidebarProps) {
  if (!isOpen) {
    return null
  }

  return (
    <div
      style={{
        width: 260,
        minWidth: 260,
        background: '#0d0d0d',
        borderLeft: '1px solid #222',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 14px',
          borderBottom: '1px solid #1e1e1e',
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: '#888',
            fontVariant: 'small-caps',
            letterSpacing: '1px',
            textTransform: 'uppercase',
          }}
        >
          Sources ({citations.length})
        </span>
        <span
          onClick={onClose}
          style={{ cursor: 'pointer', color: '#555', fontSize: 16, lineHeight: 1 }}
        >
          ×
        </span>
      </div>

      {/* Citations list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {citations.length === 0 ? (
          <div style={{ color: '#555', fontSize: 12, textAlign: 'center', padding: '24px 14px' }}>
            No sources yet
          </div>
        ) : (
          citations.map((c) => {
            const conf = confidenceLabel(c.confidence_score)
            return (
              <div
                key={c.id}
                style={{
                  padding: '8px 14px',
                  borderBottom: '1px solid #1a1a1a',
                  cursor: 'default',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span
                    style={{
                      fontSize: 10,
                      background: '#1e1e1e',
                      color: '#888',
                      borderRadius: 4,
                      padding: '1px 5px',
                      minWidth: 16,
                      textAlign: 'center',
                    }}
                  >
                    {c.id}
                  </span>
                  <span style={{ fontSize: 11, color: '#666', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.domain}
                  </span>
                  <span style={{ fontSize: 10, color: conf.color }}>{conf.label}</span>
                </div>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 12,
                    color: '#a0aec0',
                    textDecoration: 'none',
                    display: 'block',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1.4,
                  }}
                >
                  {c.title}
                </a>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
