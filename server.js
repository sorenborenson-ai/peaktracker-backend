require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { Zernio } = require('@zernio/node');
const zernio = new Zernio({ apiKey: process.env.ZERNIO_API_KEY });
const app = express();
app.use(express.json());

// Allow Mac app (and any origin when developing)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const Anthropic = require('@anthropic-ai/sdk');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY not set in .env');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY not set — Stratigize AI routes will fail until added');
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
 * Used for Stratigize conversation — powered by Claude.
 */
app.post('/chat', async (req, res) => {
  try {
    const { messages, systemPrompt } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      temperature: 0.5,
      ...(systemPrompt?.trim() ? { system: systemPrompt.trim() } : {}),
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();
    res.json({ text });
  } catch (err) {
    console.error('Anthropic /chat error:', err);
    const status = err.status || 500;
    const message = err.message || 'Anthropic request failed';
    res.status(status).json({ error: message });
  }
});

/**
 * POST /chat/stream
 * Body: { messages: [{ role, content }], systemPrompt?: string }
 * Streams SSE tokens from Claude so the client can display them in real time.
 */
app.post('/chat/stream', async (req, res) => {
  try {
    const { messages, systemPrompt } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      temperature: 0.5,
      ...(systemPrompt?.trim() ? { system: systemPrompt.trim() } : {}),
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      stream: true,
    });

    for await (const event of stream) {
      // Web search tool call fired → tell client to show "searching" state
      if (event.type === 'content_block_start' &&
          event.content_block?.type === 'server_tool_use') {
        res.write(`data: ${JSON.stringify({ event: 'searching' })}\n\n`);
      }

      // Web search results arrived → send sources to client
      if (event.type === 'content_block_start' &&
          event.content_block?.type === 'web_search_tool_result') {
        const results = event.content_block.content ?? [];
        const sources = results
          .filter(r => r.type === 'web_search_result')
          .map(r => {
            let domain = '';
            try { domain = new URL(r.url ?? '').hostname.replace(/^www\./, ''); } catch {}
            return { title: r.title ?? '', url: r.url ?? '', domain };
          });
        if (sources.length > 0) {
          res.write(`data: ${JSON.stringify({ event: 'sources', sources })}\n\n`);
        }
      }

      // Text tokens
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const token = event.delta.text;
        if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Anthropic /chat/stream error:', err);
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

const SOCIAL_RATE_WINDOW_MS = 10 * 1000;
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

const YT_API_KEY             = process.env.YT_API_KEY;
const YT_OAUTH_CLIENT_ID     = process.env.YT_OAUTH_CLIENT_ID;
const YT_OAUTH_CLIENT_SECRET = process.env.YT_OAUTH_CLIENT_SECRET;
const YT_OAUTH_REDIRECT      = process.env.YT_OAUTH_REDIRECT;
const SUPABASE_URL                = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

/**
 * GET /social/youtube/me
 * Requires: Authorization: Bearer <supabase-access-token>
 * Uses the stored OAuth token to fetch the authenticated user's own channel
 * info (snippet + statistics) without needing to know the channel ID upfront.
 * Returns the same YouTubeChannelInfo shape as /stats and /resolveHandle.
 */
app.get('/social/youtube/me', async (req, res) => {
  try {
    const userId = await requireSupabaseUserId(req);
    const accessToken = await getYouTubeAccessTokenForUser(userId);
    const params = new URLSearchParams({ part: 'snippet,statistics,contentDetails', mine: 'true' });
    const ytResp = await fetch(`https://www.googleapis.com/youtube/v3/channels?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const ytJson = await ytResp.json();
    if (!ytResp.ok) {
      const msg = ytJson?.error?.message || `YouTube API error ${ytResp.status}`;
      const e = new Error(msg); e.status = ytResp.status; throw e;
    }
    const item = ytJson?.items?.[0];
    if (!item) { const e = new Error('No channel found for this account.'); e.status = 404; throw e; }
    const uploads = item.contentDetails?.relatedPlaylists?.uploads;
    const lastUpload = await youtubeLastUploadAt(uploads);
    res.json(buildYouTubeChannelInfo(item, lastUpload));
  } catch (err) {
    console.error('/social/youtube/me error:', err);
    res.status(err.status || 500).json({ error: err.message || 'YouTube request failed' });
  }
});

// ---------------------------------------------------------------------------
// YouTube OAuth + Analytics API (deep channel-owner data)
// ---------------------------------------------------------------------------
//
// Flow: iOS hits /oauth/start with its Supabase bearer → backend 302s to
// Google → Google calls back to /oauth/callback → backend exchanges code,
// persists tokens in Supabase (`yt_oauth_tokens`), then redirects to
// `peaktracker-oauth://youtube/done?status=ok`. After that, iOS calls /analytics
// with its Supabase bearer and the backend uses the stored token.

const ytOAuthState = new Map(); // state → { userId, expiresAt }

function rememberOAuthState(userId) {
  const state = require('crypto').randomBytes(16).toString('hex');
  ytOAuthState.set(state, { userId, expiresAt: Date.now() + 10 * 60 * 1000 });
  for (const [k, v] of ytOAuthState) if (v.expiresAt < Date.now()) ytOAuthState.delete(k);
  return state;
}

function consumeOAuthState(state) {
  const entry = ytOAuthState.get(state);
  if (!entry) return null;
  ytOAuthState.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return entry.userId;
}

/// Verify a Supabase access token against /auth/v1/user and return the user id.
async function requireSupabaseUserId(req) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const e = new Error('Supabase admin not configured on server.');
    e.status = 500; throw e;
  }
  const authHeader = (req.headers.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    const e = new Error('Missing access token.'); e.status = 401; throw e;
  }
  const accessToken = authHeader.slice(7).trim();
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) { const e = new Error('Invalid or expired session.'); e.status = 401; throw e; }
  const user = await resp.json();
  const userId = user?.id;
  if (!userId) { const e = new Error('Could not resolve user id.'); e.status = 401; throw e; }
  return userId;
}

app.get('/social/youtube/oauth/start', async (req, res) => {
  try {
    if (!YT_OAUTH_CLIENT_ID || !YT_OAUTH_REDIRECT) {
      return res.status(500).json({ error: 'YouTube OAuth not configured on server.' });
    }
    const userId = await requireSupabaseUserId(req);
    const state = rememberOAuthState(userId);
    const params = new URLSearchParams({
      client_id: YT_OAUTH_CLIENT_ID,
      redirect_uri: YT_OAUTH_REDIRECT,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/yt-analytics.readonly',
        'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
        'https://www.googleapis.com/auth/youtube.readonly',
      ].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, state });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/social/youtube/oauth/callback', async (req, res) => {
  const appReturn = (status, reason) => {
    const q = new URLSearchParams({ status });
    if (reason) q.set('reason', reason);
    return res.redirect(`peaktracker-oauth://youtube/done?${q.toString()}`);
  };
  try {
    const { code, state, error } = req.query;
    if (error) return appReturn('error', String(error));
    if (!code || !state) return res.status(400).send('Missing code or state.');
    const userId = consumeOAuthState(String(state));
    if (!userId) return res.status(400).send('OAuth state invalid or expired. Try signing in again.');

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: YT_OAUTH_CLIENT_ID,
        client_secret: YT_OAUTH_CLIENT_SECRET,
        redirect_uri: YT_OAUTH_REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error('YT OAuth token exchange failed:', tokens);
      return appReturn('error', 'token_exchange');
    }

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
    const upsertResp = await fetch(`${SUPABASE_URL}/rest/v1/yt_oauth_tokens?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id: userId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token, // only on first consent / prompt=consent
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!upsertResp.ok) {
      console.error('YT OAuth persist failed:', await upsertResp.text());
      return appReturn('error', 'persist');
    }
    appReturn('ok');
  } catch (err) {
    console.error('/social/youtube/oauth/callback error:', err);
    appReturn('error', err.message || 'unknown');
  }
});

/// Returns a fresh access token for `userId`, refreshing via the stored
/// refresh token if the current access token is within 60s of expiry. Throws
/// 401 if the user has no row or no refresh token (force reconnect).
async function getYouTubeAccessTokenForUser(userId) {
  const fetchResp = await fetch(
    `${SUPABASE_URL}/rest/v1/yt_oauth_tokens?user_id=eq.${encodeURIComponent(userId)}&select=*`,
    { headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    } }
  );
  if (!fetchResp.ok) { const e = new Error('Failed to read token store.'); e.status = 500; throw e; }
  const rows = await fetchResp.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) { const e = new Error('YouTube not connected for this user.'); e.status = 404; throw e; }

  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (Date.now() < expiresAt - 60_000) return row.access_token;

  if (!row.refresh_token) {
    const e = new Error('No refresh token on file. Reconnect YouTube.'); e.status = 401; throw e;
  }
  const refreshResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: YT_OAUTH_CLIENT_ID,
      client_secret: YT_OAUTH_CLIENT_SECRET,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const refreshed = await refreshResp.json();
  if (!refreshResp.ok) {
    console.error('YT OAuth refresh failed:', refreshed);
    const e = new Error('Refresh failed. Reconnect YouTube.'); e.status = 401; throw e;
  }
  const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/yt_oauth_tokens?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      access_token: refreshed.access_token,
      expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    }),
  });
  return refreshed.access_token;
}

app.get('/social/youtube/analytics', async (req, res) => {
  if (!rateLimit(req, res, 'yt:analytics')) return;
  try {
    const userId = await requireSupabaseUserId(req);
    let days = Number(req.query.days);
    if (!Number.isFinite(days) || days <= 0 || days > 365) days = 28;
    const accessToken = await getYouTubeAccessTokenForUser(userId);

    const ymd = (d) => d.toISOString().slice(0, 10);
    // Core metrics available to all channels regardless of monetization status.
    // Reach metrics (impressions, impressionsClickThroughRate, uniqueViewers) are
    // fetched separately via /analytics/timeseries. Revenue/card metrics require
    // YouTube Partner Program and cause 400s on non-monetized channels.
    const metricsList = [
      'views',
      'estimatedMinutesWatched',
      'averageViewDuration',
      'averageViewPercentage',
      'subscribersGained',
      'subscribersLost',
      'likes',
      'dislikes',
      'comments',
      'shares',
    ].join(',');

    // Two windows back-to-back so the UI can render the "↑10% vs prior 28d"
    // deltas YT Studio shows. End-of-prior == start-of-current (YouTube
    // Analytics treats startDate as inclusive and endDate as inclusive too,
    // but the day-count math `Date.now() - days*86400000` is what's been
    // shipping; we keep that convention and accept that one boundary day
    // overlaps. Matches what the existing UI assumes "windowDays" means.)
    const now = Date.now();
    const currentStart = ymd(new Date(now - days * 86400 * 1000));
    const currentEnd   = ymd(new Date(now));
    const priorStart   = ymd(new Date(now - 2 * days * 86400 * 1000));
    const priorEnd     = ymd(new Date(now - days * 86400 * 1000));

    const buildParams = (startDate, endDate) => new URLSearchParams({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: metricsList,
    });

    const fetchReport = async (params) => {
      const resp = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await resp.json();
      return { ok: resp.ok, status: resp.status, body };
    };

    const [cur, prev] = await Promise.all([
      fetchReport(buildParams(currentStart, currentEnd)),
      fetchReport(buildParams(priorStart, priorEnd)),
    ]);

    if (!cur.ok) {
      console.error('YT Analytics error (current):', cur.body);
      return res.status(cur.status).json({ error: cur.body?.error?.message || 'YouTube Analytics request failed' });
    }

    const toStats = (report) => {
      const headers = (report.columnHeaders || []).map(h => h.name);
      const row = (report.rows || [])[0] || [];
      return headers.map((name, i) => ({ key: `yt_${name}`, value: Number(row[i] || 0) }));
    };

    const currentStats = toStats(cur.body);
    // Prior window may legitimately have no data (new channel, gap in
    // history). Fall back to an empty array rather than 500ing the whole
    // request — the UI shows the KPI quad without deltas in that case.
    const previousStats = prev.ok ? toStats(prev.body) : [];

    res.json({
      windowDays: days,
      // `stats` mirrors the original shape so older clients keep working.
      stats: currentStats,
      current: { stats: currentStats },
      previous: { stats: previousStats },
    });
  } catch (err) {
    console.error('/social/youtube/analytics error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /social/youtube/analytics/timeseries?days=N
 * Per-day series for the Reach screen's headline chart. Returns one row
 * per day with the four KPI metrics (impressions, views, CTR, unique
 * viewers) plus watch-time minutes. `date` is "YYYY-MM-DD" as YouTube
 * reports it (channel-local timezone).
 */
app.get('/social/youtube/analytics/timeseries', async (req, res) => {
  if (!rateLimit(req, res, 'yt:timeseries')) return;
  try {
    // Try full reach metrics first; fall back to core metrics for non-partner channels.
    let report;
    try {
      report = await runYouTubeAnalyticsReport(req, {
        metrics: 'impressions,views,estimatedMinutesWatched,impressionsClickThroughRate,uniqueViewers',
        dimensions: 'day',
        sort: 'day',
      });
    } catch (_) {
      report = await runYouTubeAnalyticsReport(req, {
        metrics: 'views,estimatedMinutesWatched',
        dimensions: 'day',
        sort: 'day',
      });
    }
    const points = report.rows.map(row => {
      const obj = { impressions: 0, views: 0, estimatedMinutesWatched: 0, impressionsClickThroughRate: 0, uniqueViewers: 0 };
      report.columns.forEach((name, i) => {
        if (name === 'day') obj.date = String(row[i] || '');
        else obj[name] = Number(row[i] || 0);
      });
      return obj;
    });
    res.json({ windowDays: report.windowDays, points });
  } catch (err) {
    console.error('/social/youtube/analytics/timeseries error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/// Shared runner for multi-row YouTube Analytics reports. Returns
/// `{ windowDays, columns, rows }` where columns is the ordered list of
/// dimension + metric names and rows is the raw row array. iOS shapes each
/// dimension's keys via its own decoder.
async function runYouTubeAnalyticsReport(req, { metrics, dimensions, sort, maxResults }) {
  const userId = await requireSupabaseUserId(req);
  let days = Number(req.query.days);
  if (!Number.isFinite(days) || days <= 0 || days > 365) days = 28;
  const accessToken = await getYouTubeAccessTokenForUser(userId);

  const ymd = (d) => d.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    ids: 'channel==MINE',
    startDate: ymd(new Date(Date.now() - days * 86400 * 1000)),
    endDate: ymd(new Date()),
    metrics,
  });
  if (dimensions) params.set('dimensions', dimensions);
  if (sort) params.set('sort', sort);
  if (maxResults) params.set('maxResults', String(maxResults));

  const resp = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const report = await resp.json();
  if (!resp.ok) {
    const e = new Error(report?.error?.message || 'YouTube Analytics request failed');
    e.status = resp.status;
    throw e;
  }
  const columns = (report.columnHeaders || []).map(h => h.name);
  const rows = report.rows || [];
  return { windowDays: days, columns, rows };
}

/**
 * GET /social/youtube/analytics/videos?days=N
 * Top-10 videos by views in the window, with watch time / likes / comments.
 * Backend returns the raw video IDs; iOS hydrates titles + thumbnails
 * separately via /social/youtube/videoMeta if it needs them.
 */
app.get('/social/youtube/analytics/videos', async (req, res) => {
  if (!rateLimit(req, res, 'yt:videos')) return;
  try {
    const report = await runYouTubeAnalyticsReport(req, {
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,comments',
      dimensions: 'video',
      sort: '-views',
      maxResults: 10,
    });
    const videos = report.rows.map(row => {
      const obj = {};
      report.columns.forEach((name, i) => {
        if (name === 'video') obj.videoId = String(row[i] || '');
        else obj[name] = Number(row[i] || 0);
      });
      return obj;
    });
    res.json({ windowDays: report.windowDays, videos });
  } catch (err) {
    console.error('/social/youtube/analytics/videos error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /social/youtube/analytics/traffic?days=N
 * Breakdown by traffic source (search, suggested, browse, external, etc.).
 */
app.get('/social/youtube/analytics/traffic', async (req, res) => {
  if (!rateLimit(req, res, 'yt:traffic')) return;
  try {
    const report = await runYouTubeAnalyticsReport(req, {
      metrics: 'views,estimatedMinutesWatched',
      dimensions: 'insightTrafficSourceType',
      sort: '-views',
    });
    const sources = report.rows.map(row => {
      const obj = {};
      report.columns.forEach((name, i) => {
        if (name === 'insightTrafficSourceType') obj.source = String(row[i] || '');
        else obj[name] = Number(row[i] || 0);
      });
      return obj;
    });
    res.json({ windowDays: report.windowDays, sources });
  } catch (err) {
    console.error('/social/youtube/analytics/traffic error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /social/youtube/analytics/demographics?days=N
 * Viewer age + gender split. Each row is `{ ageGroup, gender, viewerPercentage }`.
 * For small channels YouTube may omit data below a privacy threshold.
 */
app.get('/social/youtube/analytics/demographics', async (req, res) => {
  if (!rateLimit(req, res, 'yt:demographics')) return;
  try {
    const report = await runYouTubeAnalyticsReport(req, {
      metrics: 'viewerPercentage',
      dimensions: 'ageGroup,gender',
      sort: 'gender,ageGroup',
    });
    const buckets = report.rows.map(row => {
      const obj = {};
      report.columns.forEach((name, i) => {
        if (name === 'ageGroup' || name === 'gender') obj[name] = String(row[i] || '');
        else obj[name] = Number(row[i] || 0);
      });
      return obj;
    });
    res.json({ windowDays: report.windowDays, buckets });
  } catch (err) {
    console.error('/social/youtube/analytics/demographics error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /social/youtube/analytics/geography?days=N
 * Top-25 viewer countries by views in the window.
 */
app.get('/social/youtube/analytics/geography', async (req, res) => {
  if (!rateLimit(req, res, 'yt:geography')) return;
  try {
    const report = await runYouTubeAnalyticsReport(req, {
      metrics: 'views,estimatedMinutesWatched',
      dimensions: 'country',
      sort: '-views',
      maxResults: 25,
    });
    const countries = report.rows.map(row => {
      const obj = {};
      report.columns.forEach((name, i) => {
        if (name === 'country') obj.country = String(row[i] || '');
        else obj[name] = Number(row[i] || 0);
      });
      return obj;
    });
    res.json({ windowDays: report.windowDays, countries });
  } catch (err) {
    console.error('/social/youtube/analytics/geography error:', err);
    res.status(err.status || 500).json({ error: err.message });
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

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------
//
// The Swift client sends its Supabase access token as `Authorization: Bearer
// <token>`. We verify the token by calling Supabase's /auth/v1/user with that
// token (which returns the user record if the JWT is valid), then call the
// admin DELETE endpoint with the service-role key. The service-role key never
// ships in the iOS/Mac bundles — that's the whole reason this proxy exists.

app.post('/auth/delete-account', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Supabase admin not configured on server.' });
    }
    const authHeader = (req.headers.authorization || '').trim();
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return res.status(401).json({ error: 'Missing access token.' });
    }
    const accessToken = authHeader.slice(7).trim();
    if (!accessToken) {
      return res.status(401).json({ error: 'Missing access token.' });
    }

    // Verify the access token and resolve the user id.
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!userResp.ok) {
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }
    const user = await userResp.json();
    const userId = user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Could not resolve user id.' });
    }

    const delResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!delResp.ok) {
      const body = await delResp.text().catch(() => '');
      return res.status(delResp.status).json({ error: `Delete failed: ${body.slice(0, 300)}` });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('/auth/delete-account error:', err);
    res.status(500).json({ error: err.message || 'Delete failed' });
  }
});

