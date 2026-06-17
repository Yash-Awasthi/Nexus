import React from 'react'

export type MentionType = 'file' | 'symbol' | 'web'

interface ContextPillProps {
  type: MentionType
  label: string
  value: string
  onRemove: () => void
}

const TYPE_COLORS: Record<MentionType, { bg: string; border: string; dot: string }> = {
  file:   { bg: '#0d1b2e', border: '#1d4ed8', dot: '#3b82f6' },
  symbol: { bg: '#1a0d2e', border: '#7c3aed', dot: '#a855f7' },
  web:    { bg: '#1f1200', border: '#c2410c', dot: '#f97316' },
}

const TYPE_ICONS: Record<MentionType, string> = {
  file:   '📄',
  symbol: '⬡',
  web:    '🌐',
}

export function ContextPill({ type, label, value, onRemove }: ContextPillProps) {
  const colors = TYPE_COLORS[type]
  const icon = TYPE_ICONS[type]
  const truncated = label.length > 24 ? label.slice(0, 22) + '…' : label

  return (
    <span
      title={value}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: '2px 6px 2px 5px',
        fontSize: 12,
        color: '#e5e7eb',
        margin: '2px 2px',
        maxWidth: 200,
        verticalAlign: 'middle',
      }}
    >
      <span style={{ fontSize: 10 }}>{icon}</span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 140,
        }}
      >
        {truncated}
      </span>
      <span
        onClick={onRemove}
        style={{
          marginLeft: 2,
          cursor: 'pointer',
          color: '#9ca3af',
          fontSize: 13,
          lineHeight: 1,
          padding: '0 1px',
        }}
        title="Remove"
      >
        ×
      </span>
    </span>
  )
}
