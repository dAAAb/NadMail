/**
 * Claude API wrapper for $DIPLOMAT content generation
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 500;
const TEMPERATURE = 0.8;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function generate(systemPrompt: string, userPrompt: string): Promise<string> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}

export async function generateEmailReply(
  systemPrompt: string,
  template: string,
  vars: Record<string, string>,
): Promise<string> {
  let prompt = template;
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replace(`{${key}}`, value);
  }
  return generate(systemPrompt, prompt);
}
