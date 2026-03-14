require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

// Allow Mac app (and any origin when developing)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY not set in .env');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

const PORT = process.env.PORT || 3000;

/**
 * POST /analyze
 * Body: { userContent: string, systemPrompt?: string, temperature?: number }
 * Used for habit feedback and load analysis.
 */
app.post('/analyze', async (req, res) => {
  try {
    const { userContent, systemPrompt: customPrompt, temperature = 0.7 } = req.body;
    if (!userContent || typeof userContent !== 'string') {
      return res.status(400).json({ error: 'userContent is required' });
    }

    const dateTime = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
    const habitSystemPrompt = `You are an ambitious, positive, yet brutally honest performance coach, like a successful entrepreneur friend.
Never start with anything like 'Alright,' just get straight to the point.
Evaluate the entire habit list as a whole.
You are evaluating primarily the habits list, not the targets list but you can give habit recomendations for their targets.
use two sentances to get your point across
Put a line break between each sentence so each sentence is on its own line.
Be constructive, direct, and concise — do not use motivational fluff.
Make it feel like human feedback, not a report.
And can play along if their habits are obviously a joke.
Do not use bold section labels like **Example** or **Note**. If you need a heading, use a markdown header instead (e.g. "# Title" or "## Subtitle") so it renders as a larger font.`;

    const systemContent = customPrompt && customPrompt.trim()
      ? `Current date and time: ${dateTime}.\n\n${customPrompt}`
      : `Current date and time: ${dateTime}.\n\n${habitSystemPrompt}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
      ],
      temperature: Number(temperature),
      max_tokens: 500
    });

    let text = completion.choices[0]?.message?.content?.trim() || '';
    if (text) {
      text = text.replace(/\. /g, '.\n\n').replace(/! /g, '!\n\n').replace(/\? /g, '?\n\n');
      text = text.replace(/\.\n\n\n/g, '.\n\n').replace(/!\n\n\n/g, '!\n\n').replace(/\?\n\n\n/g, '?\n\n').trim();
    }

    res.json({ text });
  } catch (err) {
    console.error('OpenAI /analyze error:', err);
    const status = err.status || 500;
    const message = err.message || 'OpenAI request failed';
    res.status(status).json({ error: message });
  }
});

/**
 * POST /chat
 * Body: { messages: [{ role: string, content: string }], systemPrompt?: string }
 * Used for Stratigize conversation.
 */
app.post('/chat', async (req, res) => {
  try {
    const { messages, systemPrompt } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const apiMessages = [...messages];
    if (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.trim()) {
      apiMessages.unshift({ role: 'system', content: systemPrompt.trim() });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: apiMessages,
      temperature: 0.5,
      max_tokens: 3000
    });

    const text = (completion.choices[0]?.message?.content ?? '').trim();
    res.json({ text });
  } catch (err) {
    console.error('OpenAI /chat error:', err);
    const status = err.status || 500;
    const message = err.message || 'OpenAI request failed';
    res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`PeakTracker backend running on port ${PORT}`);
});
