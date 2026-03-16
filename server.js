const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Video URL patterns
const VIDEO_PATTERNS = [
  /https?:\/\/[^\s"'<>\\]+\.mp4(?:[^\s"'<>\\]*)?/gi,
  /https?:\/\/[^\s"'<>\\]+\.m3u8(?:[^\s"'<>\\]*)?/gi,
  /https?:\/\/[^\s"'<>\\]+\.webm(?:[^\s"'<>\\]*)?/gi,
];

const SCRIPT_PATTERNS = [
  /["']file["']\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8|webm)[^"']*)/gi,
  /["']src["']\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
  /["']url["']\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
  /["']source["']\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
  /["']hls["']\s*:\s*["'](https?[^"']+\.m3u8[^"']*)/gi,
  /source\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
  /file\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
  /["']videoUrl["']\s*:\s*["'](https?[^"']+)/gi,
  /["']streamUrl["']\s*:\s*["'](https?[^"']+)/gi,
  /["']hlsUrl["']\s*:\s*["'](https?[^"']+\.m3u8[^"']*)/gi,
];

async function fetchPage(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Referer': url,
    'Cache-Control': 'no-cache',
  };
  const res = await fetch(url, { headers, timeout: 20000 });
  return await res.text();
}

function extractFromHtml(html, baseUrl) {
  const found = new Set();
  const $ = cheerio.load(html);

  // 1. Video tags
  $('video, video source').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
    if (src && isVideoSrc(src)) found.add(makeAbsolute(src, baseUrl));
  });

  // 2. iframes (YouTube, Dailymotion, etc.)
  $('iframe').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src && isEmbedUrl(src)) found.add(src.startsWith('//') ? 'https:' + src : src);
  });

  // 3. Script tags - deep search
  $('script').each((i, el) => {
    const content = $(el).html() || '';
    SCRIPT_PATTERNS.forEach(pattern => {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(content)) !== null) {
        if (m[1] && m[1].startsWith('http')) found.add(m[1].split('\\n')[0].split('"')[0]);
      }
    });
  });

  // 4. Raw regex on full HTML
  VIDEO_PATTERNS.forEach(pattern => {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(html)) !== null) {
      const clean = m[0].replace(/\\+/g, '').replace(/['">\s]/g, '');
      if (clean.startsWith('http')) found.add(clean);
    }
  });

  // 5. data attributes
  $('[data-video-src],[data-src],[data-file],[data-url],[data-stream]').each((i, el) => {
    ['data-video-src','data-src','data-file','data-url','data-stream'].forEach(attr => {
      const val = $(el).attr(attr);
      if (val && isVideoSrc(val)) found.add(makeAbsolute(val, baseUrl));
    });
  });

  return [...found].filter(u => u && u.length < 600);
}

function isVideoSrc(url) {
  return /\.(mp4|webm|m3u8|mkv|ogg)(\?|$|#)/i.test(url) ||
         url.includes('googlevideo.com') ||
         (url.includes('cdn') && /video/i.test(url));
}

function isEmbedUrl(url) {
  return url.includes('youtube.com/embed') ||
         url.includes('dailymotion.com/embed') ||
         url.includes('vimeo.com/video') ||
         url.includes('ok.ru/videoembed') ||
         url.includes('player.');
}

function makeAbsolute(url, base) {
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  try { return new URL(url, base).href; } catch { return url; }
}

// Try to find iframe src and fetch that too
async function fetchIframeSources(html, baseUrl) {
  const found = new Set();
  const $ = cheerio.load(html);
  const iframes = [];

  $('iframe').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src && src.startsWith('http') && !isEmbedUrl(src)) iframes.push(src);
  });

  for (const iframeSrc of iframes.slice(0, 3)) {
    try {
      const iframeHtml = await fetchPage(iframeSrc);
      const sources = extractFromHtml(iframeHtml, iframeSrc);
      sources.forEach(s => found.add(s));
    } catch(e) {}
  }

  return [...found];
}

// Main extract endpoint
app.get('/extract', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ error: 'No URL', sources: [] });

  try {
    // Fetch main page
    const html = await fetchPage(url);
    let sources = extractFromHtml(html, url);

    // If not enough found, try iframes
    if (sources.filter(s => isVideoSrc(s)).length === 0) {
      const iframeSources = await fetchIframeSources(html, url);
      sources = [...new Set([...sources, ...iframeSources])];
    }

    // Sort: direct video files first
    sources.sort((a, b) => {
      const aScore = /\.(mp4|webm)(\?|$)/i.test(a) ? 2 : /\.m3u8/i.test(a) ? 1 : 0;
      const bScore = /\.(mp4|webm)(\?|$)/i.test(b) ? 2 : /\.m3u8/i.test(b) ? 1 : 0;
      return bScore - aScore;
    });

    const final = [...new Set(sources)].slice(0, 8);
    res.json({ success: true, sources: final, count: final.length });

  } catch (err) {
    res.json({ error: err.message, sources: [] });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'Party Watch Server Running 🎬', version: '2.0' });
});

app.listen(PORT, () => console.log(`🎬 Server on port ${PORT}`));


