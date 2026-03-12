// ─── URL CONTENT FETCHER ───────────────────────────────────────────────────
// Handles two types:
//   type=web      → fetch webpage, extract readable text
//   type=youtube  → fetch YouTube transcript + metadata via oEmbed + Invidious
// ───────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, type, videoId } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    if (type === 'youtube') {
      const result = await fetchYouTube(url, videoId);
      return res.status(200).json(result);
    } else {
      const result = await fetchWebpage(url);
      return res.status(200).json(result);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── WEBPAGE ─────────────────────────────────────────────────────────────
async function fetchWebpage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; StrategicResearchBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) throw new Error(`无法访问该页面 (HTTP ${response.status})`);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
    throw new Error('该 URL 不是网页内容（可能是 PDF 或二进制文件）');
  }

  const html = await response.text();
  const title = extractTitle(html);
  const content = extractReadableText(html);

  if (content.length < 100) throw new Error('页面内容提取失败，可能需要登录或被反爬保护');

  return {
    type: 'web',
    title,
    url,
    content: content.slice(0, 20000) // cap at ~20k chars to stay within context
  };
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim() : '';
}

function extractReadableText(html) {
  // Remove scripts, styles, nav, footer, header, aside
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Convert block elements to newlines
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h[1-6][^>]*>/gi, '\n\n## ')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');   // strip remaining tags

  // Decode HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&#\d+;/g, '');

  // Collapse whitespace
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

// ─── YOUTUBE ─────────────────────────────────────────────────────────────
async function fetchYouTube(url, videoId) {
  if (!videoId) throw new Error('无法解析 YouTube 视频 ID');

  // 1) Get title + description via oEmbed (no API key needed)
  let title = '';
  let description = '';
  let authorName = '';
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const oResp = await fetch(oembedUrl, { signal: AbortSignal.timeout(8000) });
    if (oResp.ok) {
      const oData = await oResp.json();
      title = oData.title || '';
      authorName = oData.author_name || '';
    }
  } catch(e) {}

  // 2) Try to get transcript via Invidious (open-source YouTube front-end, no key needed)
  let transcript = '';
  const invidiousInstances = [
    'https://invidious.slipfox.xyz',
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
  ];

  for (const instance of invidiousInstances) {
    try {
      const captionListUrl = `${instance}/api/v1/captions/${videoId}`;
      const captionResp = await fetch(captionListUrl, { signal: AbortSignal.timeout(8000) });
      if (!captionResp.ok) continue;
      const captionData = await captionResp.json();
      const captions = captionData?.captions || [];

      // Prefer zh, zh-Hans, zh-Hant, then en
      const preferred = captions.find(c => /zh/i.test(c.languageCode))
        || captions.find(c => /en/i.test(c.languageCode))
        || captions[0];

      if (!preferred) continue;

      const transcriptUrl = `${instance}/api/v1/captions/${videoId}?label=${encodeURIComponent(preferred.label)}&lang=${preferred.languageCode}`;
      const tResp = await fetch(transcriptUrl, { signal: AbortSignal.timeout(10000) });
      if (!tResp.ok) continue;

      const tText = await tResp.text();
      // Parse VTT/XML-like caption format
      transcript = parseCaptionText(tText);
      if (transcript.length > 50) break; // success
    } catch(e) {
      continue;
    }
  }

  // 3) Try YouTube page itself for description as fallback
  if (!description) {
    try {
      const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        signal: AbortSignal.timeout(10000)
      });
      if (pageResp.ok) {
        const pageHtml = await pageResp.text();
        const descMatch = pageHtml.match(/"description":\{"simpleText":"([\s\S]{10,2000}?)"\}/);
        if (descMatch) {
          description = descMatch[1]
            .replace(/\\n/g, '\n')
            .replace(/\\u0026/g, '&')
            .replace(/\\"/g, '"');
        }
      }
    } catch(e) {}
  }

  // Build final content
  let content = '';
  if (title) content += `【视频标题】${title}\n`;
  if (authorName) content += `【频道】${authorName}\n`;
  content += `【视频链接】${url}\n\n`;
  if (description) content += `【视频描述】\n${description.slice(0, 1000)}\n\n`;
  if (transcript) {
    content += `【视频字幕（逐字稿）】\n${transcript.slice(0, 18000)}\n`;
  } else {
    content += `【注意】该视频没有可用字幕，以下分析基于视频标题和描述内容。\n`;
  }

  if (content.length < 80) throw new Error('无法获取该视频的任何内容，请检查链接是否正确');

  return { type: 'youtube', title, url, content };
}

function parseCaptionText(raw) {
  if (!raw || raw.length < 10) return '';

  // Handle XML/TTML format
  if (raw.includes('<text ') || raw.includes('<p ')) {
    return raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // Handle WebVTT format
  if (raw.includes('WEBVTT') || raw.includes('-->')) {
    return raw
      .split('\n')
      .filter(line => {
        const t = line.trim();
        return t && !t.startsWith('WEBVTT') && !t.includes('-->') && !/^\d+$/.test(t) && !t.startsWith('NOTE');
      })
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Plain text fallback
  return raw.replace(/\s+/g, ' ').trim();
}
