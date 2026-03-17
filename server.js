const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 8080;

// ══ VIDEO PATTERNS ══
const VIDEO_EXT = /\.(mp4|webm|m3u8|mpd|mkv|ogg)(\?[^"'\s<>]*)?($|[^a-zA-Z])/i;
const SCRIPT_PATTERNS = [
  /["']file["']\s*:\s*["'](https?[^"'\\]+)/gi,
  /["']src["']\s*:\s*["'](https?[^"'\\]+\.(?:mp4|m3u8|mpd|webm)[^"'\\]*)/gi,
  /["']url["']\s*:\s*["'](https?[^"'\\]+\.(?:mp4|m3u8|mpd|webm)[^"'\\]*)/gi,
  /["']hls["']\s*:\s*["'](https?[^"'\\]+)/gi,
  /["']dash["']\s*:\s*["'](https?[^"'\\]+)/gi,
  /["']source["']\s*:\s*["'](https?[^"'\\]+\.(?:mp4|m3u8|mpd)[^"'\\]*)/gi,
  /["']hlsUrl["']\s*:\s*["'](https?[^"'\\]+)/gi,
  /["']dashUrl["']\s*:\s*["'](https?[^"'\\]+)/gi,
  /["']streamUrl["']\s*:\s*["'](https?[^"'\\]+)/gi,
  /["']videoUrl["']\s*:\s*["'](https?[^"'\\]+)/gi,
  /["']masterUrl["']\s*:\s*["'](https?[^"'\\]+)/gi,
  /source\s*:\s*["'](https?[^"'\\]+\.(?:mp4|m3u8|mpd)[^"'\\]*)/gi,
  /file\s*:\s*["'](https?[^"'\\]+\.(?:mp4|m3u8|mpd)[^"'\\]*)/gi,
  /jwplayer[^.]*\.setup\s*\(\s*\{[^}]*["']file["']\s*:\s*["'](https?[^"']+)/gi,
  /player\.src\s*\(\s*\[\s*\{[^}]*src\s*:\s*["'](https?[^"']+)/gi,
  /["'](?:480|720|1080|360|240)p["']\s*:\s*["'](https?[^"']+)/gi,
];

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

function isVideo(u) {
  if (!u || !u.startsWith('http')) return false;
  return VIDEO_EXT.test(u) || 
         u.includes('googlevideo.com') ||
         (u.includes('.m3u8')) ||
         (u.includes('.mpd'));
}

function isEmbed(u) {
  return u.includes('youtube.com/embed') || u.includes('dailymotion.com/embed') ||
         u.includes('vimeo.com/video') || u.includes('ok.ru/videoembed');
}

function getType(u) {
  if (/\.mp4/i.test(u)) return 'mp4';
  if (/\.m3u8/i.test(u)) return 'm3u8';
  if (/\.mpd/i.test(u)) return 'mpd';
  if (/\.webm/i.test(u)) return 'webm';
  return 'video';
}

function abs(url, base) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  try { return new URL(url, base).href; } catch { return url; }
}

function cleanUrl(u) {
  return u.replace(/\\/g, '').replace(/['"<>\s]/g, '').split('\n')[0];
}

function extractFromHtml(html, baseUrl) {
  const found = new Map(); // url -> type
  const $ = cheerio.load(html);

  // video tags
  $('video, video source').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
    const clean = abs(src, baseUrl);
    if (clean && isVideo(clean)) found.set(clean, getType(clean));
  });

  // ★ anchor tags linking to video files (like reviewrate embeds)
  $('a[href]').each((i, el) => {
    const href = abs($(el).attr('href') || '', baseUrl);
    if (href && isVideo(href)) found.set(href, getType(href));
  });

  // ★ img tags inside anchor tags (thumbnail links to video)
  $('a img').each((i, el) => {
    const parentHref = abs($(el).parent().attr('href') || '', baseUrl);
    if (parentHref && isVideo(parentHref)) found.set(parentHref, getType(parentHref));
  });

  // iframes
  $('iframe').each((i, el) => {
    const src = abs($(el).attr('src') || $(el).attr('data-src') || '', baseUrl);
    if (src && isEmbed(src)) found.set(src, 'embed');
  });

  // scripts - deep pattern matching
  $('script').each((i, el) => {
    const content = $(el).html() || '';

    SCRIPT_PATTERNS.forEach(pattern => {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(content)) !== null) {
        const u = cleanUrl(m[1]);
        if (u.startsWith('http') && u.length < 500) {
          if (isVideo(u)) found.set(u, getType(u));
          else if (u.includes('stream') || u.includes('hls') || u.includes('dash')) {
            found.set(u, 'stream');
          }
        }
      }
    });

    // raw regex scan
    const rawMp4 = content.match(/https?:\/\/[^\s"'<>\\]+\.mp4(?:[^\s"'<>\\]*)?/gi) || [];
    const rawM3u8 = content.match(/https?:\/\/[^\s"'<>\\]+\.m3u8(?:[^\s"'<>\\]*)?/gi) || [];
    const rawMpd = content.match(/https?:\/\/[^\s"'<>\\]+\.mpd(?:[^\s"'<>\\]*)?/gi) || [];
    [...rawMp4, ...rawM3u8, ...rawMpd].forEach(u => {
      const clean = cleanUrl(u);
      if (clean.startsWith('http')) found.set(clean, getType(clean));
    });
  });

  // data attributes
  $('[data-src],[data-video],[data-file],[data-url],[data-stream],[data-hls]').each((i, el) => {
    ['data-src','data-video','data-file','data-url','data-stream','data-hls'].forEach(attr => {
      const v = abs($(el).attr(attr) || '', baseUrl);
      if (v && isVideo(v)) found.set(v, getType(v));
    });
  });

  return found;
}

// ── FETCH METHOD ──
async function fetchExtract(url) {
  const found = new Map();
  try {
    const res = await fetch(url, {
      headers: { ...FETCH_HEADERS, 'Referer': url },
      timeout: 15000,
      follow: 5,
    });
    const html = await res.text();
    const fromHtml = extractFromHtml(html, url);
    fromHtml.forEach((type, u) => found.set(u, type));

    // try sub-iframes
    const $ = cheerio.load(html);
    const iframes = [];
    $('iframe').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && src.startsWith('http') && !isEmbed(src)) iframes.push(abs(src, url));
    });

    for (const iSrc of iframes.slice(0, 5)) {
      try {
        const iRes = await fetch(iSrc, {
          headers: { ...FETCH_HEADERS, 'Referer': url },
          timeout: 10000,
        });
        const iHtml = await iRes.text();
        const iFound = extractFromHtml(iHtml, iSrc);
        iFound.forEach((type, u) => found.set(u, type));
      } catch(e) {}
    }
  } catch(e) { console.log('fetch error:', e.message); }
  return found;
}

// ── PUPPETEER METHOD ──
async function puppeteerExtract(url) {
  const found = new Map();
  let browser;
  try {
    const chromium = require('@sparticuz/chromium');
    const puppeteer = require('puppeteer-core');

    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 720 },
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();

    await page.setUserAgent(FETCH_HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({'Accept-Language': 'ar,en;q=0.9'});

    // intercept ALL requests
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (isVideo(u)) found.set(u, getType(u));
      req.continue();
    });
    page.on('response', async res => {
      const u = res.url();
      if (isVideo(u)) found.set(u, getType(u));
      // check JSON responses for video urls
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json') || ct.includes('javascript')) {
        try {
          const text = await res.text().catch(() => '');
          const m3u8 = text.match(/https?:\/\/[^\s"'<>\\]+\.m3u8(?:[^\s"'<>\\]*)?/gi) || [];
          const mp4 = text.match(/https?:\/\/[^\s"'<>\\]+\.mp4(?:[^\s"'<>\\]*)?/gi) || [];
          const mpd = text.match(/https?:\/\/[^\s"'<>\\]+\.mpd(?:[^\s"'<>\\]*)?/gi) || [];
          [...m3u8,...mp4,...mpd].forEach(v => { const c=cleanUrl(v); if(c.startsWith('http'))found.set(c,getType(c)); });
        } catch(e) {}
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // try clicking play
    try {
      await page.evaluate(() => {
        const btns = document.querySelectorAll('video, button[class*="play"], .play-btn, .play-button, [class*="play-icon"]');
        btns.forEach(b => { try { b.click(); } catch(e) {} });
      });
      await page.waitForTimeout(3000);
    } catch(e) {}

    // get page HTML too
    const html = await page.content();
    const fromHtml = extractFromHtml(html, url);
    fromHtml.forEach((type, u) => found.set(u, type));

    await browser.close();
  } catch(e) {
    console.error('Puppeteer error:', e.message);
    if (browser) try { await browser.close(); } catch(e2) {}
  }
  return found;
}

function sortSources(sources) {
  const priority = { mp4: 4, m3u8: 3, mpd: 2, webm: 1, stream: 1, embed: 0, video: 0 };
  return sources.sort((a, b) => (priority[b.type] || 0) - (priority[a.type] || 0));
}

// ── MAIN ENDPOINT ──
app.get('/extract', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ error: 'No URL', sources: [] });
  console.log('Extracting:', url);

  try {
    // Try fetch first (fast, ~2-3s)
    let found = await fetchExtract(url);

    // If no video found, try puppeteer (slow, ~15-30s but powerful)
    const videoCount = [...found.values()].filter(t => t !== 'embed').length;
    if (videoCount === 0) {
      console.log('No videos found with fetch, trying puppeteer...');
      const puppFound = await puppeteerExtract(url);
      puppFound.forEach((type, u) => found.set(u, type));
    }

    // Build result
    const sources = [...found.entries()].map(([url, type]) => ({ url, type }));
    const sorted = sortSources(sources);
    const final = sorted.slice(0, 10);

    console.log('Result:', final.length, 'sources');
    res.json({ success: true, sources: final, count: final.length });

  } catch(e) {
    console.error(e);
    res.json({ error: e.message, sources: [] });
  }
});

// ── VIDEO PROXY - bypass hotlink protection ──
app.get('/proxy', async (req, res) => {
  const videoUrl = req.query.url;
  const referer = req.query.ref || '';
  if (!videoUrl) return res.status(400).send('No URL');

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Referer': referer || new URL(videoUrl).origin,
      'Origin': referer ? new URL(referer).origin : new URL(videoUrl).origin,
      'Accept': '*/*',
      'Accept-Language': 'ar,en;q=0.9',
      'Range': req.headers['range'] || '',
    };

    const response = await fetch(videoUrl, { headers, timeout: 30000 });

    // forward headers
    const ct = response.headers.get('content-type');
    const cl = response.headers.get('content-length');
    const cr = response.headers.get('content-range');
    const ac = response.headers.get('accept-ranges');

    if (ct) res.setHeader('Content-Type', ct);
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    if (ac) res.setHeader('Accept-Ranges', ac || 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(response.status);

    response.body.pipe(res);
  } catch(e) {
    res.status(500).send(e.message);
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'Party Watch Server 🎬', version: '3.1' });
});

app.listen(PORT, () => console.log(`🎬 Server on port ${PORT}`));
