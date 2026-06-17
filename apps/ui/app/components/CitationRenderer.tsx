import React, { useState } from 'react'
import { CitationBadge } from './CitationBadge'
import { CitationCard, type Citation } from './CitationCard'

interface CitationRendererProps {
  content: string
  citations: Citation[]
}

// Splits content on [1], [2], [N] markers
function parseContent(content: string): Array<{ type: 'text'; value: string } | { type: 'cite'; id: number }> {
  const parts: Array<{ type: 'text'; value: string } | { type: 'cite'; id: number }> = []
  const regex = /\[(\d+)\]/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) })
    }
    parts.push({ type: 'cite', id: parseInt(match[1], 10) })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) })
  }

  return parts
}

export function CitationRenderer({ content, citations }: CitationRendererProps) {
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | undefined>()

  const citationMap = new Map(citations.map((c) => [c.id, c]))
  const parts = parseContent(content)

  function handleHover(id: number | null) {
    setHoveredId(id)
  }

  function handleClick(id: number, e: React.MouseEvent) {
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    setCardPos({ top: rect.bottom + 6, left: Math.min(rect.left, window.innerWidth - 340) })
    setActiveId((prev) => (prev === id ? null : id))
  }

  if (!citations.length) {
    return <span>{content}</span>
  }

  return (
    <span style={{ position: 'relative' }}>
      {parts.map((part, i) => {
        if (part.type === 'text') {
          return <span key={i}>{part.value}</span>
        }
        const citation = citationMap.get(part.id)
        if (!citation) return <span key={i}>[{part.id}]</span>
        return (
          <CitationBadge
            key={`${i}-${part.id}`}
            id={part.id}
            confidence={citation.confidence_score}
            onHover={handleHover}
            onClick={(id) =>
              handleClick(id, { target: document.getElementById(`cite-${id}`) || document.body } as any)
            }
          />
        )
      })}

      {activeId !== null && citationMap.get(activeId) && (
        <CitationCard
          citation={citationMap.get(activeId)!}
          anchorPos={cardPos}
          onClose={() => setActiveId(null)}
        />
      )}
    </span>
  )
}
