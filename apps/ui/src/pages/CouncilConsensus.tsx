import { useState, useEffect } from 'react';

/**
 * CouncilConsensus — shows multi-model deliberation results.
 * Displays model votes, disagreement matrix, and consensus output.
 */

interface ModelVote {
  model: string;
  provider: string;
  answer: string;
  confidence: number;
  reasoning: string;
  latencyMs: number;
  tokens: number;
}

interface ConsensusResult {
  id: string;
  prompt: string;
  votes: ModelVote[];
  consensusAnswer: string;
  agreement: number;
  rounds: number;
  status: 'deliberating' | 'converged' | 'disagreed';
  createdAt: string;
}

const MOCK_CONSENSUS: ConsensusResult = {
  id: 'council-001',
  prompt: 'Should the API use REST or GraphQL for the new public endpoints?',
  votes: [
    {
      model: 'claude-4-sonnet',
      provider: 'anthropic',
      answer: 'REST for public endpoints — simpler for third-party integration, better caching, widely supported.',
      confidence: 0.85,
      reasoning: 'REST has broader ecosystem support, better HTTP caching semantics, and lower barrier for API consumers.',
      latencyMs: 820,
      tokens: 1240,
    },
    {
      model: 'gpt-4o',
      provider: 'openai',
      answer: 'GraphQL — better for complex nested queries, reduces over-fetching, strong typing.',
      confidence: 0.78,
      reasoning: 'GraphQL excels when clients need flexible data fetching. The schema serves as self-documenting API contract.',
      latencyMs: 650,
      tokens: 1180,
    },
    {
      model: 'gemini-3.6-flash',
      provider: 'google',
      answer: 'Hybrid: REST for simple CRUD, GraphQL for complex queries. Best of both worlds.',
      confidence: 0.92,
      reasoning: 'A hybrid approach gives REST for simple operations and GraphQL for complex data needs. Slightly more maintenance but optimal flexibility.',
      latencyMs: 1100,
      tokens: 1350,
    },
    {
      model: 'deepseek-r1',
      provider: 'deepseek',
      answer: 'REST — explicit, cacheable, mature tooling. GraphQL adds unnecessary complexity for a public API.',
      confidence: 0.81,
      reasoning: 'For a public API, simplicity and tooling maturity matter most. REST with OpenAPI spec provides excellent developer experience.',
      latencyMs: 2100,
      tokens: 1500,
    },
  ],
  consensusAnswer: 'Hybrid approach: REST for simple CRUD operations with OpenAPI documentation, GraphQL for complex nested queries. This gives third-party developers simple endpoints while enabling efficient data fetching for complex use cases.',
  agreement: 0.62,
  rounds: 3,
  status: 'converged',
  createdAt: new Date().toISOString(),
};

const MODELS = [
  { id: 'claude-4-sonnet', color: '#a855f7', bg: 'rgba(168,85,247,0.1)', border: 'rgba(168,85,247,0.3)' },
  { id: 'gpt-4o', color: '#22c55e', bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.3)' },
  { id: 'gemini-3.6-flash', color: '#3b82f6', bg: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.3)' },
  { id: 'deepseek-r1', color: '#f97316', bg: 'rgba(249,115,22,0.1)', border: 'rgba(249,115,22,0.3)' },
];

