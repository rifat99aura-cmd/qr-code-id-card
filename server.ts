import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const VISITORS_FILE = path.join(DATA_DIR, 'visitors.json');
const SITE_DATA_FILE = path.join(DATA_DIR, 'siteData.json');

// Ensure data and uploads folders exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Support large payloads for direct base64 image uploads from device
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ limit: '30mb', extended: true }));

// Serve uploaded user files directly
app.use('/uploads', express.static(UPLOADS_DIR));

// In-memory real-time visitor structure
interface VisitRecord {
  id: string;
  timestamp: string;
  device: string;
  browser: string;
  platform: string;
  ip: string;
  path: string;
  isNewToday: boolean;
}

interface StoredVisitorData {
  currentDate: string;
  uniqueVisitorIds: string[];
  todayVisitorCount: number;
  todayPageViews: number;
  recentVisits: VisitRecord[];
}

// Active sessions: map visitorId -> lastPingTimestamp (ms)
const activeSessions = new Map<string, number>();

function getTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadVisitorData(): StoredVisitorData {
  const today = getTodayString();
  try {
    if (fs.existsSync(VISITORS_FILE)) {
      const raw = fs.readFileSync(VISITORS_FILE, 'utf-8');
      const data: StoredVisitorData = JSON.parse(raw);
      if (data.currentDate === today) {
        return data;
      }
      // New calendar day starts fresh
      return {
        currentDate: today,
        uniqueVisitorIds: [],
        todayVisitorCount: 0,
        todayPageViews: 0,
        recentVisits: [],
      };
    }
  } catch (err) {
    console.error('Error reading visitors.json:', err);
  }

  return {
    currentDate: today,
    uniqueVisitorIds: [],
    todayVisitorCount: 0,
    todayPageViews: 0,
    recentVisits: [],
  };
}

let visitorState: StoredVisitorData = loadVisitorData();

function saveVisitorData() {
  try {
    fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitorState, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving visitors.json:', err);
  }
}

// Helper to parse user agent
function parseUserAgent(uaString: string = ''): { device: string; browser: string; platform: string } {
  let device = 'Desktop';
  let platform = 'Unknown';
  let browser = 'Browser';

  const ua = uaString.toLowerCase();

  if (/mobile|android|iphone|ipad|ipod|blackberry|opera mini|iemobile/i.test(ua)) {
    device = /ipad|tablet/i.test(ua) ? 'Tablet' : 'Mobile';
  }

  if (ua.includes('windows')) platform = 'Windows';
  else if (ua.includes('android')) platform = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) platform = 'iOS';
  else if (ua.includes('macintosh') || ua.includes('mac os')) platform = 'macOS';
  else if (ua.includes('linux')) platform = 'Linux';

  if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('chrome') && !ua.includes('edg/')) browser = 'Chrome';
  else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'Safari';
  else if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('opera') || ua.includes('opr/')) browser = 'Opera';

  return { device, browser, platform };
}

// Clean stale active sessions older than 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [vid, lastSeen] of activeSessions.entries()) {
    if (now - lastSeen > 60000) {
      activeSessions.delete(vid);
    }
  }
}, 15000);

/**
 * Server-side resolver that inspects external image links and returns direct image URLs.
 * Handles ImgBB viewer pages (ibb.co / ibb.co.com), Google Drive, Dropbox, Imgur, PostImages.
 */
