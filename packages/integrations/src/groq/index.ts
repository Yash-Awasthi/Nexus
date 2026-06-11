import Groq from 'groq-sdk';

let _groq: Groq | null = null;

export function groq(): Groq {
  if (!_groq) {
    const key = process.env['GROQ_API_KEY'];
    if (!key) throw new Error('GROQ_API_KEY not set');
    _groq = new Groq({ apiKey: key });
  }
  return _groq;
}

export async function chat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  model = 'llama-3.3-70b-versatile',
  maxTokens = 4096,
): Promise<string> {
  const res = await groq().chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
  });
  return res.choices[0]?.message.content ?? '';
}

export async function fastChat(userMessage: string, systemPrompt?: string): Promise<string> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userMessage });
  return chat(messages, 'llama-3.1-8b-instant', 2048);
}

export async function transcribeAudio(filePath: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const res = await groq().audio.transcriptions.create({
    file:  createReadStream(filePath),
    model: 'whisper-large-v3',
  });
  return res.text;
}