function getModelStyle(model: string) {
  return MODELS.find(m => m.id === model) || MODELS[0];
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 0.85 ? '#22c55e' : value >= 0.7 ? '#eab308' : '#f97316';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: '#1f2937', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${value * 100}%`, background: color, borderRadius: 3, transition: 'width 0.6s' }} />
      </div>
      <span style={{ fontSize: '0.75rem', fontWeight: 700, color, width: 36, textAlign: 'right' }}>
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

function DisagreementMatrix({ votes }: { votes: ModelVote[] }) {
  const matrix: number[][] = [];
  for (let i = 0; i < votes.length; i++) {
    matrix[i] = [];
    for (let j = 0; j < votes.length; j++) {
      if (i === j) { matrix[i][j] = 1; continue; }
      // Simple similarity: check if answers share key words
      const wordsA = new Set(votes[i].answer.toLowerCase().split(/\s+/));
      const wordsB = new Set(votes[j].answer.toLowerCase().split(/\s+/));
      const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
      const union = new Set([...wordsA, ...wordsB]);
      matrix[i][j] = intersection.size / union.size;
    }
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
        <thead>
          <tr>
            <th style={{ padding: 6, borderBottom: '1px solid #1f2937' }}></th>
            {votes.map(v => (
              <th key={v.model} style={{ padding: 6, borderBottom: '1px solid #1f2937', color: getModelStyle(v.model).color, fontWeight: 600, textAlign: 'center' }}>
                {v.model.split('-').slice(0, 2).join(' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {votes.map((v, i) => (
            <tr key={v.model}>
              <td style={{ padding: 6, borderBottom: '1px solid #1f2937', color: getModelStyle(v.model).color, fontWeight: 600 }}>
                {v.model.split('-').slice(0, 2).join(' ')}
              </td>
              {matrix[i].map((val, j) => (
                <td key={j} style={{
                  padding: 6, textAlign: 'center', borderBottom: '1px solid #1f2937',
                  background: i === j ? 'transparent' : `rgba(${val > 0.5 ? '34,197,94' : '239,68,68'},${val * 0.3})`,
                  fontWeight: 700,
                }}>
                  {i === j ? '—' : `${Math.round(val * 100)}%`}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CouncilConsensus() {
  const [result, setResult] = useState<ConsensusResult>(MOCK_CONSENSUS);
  const [selectedVote, setSelectedVote] = useState<number | null>(null);

  return (
    <div style={{ background: '#0a0e17', minHeight: '100vh', color: '#e5e7eb', fontFamily: "'JetBrains Mono', monospace", padding: '2rem' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.8rem', fontWeight: 800, background: 'linear-gradient(135deg, #a855f7, #3b82f6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', marginBottom: '0.5rem' }}>
          🏛️ Council Consensus
        </h1>
        <p style={{ color: '#6b7280', marginBottom: '2rem' }}>Multi-model deliberation — {result.rounds} rounds, {result.votes.length} models</p>

        {/* Prompt */}
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 12, padding: '1.5rem', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#6b7280', marginBottom: 8 }}>Deliberation Prompt</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600, lineHeight: 1.5 }}>{result.prompt}</div>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: '0.8rem', color: '#9ca3af' }}>
            <span>Agreement: <strong style={{ color: result.agreement >= 0.6 ? '#22c55e' : '#f97316' }}>{Math.round(result.agreement * 100)}%</strong></span>
            <span>Rounds: <strong>{result.rounds}</strong></span>
            <span>Status: <strong style={{ color: result.status === 'converged' ? '#22c55e' : '#f97316' }}>{result.status}</strong></span>
          </div>
        </div>

        {/* Model Votes */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
          {result.votes.map((vote, i) => {
            const style = getModelStyle(vote.model);
            return (
              <div key={vote.model}
                onClick={() => setSelectedVote(selectedVote === i ? null : i)}
                style={{
                  background: style.bg, border: `1px solid ${style.border}`,
                  borderRadius: 10, padding: '1rem', cursor: 'pointer',
                  transition: 'transform 0.15s',
                  transform: selectedVote === i ? 'scale(1.02)' : 'scale(1)',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700, color: style.color }}>{vote.model}</div>
                    <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>{vote.provider} • {vote.latencyMs}ms • {vote.tokens} tok</div>
                  </div>
                  <div style={{ fontSize: '1.2rem' }}>
                    {i === result.votes.reduce((best, v, j) => v.confidence > result.votes[best].confidence ? j : best, 0) ? '👑' : ''}
                  </div>
                </div>
                <div style={{ fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 8 }}>{vote.answer}</div>
                <ConfidenceBar value={vote.confidence} />
                {selectedVote === i && (
                  <div style={{ marginTop: 10, padding: '10px', background: 'rgba(0,0,0,0.3)', borderRadius: 8, fontSize: '0.8rem', lineHeight: 1.5 }}>
                    <div style={{ color: '#9ca3af', marginBottom: 4, fontWeight: 600 }}>Reasoning:</div>
                    {vote.reasoning}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Consensus Answer */}
        <div style={{ background: '#111827', border: '2px solid rgba(34,197,94,0.3)', borderRadius: 12, padding: '1.5rem', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#22c55e', marginBottom: 8, fontWeight: 700 }}>
            ✅ Consensus Output
          </div>
          <div style={{ fontSize: '1rem', lineHeight: 1.6 }}>{result.consensusAnswer}</div>
        </div>

        {/* Disagreement Matrix */}
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 12, padding: '1.5rem' }}>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#6b7280', marginBottom: 12 }}>
            📊 Agreement Matrix
          </div>
          <DisagreementMatrix votes={result.votes} />
        </div>
      </div>
    </div>
  );
}
