/**
 * Claude API wrapper — raw fetch (no SDK dependency)
 */

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 500;
const TEMPERATURE = 0.8;

export async function generate(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>;
  };
  const textBlock = data.content.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}

export async function generateEmailReply(
  apiKey: string,
  systemPrompt: string,
  template: string,
  vars: Record<string, string>,
): Promise<string> {
  let prompt = template;
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replace(`{${key}}`, value);
  }
  return generate(apiKey, systemPrompt, prompt);
}

export interface EmoReply {
  reply: string;
  emo_amount: number;
  emo_reason: string;
}

export async function generateEmailReplyWithEmo(
  apiKey: string,
  systemPrompt: string,
  template: string,
  vars: Record<string, string>,
): Promise<EmoReply> {
  let prompt = template;
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replace(`{${key}}`, value);
  }
  const raw = await generate(apiKey, systemPrompt, prompt);

  // Try to parse JSON response
  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      reply: String(parsed.reply || raw),
      emo_amount: Math.min(Math.max(Number(parsed.emo_amount) || 0, 0), 0.1),
      emo_reason: String(parsed.emo_reason || ''),
    };
  } catch {
    // Fallback: treat entire response as reply, no emo-buy
    return { reply: raw, emo_amount: 0, emo_reason: 'JSON parse failed' };
  }
}
