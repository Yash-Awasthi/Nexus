import React, { useState } from 'react'

interface RelatedQuestionsProps {
  questions: string[]
  onSelect: (q: string) => void
  isLoading: boolean
}

export function RelatedQuestions({ questions, onSelect, isLoading }: RelatedQuestionsProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  return (
    <div style={{ marginTop: 24 }}>
      <style>{`
        @keyframes rq-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.8; }
        }
      `}</style>
      <div
        style={{
          fontSize: 11,
          color: '#888',
          fontVariant: 'small-caps',
          letterSpacing: '1px',
          textTransform: 'uppercase',
          marginBottom: 10,
        }}
      >
        Related Questions
      </div>

      {isLoading ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[160, 120, 200].map((w, i) => (
            <div
              key={i}
              style={{
                width: w,
                height: 32,
                background: '#222',
                borderRadius: 20,
                animation: 'rq-pulse 1.5s ease-in-out infinite',
                animationDelay: `${i * 0.2}s`,
              }}
            />
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {questions.slice(0, 6).map((q, i) => (
            <span
              key={i}
              onClick={() => onSelect(q)}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
              style={{
                display: 'inline-block',
                border: `1px solid ${hoveredIndex === i ? '#666' : '#444'}`,
                background: hoveredIndex === i ? '#1e1e1e' : '#111',
                color: '#ccc',
                borderRadius: 20,
                padding: '6px 14px',
                cursor: 'pointer',
                fontSize: 13,
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              {q}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