app.get('/zernio/connect', async (req, res) => {
  try {
    const { platform, profileId } = req.query;
    if (!platform)   return res.status(400).json({ error: 'platform is required' });
    if (!profileId)  return res.status(400).json({ error: 'profileId is required' });
    const { data } = await zernio.connect.getConnectUrl({
      path:  { platform },
      query: { profileId },
    });
    res.json({ authUrl: data.authUrl });
  } catch (err) {
    console.error('/zernio/connect error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/zernio/create-profile' , async (req, res) => {
  try {
    const { data } = await zernio.profiles.createProfile({
      body: {
      name: 'My First Profile',
      description: 'Testing the Zernio API'
      }
    });
    
    console.log('Profile created:', data.profile._id);
    res.json({ profileId: data.profile._id });

  } catch (err) {
    console.error('/zernio/create-profile error:', err);
    res.status(500).json({ error: err.message || 'Zernio create profile failed' });
  }
})

app.post('/zernio/test-instagram' , async (req, res) => {
  try {
    const { data } = await zernio.connect.getConnectUrl({
      path: { platform: 'instagram' },
      query: { profileId: '6a84ad8827fd5d893ec46118' } // the profile _id from Step 1
    });
    console.log('Open this URL:', data.authUrl);
    
    
  } catch (err) {
    console.error('/zernio/create-profile error:', err);
    res.status(500).json({ error: err.message || 'Zernio create profile failed' });
  }
})

app.post('/zernio/list-accounts' , async (req, res) => {
  
  try {
    const { data } = await zernio.accounts.listAccounts();
    for (const account of data.accounts) {
      console.log(`${account.platform}: ${account._id}`);
    }
// → twitter: 66b2e19d8c3f5a7e9d0b1c2d
    
    
  } catch (err) {
    console.error('/zernio/create-profile error:', err);
    res.status(500).json({ error: err.message || 'Zernio create profile failed' });
  }
})
    
  

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
