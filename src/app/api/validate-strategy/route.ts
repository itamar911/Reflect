import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { name, description, entry_conditions } = await request.json() as {
    name: string;
    description: string;
    entry_conditions: string[];
  };

  const prompt = `You are validating a trading strategy description. Determine if this is a genuine trading strategy or meaningless/insufficient text.
Name: ${name}
Description: ${description}
Entry conditions: ${JSON.stringify(entry_conditions)}
Return ONLY JSON: { "valid": true/false, "feedback": "short feedback in Hebrew explaining what's missing if invalid, empty string if valid" }`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return NextResponse.json({ error: 'No text response' }, { status: 502 });
    }

    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (!match) {
      return NextResponse.json({ error: 'Could not parse response' }, { status: 502 });
    }

    const parsed = JSON.parse(match[0]) as { valid: boolean; feedback: string };
    return NextResponse.json(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
