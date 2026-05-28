// Thin Anthropic SDK wrapper. See spec §4.1.
// Dependency-injectable factory so tests never hit the real API.
// On error: throws — the decision loop catches and logs as a skip.
import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_DECISION_MODEL } from '../config.js';

export type ClientFactory = () => Anthropic;

const defaultFactory: ClientFactory = () => new Anthropic();

export async function askDecision(
  prompt: string,
  clientFactory: ClientFactory = defaultFactory,
): Promise<string> {
  const client = clientFactory();
  const response = await client.messages.create({
    model: CLAUDE_DECISION_MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
  return stripMarkdownFences(raw);
}

// The model occasionally wraps its JSON in ```json blocks despite instructions.
function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
}
