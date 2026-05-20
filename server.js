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

// ---------------------------------------------------------------------------
// Social tracker
// ---------------------------------------------------------------------------
//
// All three endpoints below are stateless proxies to the upstream platform
// API. The user's API tokens (Shopify) are accepted in the request body, used
// once, and discarded — never persisted server-side. The YouTube key lives in
// .env (`YT_API_KEY`) so it never ships in the iOS/Mac bundles.
//
// We add a simple in-memory rate limiter (30s per IP per endpoint) to avoid
// blowing through the YT free tier (10k units/day) if the same client fans
// out aggressively. It's intentionally not Redis — the worst-case behavior
// when this Render instance restarts is one extra burst of calls; not worth
// a stateful dependency.

const SOCIAL_RATE_WINDOW_MS = 30 * 1000;
const socialRateMap = new Map(); // key: `${ip}:${routeKey}` → lastMs

function rateLimit(req, res, routeKey) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
  const key = `${ip}:${routeKey}`;
  const now = Date.now();
  const last = socialRateMap.get(key) || 0;
  if (now - last < SOCIAL_RATE_WINDOW_MS) {
    const retryIn = Math.ceil((SOCIAL_RATE_WINDOW_MS - (now - last)) / 1000);
    res.status(429).json({ error: `Too many requests. Try again in ${retryIn}s.` });
    return false;
  }
  socialRateMap.set(key, now);
  return true;
}

const YT_API_KEY = process.env.YT_API_KEY;

async function youtubeChannelsList({ id, handle }) {
  if (!YT_API_KEY) throw new Error('YT_API_KEY not set on server');
  const params = new URLSearchParams({
    part: 'statistics,snippet,contentDetails',
    key: YT_API_KEY
  });
  if (id) params.set('id', id);
  if (handle) params.set('forHandle', handle.startsWith('@') ? handle : `@${handle}`);
  const url = `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (!resp.ok) {
    const msg = json?.error?.message || `YouTube API error ${resp.status}`;
    const e = new Error(msg);
    e.status = resp.status;
    throw e;
  }
  const item = json?.items?.[0];
  if (!item) {
    const e = new Error('Channel not found.');
    e.status = 404;
    throw e;
  }
  return item;
}

/// Optional: fetch the most recent upload date by reading the first item of
/// the channel's "uploads" playlist. Costs an extra unit but lets the user
/// see "last uploaded 3 days ago" alongside the other metrics.
async function youtubeLastUploadAt(uploadsPlaylistId) {
  if (!YT_API_KEY || !uploadsPlaylistId) return null;
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=1&playlistId=${encodeURIComponent(uploadsPlaylistId)}&key=${YT_API_KEY}`;
  try {
    const resp = await fetch(url);
    const json = await resp.json();
    const date = json?.items?.[0]?.snippet?.publishedAt;
    return date ? new Date(date).toISOString() : null;
  } catch {
    return null;
  }
}

function buildYouTubeChannelInfo(channel, lastUploadISO) {
  const stats = channel.statistics || {};
  const snip = channel.snippet || {};
  const out = {
    channelID: channel.id,
    title: snip.title || '',
    handle: snip.customUrl ? (snip.customUrl.startsWith('@') ? snip.customUrl : `@${snip.customUrl}`) : null,
    thumbnailURL: snip.thumbnails?.medium?.url || snip.thumbnails?.default?.url || null,
    stats: []
  };
  if (stats.subscriberCount != null) out.stats.push({ key: 'ytSubscribers', value: Number(stats.subscriberCount) });
  if (stats.viewCount != null)       out.stats.push({ key: 'ytViews',       value: Number(stats.viewCount) });
  if (stats.videoCount != null)      out.stats.push({ key: 'ytVideoCount',  value: Number(stats.videoCount) });
  if (lastUploadISO) {
    out.stats.push({ key: 'ytLastUpload', value: new Date(lastUploadISO).getTime() / 1000 });
  }
  return out;
}

/**
 * GET /social/youtube/stats?channelId=...
 * Returns YouTubeChannelInfo with public stats (subs / views / videos) and
 * optionally the last-upload timestamp.
 */
app.get('/social/youtube/stats', async (req, res) => {
  if (!rateLimit(req, res, 'yt:stats')) return;
  try {
    const channelId = (req.query.channelId || '').toString();
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    const channel = await youtubeChannelsList({ id: channelId });
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    const lastUpload = await youtubeLastUploadAt(uploads);
    res.json(buildYouTubeChannelInfo(channel, lastUpload));
  } catch (err) {
    console.error('/social/youtube/stats error:', err);
    res.status(err.status || 500).json({ error: err.message || 'YouTube request failed' });
  }
});

