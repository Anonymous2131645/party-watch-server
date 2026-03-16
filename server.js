const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── EXTRACT VIDEO SOURCES FROM URL ──
app.get('/extract', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ error: 'No URL provided', sources: [] });

  const found = [];

  try {
    // Fetch the page HTML
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en;q=0.9',
        'Referer': url
      },
      timeout: 15000
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    // 1. Direct video tags
    $('video source, video').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && src.startsWith('http') && isVideoUrl(src) && !found.includes(src)) {
        found.push(src);
      }
    });

    // 2. iframe sources (embedded players)
    $('iframe').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && src.startsWith('http')) {
        // Check for known embed patterns
        if (src.includes('youtube.com/embed') || 
            src.includes('dailymotion.com/embed') ||
            src.includes('vimeo.com/video') ||
            src.includes('ok.ru/videoembed')) {
          if (!found.includes(src)) found.push(src);
        }
      }
    });

    // 3. Regex scan for mp4/webm/m3u8 in HTML
    const videoRegex = /https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm|m3u8|mkv)(?:[^"'<>\s\\]*)?/gi;
    const matches = html.match(videoRegex) || [];
    matches.forEach(u => {
      const clean = u.replace(/\\+/g, '').split('"')[0].split("'")[0];
      if (!found.includes(clean)) found.push(clean);
    });

    // 4. JSON data in script tags (common in Arabic movie sites)
    $('script').each((i, el) => {
      const content = $(el).html() || '';
      
      // Look for file: "url" patterns
      const patterns = [
        /["']file["']\s*:\s*["'](https?[^"']+\.mp4[^"']*)/gi,
        /["']src["']\s*:\s*["'](https?[^"']+\.mp4[^"']*)/gi,
        /["']url["']\s*:\s*["'](https?[^"']+\.mp4[^"']*)/gi,
        /["']source["']\s*:\s*["'](https?[^"']+\.mp4[^"']*)/gi,
        /["']hls["']\s*:\s*["'](https?[^"']+\.m3u8[^"']*)/gi,
        /["']m3u8["']\s*:\s*["'](https?[^"']+\.m3u8[^"']*)/gi,
        /sources\s*:\s*\[\s*\{[^}]*["']file["']\s*:\s*["'](https?[^"']+)/gi,
      ];

      patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          if (match[1] && !found.includes(match[1])) {
            found.push(match[1]);
          }
        }
      });

      // Look for jwplayer setup
      const jwMatch = content.match(/jwplayer\([^)]+\)\.setup\((\{[\s\S]*?\})\)/);
      if (jwMatch) {
        try {
          const fileMatch = jwMatch[1].match(/["']file["']\s*:\s*["'](https?[^"']+)/);
          if (fileMatch && !found.includes(fileMatch[1])) found.push(fileMatch[1]);
        } catch(e) {}
      }

      // Look for plyr/videojs sources
      const plyrMatch = content.match(/src\s*:\s*["'](https?[^"']+\.(?:mp4|m3u8)[^"']*)/gi);
      if (plyrMatch) {
        plyrMatch.forEach(m => {
          const u = m.match(/["'](https?[^"']+)/);
          if (u && !found.includes(u[1])) found.push(u[1]);
        });
      }
    });

    // 5. Check for data attributes
    $('[data-video], [data-src], [data-url], [data-file]').each((i, el) => {
      const attrs = ['data-video', 'data-src', 'data-url', 'data-file'];
      attrs.forEach(attr => {
        const val = $(el).attr(attr);
        if (val && val.startsWith('http') && isVideoUrl(val) && !found.includes(val)) {
          found.push(val);
        }
      });
    });

    // Clean and deduplicate
    const cleaned = [...new Set(found)]
      .filter(u => u && u.startsWith('http') && u.length < 500)
      .slice(0, 10);

    res.json({ 
      success: true, 
      sources: cleaned,
      count: cleaned.length,
      url: url
    });

  } catch (err) {
    console.error('Extract error:', err.message);
    res.json({ 
      error: err.message, 
      sources: [],
      count: 0
    });
  }
});

function isVideoUrl(url) {
  return /\.(mp4|webm|m3u8|mkv|ogg|avi)(\?|$)/i.test(url) ||
         url.includes('googlevideo') ||
         url.includes('video') && url.includes('cdn');
}

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ status: 'Party Watch Server Running 🎬', version: '1.0' });
});

app.listen(PORT, () => {
  console.log(`🎬 Party Watch Server running on port ${PORT}`);
});
