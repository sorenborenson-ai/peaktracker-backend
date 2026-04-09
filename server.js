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

// Root route
app.get("/", (req, res) => {
  res.send("Backend is running");
});

/**
 * POST /analyze
 * Body: { userContent: string, systemPrompt: string, temperature?: number }
 * App sends the full system prompt; backend just forwards to OpenAI.
 */
app.post('/analyze', async (req, res) => {
  try {
    const { userContent, systemPrompt, temperature = 0.7 } = req.body;
    if (!userContent || typeof userContent !== 'string') {
      return res.status(400).json({ error: 'userContent is required' });
    }
    if (!systemPrompt || typeof systemPrompt !== 'string') {
      return res.status(400).json({ error: 'systemPrompt is required' });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
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

/**
 * POST /chat/stream
 * Body: { messages: [{ role, content }], systemPrompt?: string }
 * Streams SSE tokens from OpenAI so the client can display them in real time.
 */
app.post('/chat/stream', async (req, res) => {
  try {
    const { messages, systemPrompt } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const apiMessages = [...messages];
    if (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.trim()) {
      apiMessages.unshift({ role: 'system', content: systemPrompt.trim() });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: apiMessages,
      temperature: 0.5,
      max_tokens: 3000,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        res.write(`data: ${JSON.stringify({ token })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('OpenAI /chat/stream error:', err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message || 'Stream failed' });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message || 'Stream failed' })}\n\n`);
      res.end();
    }
  }
});

/**
 * POST /embed
 * Body: { input: string }
 * Returns a 1536-float embedding vector for use with pgvector / search_ai_embeddings.
 */
app.post('/embed', async (req, res) => {
  try {
    const { input } = req.body;
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'input is required' });
    }
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: input.slice(0, 8000),
    });
    const embedding = response.data[0]?.embedding ?? [];
    res.json({ embedding });
  } catch (err) {
    console.error('OpenAI /embed error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Embed failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