async function resolveDirectImageUrl(inputUrl: string): Promise<string> {
  if (!inputUrl || typeof inputUrl !== 'string') return '';
  let url = inputUrl.trim();

  // If wrapped in HTML img tag or quotes
  const srcMatch = url.match(/src=["'](.*?)["']/i);
  if (srcMatch && srcMatch[1]) url = srcMatch[1].trim();
  url = url.replace(/^["']|["']$/g, '');

  // Google Drive
  const gdriveMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
  if (gdriveMatch && gdriveMatch[1]) {
    return `https://lh3.googleusercontent.com/d/${gdriveMatch[1]}`;
  }
  const gdriveIdMatch = url.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/i);
  if (gdriveIdMatch && gdriveIdMatch[1]) {
    return `https://lh3.googleusercontent.com/d/${gdriveIdMatch[1]}`;
  }

  // Dropbox
  if (url.includes('dropbox.com')) {
    return url.replace(/[?&]dl=0/, '?raw=1').replace(/\?dl=1/, '?raw=1');
  }

  // Imgur gallery/page
  if (url.includes('imgur.com/') && !url.includes('i.imgur.com/')) {
    const imgurMatch = url.match(/imgur\.com\/([a-zA-Z0-9]+)$/);
    if (imgurMatch && imgurMatch[1]) {
      return `https://i.imgur.com/${imgurMatch[1]}.jpg`;
    }
  }

  // ImgBB webpage viewer (e.g. ibb.co/XYZ or ibb.co.com/XYZ)
  const isIbbViewer = /(?:ibb\.co|ibb\.co\.com)\/([a-zA-Z0-9]+)/i.test(url) && !url.includes('i.ibb.co/');
  // PostImages viewer page (postimg.cc/XYZ)
  const isPostImgViewer = /postimg\.cc\/([a-zA-Z0-9]+)/i.test(url) && !url.includes('i.postimg.cc/');

  if (isIbbViewer || isPostImgViewer) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8',
        },
      });
      clearTimeout(timeoutId);

      if (resp.ok) {
        const html = await resp.text();

        // 1. Check og:image meta tag
        const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        if (ogMatch && ogMatch[1] && ogMatch[1].startsWith('http')) {
          return ogMatch[1];
        }

        // 2. Check image_src link
        const imgLinkMatch = html.match(/<link[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i);
        if (imgLinkMatch && imgLinkMatch[1] && imgLinkMatch[1].startsWith('http')) {
          return imgLinkMatch[1];
        }

        // 3. For ImgBB specifically, search for direct i.ibb.co image pattern
        const directIbb = html.match(/https:\/\/i\.ibb\.co\/[a-zA-Z0-9]+\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp|gif)/i);
        if (directIbb && directIbb[0]) {
          return directIbb[0];
        }
      }
    } catch (err) {
      console.warn(`Could not resolve direct image for ${url}:`, err);
    }
  }

  return url;
}

// API ROUTES
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', serverTime: new Date().toISOString() });
});