/**
 * GET /social/youtube/resolveHandle?handle=@somechannel
 * Returns the same YouTubeChannelInfo shape as /stats, looked up by handle.
 */
app.get('/social/youtube/resolveHandle', async (req, res) => {
  if (!rateLimit(req, res, 'yt:resolve')) return;
  try {
    const handle = (req.query.handle || '').toString().trim();
    if (!handle) return res.status(400).json({ error: 'handle is required' });
    const channel = await youtubeChannelsList({ handle });
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    const lastUpload = await youtubeLastUploadAt(uploads);
    res.json(buildYouTubeChannelInfo(channel, lastUpload));
  } catch (err) {
    console.error('/social/youtube/resolveHandle error:', err);
    res.status(err.status || 500).json({ error: err.message || 'YouTube request failed' });
  }
});

/// Walks Shopify Admin REST cursor pagination, capped at maxPages so a
/// pathological 50k-order store can't tie up this Render instance for
/// minutes. The cap is generous (5 × 250 = 1250 orders) and almost always
/// enough for a 30-day window.
async function shopifyAllOrders({ shop, token, sinceISO, maxPages = 5 }) {
  let url = `https://${shop}/admin/api/2024-10/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(sinceISO)}`;
  const orders = [];
  for (let i = 0; i < maxPages && url; i++) {
    const resp = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' }
    });
    if (!resp.ok) {
      const body = await resp.text();
      const e = new Error(`Shopify error ${resp.status}: ${body.slice(0, 200)}`);
      e.status = resp.status;
      throw e;
    }
    const json = await resp.json();
    if (Array.isArray(json.orders)) orders.push(...json.orders);
    // Shopify's cursor pagination returns a `Link` header with rel="next".
    const link = resp.headers.get('link') || resp.headers.get('Link') || '';
    const next = link.split(',').map(s => s.trim()).find(s => s.endsWith('rel="next"'));
    if (next) {
      const m = next.match(/^<([^>]+)>/);
      url = m ? m[1] : null;
    } else {
      url = null;
    }
  }
  return orders;
}

/**
 * POST /social/shopify/stats
 * Body: { shop: "store.myshopify.com", token: "shpat_...", sinceDays?: 30 }
 * Aggregates orders / revenue / AOV / refunds / repeat-rate from the Shopify
 * Admin REST API. Token is used and discarded — not persisted server-side.
 */
app.post('/social/shopify/stats', async (req, res) => {
  if (!rateLimit(req, res, 'shopify:stats')) return;
  try {
    let { shop, token, sinceDays } = req.body || {};
    if (!shop || typeof shop !== 'string') return res.status(400).json({ error: 'shop is required' });
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token is required' });
    sinceDays = Number(sinceDays);
    if (!Number.isFinite(sinceDays) || sinceDays <= 0 || sinceDays > 365) sinceDays = 30;

    // Strip protocol/path if user pasted a full URL.
    shop = shop.replace(/^https?:\/\//, '').replace(/\/+$/, '').trim();

    const sinceISO = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
    const orders = await shopifyAllOrders({ shop, token, sinceISO });

    let revenue = 0;
    let refunds = 0;
    const customerOrderCounts = new Map(); // customer.id → count of orders in window

    for (const o of orders) {
      const total = Number(o.total_price || 0);
      revenue += total;
      if (Array.isArray(o.refunds)) {
        for (const r of o.refunds) {
          if (Array.isArray(r.transactions)) {
            for (const t of r.transactions) {
              if (t.kind === 'refund' && t.status === 'success') {
                refunds += Number(t.amount || 0);
              }
            }
          }
        }
      }
      const cid = o.customer?.id;
      if (cid != null) customerOrderCounts.set(cid, (customerOrderCounts.get(cid) || 0) + 1);
    }

    const orderCount = orders.length;
    const aov = orderCount > 0 ? revenue / orderCount : 0;
    const totalCustomers = customerOrderCounts.size;
    const repeatCustomers = [...customerOrderCounts.values()].filter(n => n > 1).length;
    const repeatRate = totalCustomers > 0 ? (repeatCustomers / totalCustomers) * 100 : 0;

    res.json({
      shop,
      windowDays: sinceDays,
      stats: [
        { key: 'shOrders',     value: orderCount },
        { key: 'shRevenue',    value: Number(revenue.toFixed(2)) },
        { key: 'shAOV',        value: Number(aov.toFixed(2)) },
        { key: 'shRefunds',    value: Number(refunds.toFixed(2)) },
        { key: 'shRepeatRate', value: Number(repeatRate.toFixed(1)) }
      ]
    });
  } catch (err) {
    console.error('/social/shopify/stats error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Shopify request failed' });
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
