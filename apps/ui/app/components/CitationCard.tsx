import React, { useEffect, useRef } from 'react'

export interface Citation {
  id: number
  url: string
  title: string
  domain: string
  snippet: string
  confidence_score: number
}

interface CitationCardProps {
  citation: Citation
  anchorPos?: { top: number; left: number }
  onClose: () => void
}

function ConfidenceBar({ score }: { score: number }) {
  const color = score >= 0.7 ? '#16a34a' : score >= 0.4 ? '#ca8a04' : '#dc2626'
  const label = score >= 0.7 ? 'High' : score >= 0.4 ? 'Medium' : 'Low'
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: '#888' }}>Confidence</span>
        <span style={{ fontSize: 10, color }}>{label} ({Math.round(score * 100)}%)</span>
      </div>
      <div style={{ height: 3, background: '#333', borderRadius: 2 }}>
        <div
          style={{
            height: '100%',
            width: `${score * 100}%`,
            background: color,
            borderRadius: 2,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  )
}

export function CitationCard({ citation, anchorPos, onClose }: CitationCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const faviconUrl = `https://www.google.com/s2/favicons?sz=16&domain=${citation.domain}`

  return (
    <div
      ref={cardRef}
      style={{
        position: 'fixed',
        top: anchorPos ? anchorPos.top : '50%',
        left: anchorPos ? anchorPos.left : '50%',
        transform: anchorPos ? 'none' : 'translate(-50%, -50%)',
        zIndex: 9999,
        width: 320,
        background: '#1a1a1a',
        border: '1px solid #333',
        borderRadius: 8,
        padding: 12,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        fontSize: 13,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <img src={faviconUrl} width={16} height={16} alt="" style={{ borderRadius: 2 }} />
        <span style={{ color: '#888', fontSize: 11 }}>{citation.domain}</span>
        <span
          onClick={onClose}
          style={{
            marginLeft: 'auto',
            cursor: 'pointer',
            color: '#666',
            fontSize: 16,
            lineHeight: 1,
          }}
        >
          ×
        </span>
      </div>

      {/* Title */}
      <div
        style={{
          fontWeight: 600,
          color: '#f0f0f0',
          marginBottom: 6,
          lineHeight: 1.4,
          fontSize: 13,
        }}
      >
        {citation.title}
      </div>

      {/* Snippet */}
      <div
        style={{
          color: '#aaa',
          fontSize: 12,
          lineHeight: 1.5,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          marginBottom: 8,
        }}
      >
        {citation.snippet}
      </div>

      <ConfidenceBar score={citation.confidence_score} />

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <a
          href={citation.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 12,
            color: '#3b82f6',
            textDecoration: 'none',
            padding: '3px 8px',
            border: '1px solid #1d4ed8',
            borderRadius: 4,
          }}
        >
          Open source ↗
        </a>
        <button
          onClick={() => navigator.clipboard.writeText(`[${citation.id}] ${citation.title} — ${citation.url}`)}
          style={{
            fontSize: 12,
            color: '#888',
            background: 'none',
            border: '1px solid #444',
            borderRadius: 4,
            padding: '3px 8px',
            cursor: 'pointer',
          }}
        >
          Copy citation
        </button>
      </div>
    </div>
  )
}