// Ping endpoint called by clients
app.post('/api/visitors/ping', (req: Request, res: Response) => {
  const today = getTodayString();
  if (visitorState.currentDate !== today) {
    visitorState = {
      currentDate: today,
      uniqueVisitorIds: [],
      todayVisitorCount: 0,
      todayPageViews: 0,
      recentVisits: [],
    };
  }

  const visitorId = (req.body.visitorId || req.ip || 'anon').toString().trim();
  const reqPath = (req.body.path || '/').toString();
  const uaString = req.headers['user-agent'] || '';
  const { device, browser, platform } = parseUserAgent(uaString);

  activeSessions.set(visitorId, Date.now());

  let isNewToday = false;
  if (!visitorState.uniqueVisitorIds.includes(visitorId)) {
    visitorState.uniqueVisitorIds.push(visitorId);
    visitorState.todayVisitorCount += 1;
    isNewToday = true;
  }

  visitorState.todayPageViews += 1;

  // Add to recent visits log (limit to 40)
  const logItem: VisitRecord = {
    id: `v-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    device,
    browser,
    platform,
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').toString().split(',')[0].trim(),
    path: reqPath,
    isNewToday,
  };

  visitorState.recentVisits = [logItem, ...(visitorState.recentVisits || [])].slice(0, 40);
  saveVisitorData();

  const activeNow = Math.max(1, activeSessions.size);

  res.json({
    success: true,
    today: visitorState.currentDate,
    todayVisitorCount: visitorState.todayVisitorCount,
    todayPageViews: visitorState.todayPageViews,
    activeNow,
    isNewToday,
  });
});

// Stats endpoint for admin dashboard & client
app.get('/api/visitors/stats', (_req: Request, res: Response) => {
  const today = getTodayString();
  if (visitorState.currentDate !== today) {
    visitorState = {
      currentDate: today,
      uniqueVisitorIds: [],
      todayVisitorCount: 0,
      todayPageViews: 0,
      recentVisits: [],
    };
    saveVisitorData();
  }

  const activeNow = Math.max(1, activeSessions.size);

  res.json({
    currentDate: visitorState.currentDate,
    todayVisitorCount: visitorState.todayVisitorCount,
    todayPageViews: visitorState.todayPageViews,
    activeNow,
    recentVisits: visitorState.recentVisits,
    isGenuine: true,
  });
});

// Admin reset or sync visitors
app.post('/api/visitors/reset', (req: Request, res: Response) => {
  const baseCount = parseInt(req.body.baseCount, 10);
  visitorState = {
    currentDate: getTodayString(),
    uniqueVisitorIds: [],
    todayVisitorCount: !isNaN(baseCount) && baseCount >= 0 ? baseCount : 0,
    todayPageViews: !isNaN(baseCount) && baseCount >= 0 ? baseCount : 0,
    recentVisits: [],
  };
  saveVisitorData();
  res.json({ success: true, todayVisitorCount: visitorState.todayVisitorCount });
});

// Direct Image URL Resolver Endpoint
app.get('/api/resolve-image', async (req: Request, res: Response) => {
  const target = (req.query.url || '').toString();
  if (!target) {
    return res.json({ original: '', directUrl: '' });
  }
  const directUrl = await resolveDirectImageUrl(target);
  res.json({ original: target, directUrl });
});

// Device Image Upload Endpoint
app.post('/api/upload', (req: Request, res: Response) => {
  try {
    const { data, filename } = req.body;
    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'Missing base64 data' });
    }

    // Parse base64
    const matches = data.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    let buffer: Buffer;
    let ext = 'jpg';

    if (matches && matches.length === 3) {
      const mime = matches[1];
      if (mime.includes('png')) ext = 'png';
      else if (mime.includes('webp')) ext = 'webp';
      else if (mime.includes('gif')) ext = 'gif';
      else ext = 'jpg';
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      buffer = Buffer.from(data, 'base64');
    }

    const safeName = `photo-${Date.now()}-${Math.floor(Math.random() * 10000)}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, safeName);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/${safeName}`;
    return res.json({ success: true, url: publicUrl, filename: safeName });
  } catch (err) {
    console.error('Error saving uploaded image:', err);
    res.status(500).json({ error: 'Failed to save image' });
  }
});

// Persistent site data API
app.get('/api/site-data', (_req: Request, res: Response) => {
  try {
    if (fs.existsSync(SITE_DATA_FILE)) {
      const data = fs.readFileSync(SITE_DATA_FILE, 'utf-8');
      return res.json(JSON.parse(data));
    }
  } catch (err) {
    console.error('Error reading siteData.json:', err);
  }
  res.json(null);
});

app.post('/api/site-data', async (req: Request, res: Response) => {
  try {
    const updated = req.body;
    if (!updated || typeof updated !== 'object') {
      return res.status(400).json({ error: 'Invalid data payload' });
    }

    // Auto-resolve any viewer URLs before saving
    if (updated.profilePhotoUrl) {
      updated.profilePhotoUrl = await resolveDirectImageUrl(updated.profilePhotoUrl);
    }
    if (updated.schoolPhotoUrl) {
      updated.schoolPhotoUrl = await resolveDirectImageUrl(updated.schoolPhotoUrl);
    }
    if (updated.schoolLogoUrl) {
      updated.schoolLogoUrl = await resolveDirectImageUrl(updated.schoolLogoUrl);
    }
    if (updated.gamingPhotoUrl) {
      updated.gamingPhotoUrl = await resolveDirectImageUrl(updated.gamingPhotoUrl);
    }

    // Auto-resolve photos in gallery
    if (Array.isArray(updated.galleryPhotos)) {
      for (const photo of updated.galleryPhotos) {
        if (photo && photo.url) {
          photo.url = await resolveDirectImageUrl(photo.url);
        }
      }
    }

    fs.writeFileSync(SITE_DATA_FILE, JSON.stringify(updated, null, 2), 'utf-8');
    return res.json({ success: true, updated });
  } catch (err) {
    console.error('Error writing siteData.json:', err);
    res.status(500).json({ error: 'Failed to persist site data' });
  }
});

// START SERVER WITH VITE MIDDLEWARE IN DEV OR STATIC IN PROD
async function start() {
  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.join(__dirname, 'dist');

  if (isProd && fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    // Mount Vite middlewares
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        port: PORT,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
