const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 8080;

// ── VIDEO PATTERNS ──
const VIDEO_EXT = /\.(mp4|webm|m3u8|mkv|ogg)(\?[^"'\s]*)?/i;
const SCRIPT_PATTERNS = [
  /["']file["']\s*:\s*["'](https?[^"']+)/gi,
  /["']src["']\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8|webm)[^"']*)/gi,
  /["']url["']\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8|webm)[^"']*)/gi,
  /["']hls["']\s*:\s*["'](https?[^"']+\.m3u8[^"']*)/gi,
  /["']source["']\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
  /file\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
  /source\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
  /["']videoUrl["']\s*:\s*["'](https?[^"']+)/gi,
  /["']streamUrl["']\s*:\s*["'](https?[^"']+)/gi,
  /["']hlsUrl["']\s*:\s*["'](https?[^"']+\.m3u8[^"']*)/gi,
  /jwplayer\([^)]*\)\.setup\([^}]*["']file["']\s*:\s*["'](https?[^"']+)/gi,
  /playerInstance\.setup\([^}]*["']file["']\s*:\s*["'](https?[^"']+)/gi,
  /VideoJS[^}]*src\s*:\s*["'](https?[^"']+)/gi,
];

function extractUrls(html, baseUrl) {
  const found = new Set();
  const $ = cheerio.load(html);

  // video tags
  $('video, video source').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src && isVideo(src)) found.add(abs(src, baseUrl));
  });

  // iframes
  $('iframe').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src && isEmbed(src)) found.add(abs(src, baseUrl));
  });

  // script tags
  $('script').each((i, el) => {
    const content = $(el).html() || '';
    SCRIPT_PATTERNS.forEach(p => {
      p.lastIndex = 0;
      let m;
      while ((m = p.exec(content)) !== null) {
        const u = m[1].replace(/\\/g, '').split(/['"<>\s]/)[0];
        if (u.startsWith('http') && (isVideo(u) || u.includes('stream'))) found.add(u);
      }
    });
    // raw regex
    const raw = content.match(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8|webm)(?:[^\s"'<>\\]*)?/gi) || [];
    raw.forEach(u => found.add(u.replace(/\\/g, '')));
  });

  // data attributes
  $('[data-src],[data-video],[data-file],[data-url],[data-stream]').each((i, el) => {
    ['data-src','data-video','data-file','data-url','data-stream'].forEach(a => {
      const v = $(el).attr(a);
      if (v && isVideo(v)) found.add(abs(v, baseUrl));
    });
  });

  return [...found].filter(u => u && u.startsWith('http') && u.length < 500);
}

function isVideo(u) {
  return VIDEO_EXT.test(u) || u.includes('googlevideo') || (u.includes('cdn') && /video/i.test(u));
}
function isEmbed(u) {
  return u.includes('youtube.com/embed') || u.includes('dailymotion.com/embed') ||
         u.includes('vimeo.com/video') || u.includes('ok.ru/videoembed');
}
function abs(url, base) {
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  try { return new URL(url, base).href; } catch { return url; }
}

// ── METHOD 1: Simple fetch ──
async function fetchExtract(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,*/*',
        'Accept-Language': 'ar,en;q=0.9',
        'Referer': url,
      },
      timeout: 15000,
    });
    const html = await res.text();
    return extractUrls(html, url);
  } catch (e) {
    return [];
  }
}

// ── METHOD 2: Try iframes too ──
async function deepExtract(url) {
  const main = await fetchExtract(url);
  if (main.filter(isVideo).length > 0) return main;

  // try fetching iframes
  try {
    const res = await fetch(url, {
      headers: {'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0'},
      timeout: 10000,
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    const iframes = [];
    $('iframe').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && src.startsWith('http') && !isEmbed(src)) iframes.push(src);
    });

    for (const iSrc of iframes.slice(0, 4)) {
      const sub = await fetchExtract(iSrc);
      if (sub.filter(isVideo).length > 0) return [...new Set([...main, ...sub])];
    }
  } catch(e) {}

  return main;
}

// ── METHOD 3: Puppeteer (real browser) ──
async function puppeteerExtract(url) {
  let browser;
  try {
    const chromium = require('@sparticuz/chromium');
    const puppeteer = require('puppeteer-core');

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    const found = new Set();

    // intercept network requests to find video URLs
    page.on('request', req => {
      const u = req.url();
      if (isVideo(u)) found.add(u);
    });
    page.on('response', async res => {
      const u = res.url();
      if (isVideo(u)) found.add(u);
      if (res.headers()['content-type']?.includes('application/json')) {
        try {
          const text = await res.text();
          const raw = text.match(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8|webm)(?:[^\s"'<>\\]*)?/gi) || [];
          raw.forEach(v => found.add(v));
        } catch(e) {}
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, {waitUntil: 'networkidle2', timeout: 30000});

    // also check page content
    const html = await page.content();
    const fromHtml = extractUrls(html, url);
    fromHtml.forEach(u => { if(isVideo(u)) found.add(u); });

    // try clicking play buttons
    try {
      await page.click('video, .play-btn, .play-button, [class*="play"], button');
      await page.waitForTimeout(3000);
    } catch(e) {}

    await browser.close();
    return [...found];
  } catch(e) {
    console.error('Puppeteer error:', e.message);
    if (browser) try { await browser.close(); } catch(e2) {}
    return [];
  }
}

// ── MAIN ENDPOINT ──
app.get('/extract', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({error: 'No URL', sources: []});
  console.log('Extracting:', url);

  try {
    // Try simple fetch first (fast)
    let sources = await deepExtract(url);

    // If nothing found, try puppeteer (slow but powerful)
    if (sources.filter(isVideo).length === 0) {
      console.log('Trying puppeteer...');
      const puppSources = await puppeteerExtract(url);
      sources = [...new Set([...sources, ...puppSources])];
    }

    // Sort: mp4 first, then m3u8
    sources.sort((a, b) => {
      const score = u => /\.mp4/i.test(u) ? 3 : /\.m3u8/i.test(u) ? 2 : /\.webm/i.test(u) ? 1 : 0;
      return score(b) - score(a);
    });

    const final = [...new Set(sources)].slice(0, 8);
    console.log('Found:', final.length, 'sources');
    res.json({success: true, sources: final, count: final.length});

  } catch(e) {
    console.error(e);
    res.json({error: e.message, sources: []});
  }
});

app.get('/', (req, res) => {
  res.json({status: 'Party Watch Server 🎬', version: '3.0'});
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));
