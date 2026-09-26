require('dotenv').config();

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { chromium } = require('playwright');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 10000);
const URLS_FILE = process.env.URLS_FILE || './urls.txt';
const SETTINGS_FILE = process.env.SETTINGS_FILE || './recorder-settings.json';
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || './recordings';
const RECORD_SECONDS = clampSeconds(process.env.RECORD_SECONDS || 30);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 60000);
const PAGE_WARMUP_MS = Number(process.env.PAGE_WARMUP_MS || 3000);
const AUTO_START = String(process.env.AUTO_START || 'false').toLowerCase() === 'true';
const DELETE_LOCAL_AFTER_UPLOAD = String(process.env.DELETE_LOCAL_AFTER_UPLOAD || 'false').toLowerCase() === 'true';
const APP_VERSION = '20.8.1';
const B2_PREFIX = 'recordings/';

const QUALITY_PRESETS = Object.freeze({
  '240p': { width: 426, height: 240 },
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '540p': { width: 960, height: 540 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
});

const SITE_PRESETS = Object.freeze({
  wispbyte: { label: 'Wispbyte Home', url: 'https://wispbyte.com/', quality: '480p', recordSeconds: 30, warmupMs: 5000 },
});

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

function clampSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(3600, Math.max(1, Math.round(n)));
}

function cleanEndpoint(value) {
  return String(value || '').trim().replace(/^['"]+|['"]+$/g, '').replace(/\/+$/, '');
}

const B2_ENDPOINT = cleanEndpoint(process.env.B2_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com');
const B2_REGION = String(process.env.B2_REGION || 'us-east-005').trim();
const B2_BUCKET = String(process.env.B2_BUCKET || '').trim();
const B2_KEY_ID = String(process.env.B2_KEY_ID || '').trim();
const B2_APPLICATION_KEY = String(process.env.B2_APPLICATION_KEY || '').trim();

let b2EndpointError = null;
try {
  const parsed = new URL(B2_ENDPOINT);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Endpoint must use http:// or https://');
} catch {
  b2EndpointError = `Invalid B2_ENDPOINT: ${B2_ENDPOINT || '(empty)'}`;
}

const b2Configured = Boolean(!b2EndpointError && B2_ENDPOINT && B2_REGION && B2_BUCKET && B2_KEY_ID && B2_APPLICATION_KEY);
const s3 = b2Configured ? new S3Client({
  region: B2_REGION,
  endpoint: B2_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APPLICATION_KEY },
}) : null;

let settings = loadSettings();
let browser = null;
let runPromise = null;
let stopRequested = false;
let activePage = null;
let activeContext = null;
let running = false;
let currentUrl = null;
let currentIndex = null;
let totalUrls = 0;
let activeRunUrls = [];
let activeRunSettings = null;
let lastResult = null;
let lastError = null;
let livePreviewBuffer = null;
let livePreviewUpdatedAt = null;
let runStartedAt = null;

function loadSettings() {
  const defaultQuality = QUALITY_PRESETS[process.env.DEFAULT_QUALITY] ? process.env.DEFAULT_QUALITY : '480p';
  const fallback = {
    quality: defaultQuality,
    width: QUALITY_PRESETS[defaultQuality].width,
    height: QUALITY_PRESETS[defaultQuality].height,
    recordSeconds: RECORD_SECONDS,
    warmupMs: PAGE_WARMUP_MS,
  };
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const quality = QUALITY_PRESETS[parsed.quality] ? parsed.quality : fallback.quality;
    const seconds = Number.isFinite(Number(parsed.recordSeconds)) ? clampSeconds(parsed.recordSeconds) : fallback.recordSeconds;
    const warmupMs = Number.isFinite(Number(parsed.warmupMs)) ? Math.min(30000, Math.max(0, Math.round(Number(parsed.warmupMs)))) : fallback.warmupMs;
    return { quality, width: QUALITY_PRESETS[quality].width, height: QUALITY_PRESETS[quality].height, recordSeconds: seconds, warmupMs };
  } catch (err) {
    console.log(`Settings load warning: ${err.message}`);
    return fallback;
  }
}

function saveSettings(next) {
  const quality = QUALITY_PRESETS[next.quality] ? next.quality : settings.quality;
  const recordSeconds = clampSeconds(next.recordSeconds ?? settings.recordSeconds);
  const warmupMs = Number.isFinite(Number(next.warmupMs)) ? Math.min(30000, Math.max(0, Math.round(Number(next.warmupMs)))) : settings.warmupMs;
  settings = {
    quality,
    width: QUALITY_PRESETS[quality].width,
    height: QUALITY_PRESETS[quality].height,
    recordSeconds,
    warmupMs,
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

function normalizeUrls(input) {
  const values = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value || value.startsWith('#')) continue;
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Only http:// and https:// URLs are allowed: ${value}`);
    const normalized = u.toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function readUrls() {
  if (!fs.existsSync(URLS_FILE)) return [];
  return normalizeUrls(fs.readFileSync(URLS_FILE, 'utf8'));
}

function writeUrls(urls) {
  const clean = normalizeUrls(urls);
  fs.writeFileSync(URLS_FILE, clean.length ? `${clean.join('\n')}\n` : '');
  return clean;
}

function safeFilePart(value) {
  return String(value)
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90) || 'page';
}

function makeFilename(index, url) {
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const host = safeFilePart(new URL(url).hostname);
  return `${String(index + 1).padStart(3, '0')}_${stamp}_${host}.webm`;
}

function validateKey(key) {
  const value = String(key || '');
  if (!value.startsWith(B2_PREFIX) || value.includes('..') || !/\.webm$/i.test(value)) throw new Error('Invalid recording key.');
  return value;
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

async function uploadToB2(localPath, key) {
  if (!s3) throw new Error('B2 is not configured.');
  await s3.send(new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
    Body: fs.createReadStream(localPath),
    ContentType: 'video/webm',
    ServerSideEncryption: 'AES256',
  }));
}

async function listB2Files() {
  if (!s3) throw new Error('B2 is not configured.');
  const all = [];
  let ContinuationToken;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: B2_BUCKET,
      Prefix: B2_PREFIX,
      MaxKeys: 1000,
      ContinuationToken,
    }));
    all.push(...(out.Contents || []));
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);

  return all
    .filter(x => x.Key && /\.webm$/i.test(x.Key))
    .sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0))
    .map(x => ({
      key: x.Key,
      filename: x.Key.slice(B2_PREFIX.length),
      size: x.Size || 0,
      lastModified: x.LastModified || null,
      previewUrl: `/api/preview?key=${encodeURIComponent(x.Key)}`,
      downloadUrl: `/api/download?key=${encodeURIComponent(x.Key)}`,
    }));
}

function safeStatus() {
  let savedUrls = [];
  try { savedUrls = readUrls(); } catch (err) { lastError = `URL file error: ${err.message}`; }
  return {
    ok: true,
    version: APP_VERSION,
    running,
    currentUrl,
    currentIndex,
    totalUrls,
    urls: running ? activeRunUrls.slice() : savedUrls,
    savedUrls,
    settings,
    qualityPresets: QUALITY_PRESETS,
    b2Configured,
    bucket: B2_BUCKET || null,
    region: B2_REGION,
    endpoint: B2_ENDPOINT,
    endpointError: b2EndpointError,
    runStartedAt,
    activeRunSettings,
    lastResult,
    lastError,
    livePreviewUpdatedAt,
  };
}

function renderError(message, code = 500) {
  return { ok: false, error: message, code };
}

async function launchChromium() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

async function installPlaywrightChromium() {
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '0' };
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  console.log('Playwright Chromium binary missing. Installing Chromium automatically...');
  await execFileAsync(command, ['playwright', 'install', 'chromium'], { env, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  console.log('Playwright Chromium install completed.');
}

async function ensureBrowser() {
  if (browser) return browser;
  try {
    browser = await launchChromium();
  } catch (err) {
    const text = String(err && (err.message || err));
    if (!/Executable doesn't exist|browserType\.launch|Please run the following command to download new browsers|chromium_headless_shell/i.test(text)) {
      throw err;
    }
    await installPlaywrightChromium();
    browser = await launchChromium();
  }
  return browser;
}

async function captureLivePreview(page) {
  try {
    livePreviewBuffer = await page.screenshot({ type: 'jpeg', quality: 70, animations: 'disabled' });
    livePreviewUpdatedAt = new Date().toISOString();
  } catch (_) {}
}

async function recordOneUrl(url, index, runSettings) {
  const b = await ensureBrowser();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `pella-webm-${randomUUID()}-`));
  const filename = makeFilename(index, url);
  const localPath = path.resolve(RECORDINGS_DIR, filename);
  let context = null;
  let page = null;

  try {
    context = await b.newContext({
      viewport: { width: runSettings.width, height: runSettings.height },
      screen: { width: runSettings.width, height: runSettings.height },
      deviceScaleFactor: 1,
      recordVideo: { dir: tempDir, size: { width: runSettings.width, height: runSettings.height } },
    });
    activeContext = context;
    page = await context.newPage();
    activePage = page;
    currentUrl = url;
    currentIndex = index;
    livePreviewBuffer = null;
    livePreviewUpdatedAt = null;

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`Page console error: ${msg.text()}`);
    });
    page.on('pageerror', err => console.log(`Page error: ${err.message}`));

    console.log(`Loading: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
      console.log(`Page loaded: ${url}`);
    } catch (err) {
      console.log(`Navigation warning for ${url}: ${err.message}`);
      if (page.url() === 'about:blank') throw err;
    }

    const videos = await page.locator('video').count().catch(() => 0);
    const audios = await page.locator('audio').count().catch(() => 0);
    console.log(`Detected media: ${videos} video, ${audios} audio`);

    if (runSettings.warmupMs > 0) await new Promise(r => setTimeout(r, runSettings.warmupMs));
    await captureLivePreview(page);

    const endAt = Date.now() + runSettings.recordSeconds * 1000;
    let nextPreviewAt = 0;
    console.log(`Recording ${url} at ${runSettings.quality} (${runSettings.width}x${runSettings.height}) for ${runSettings.recordSeconds}s`);
    while (!stopRequested && Date.now() < endAt) {
      if (Date.now() >= nextPreviewAt) {
        await captureLivePreview(page);
        nextPreviewAt = Date.now() + 1000;
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } finally {
    if (page && activePage === page) activePage = null;
    if (context && activeContext === context) activeContext = null;
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }

  const names = await fsp.readdir(tempDir);
  const webmNames = names.filter(n => /\.webm$/i.test(n));
  if (!webmNames.length) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('Playwright did not produce a WebM file.');
  }
  webmNames.sort((a, b) => fs.statSync(path.join(tempDir, b)).mtimeMs - fs.statSync(path.join(tempDir, a)).mtimeMs);
  await fsp.copyFile(path.join(tempDir, webmNames[0]), localPath);
  await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  const key = `${B2_PREFIX}${filename}`;
  console.log(`Recording saved locally: ${localPath}`);

  if (b2Configured) {
    await uploadToB2(localPath, key);
    console.log(`B2 upload OK: ${key}`);
    if (DELETE_LOCAL_AFTER_UPLOAD) await fsp.unlink(localPath).catch(() => {});
  } else {
    console.log('B2 upload skipped: B2 is not configured.');
  }

  return {
    url,
    filename,
    key,
    quality: runSettings.quality,
    width: runSettings.width,
    height: runSettings.height,
    recordSeconds: runSettings.recordSeconds,
    uploaded: b2Configured,
    finishedAt: new Date().toISOString(),
  };
}

async function runRecorder(urls, source, runSettingsInput) {
  if (running) throw new Error('Recorder is already running.');
  const runUrls = normalizeUrls(urls);
  if (!runUrls.length) throw new Error('No URLs provided.');

  const runSettings = {
    quality: QUALITY_PRESETS[runSettingsInput?.quality] ? runSettingsInput.quality : settings.quality,
    recordSeconds: clampSeconds(runSettingsInput?.recordSeconds ?? settings.recordSeconds),
    warmupMs: Number.isFinite(Number(runSettingsInput?.warmupMs)) ? Math.min(30000, Math.max(0, Math.round(Number(runSettingsInput.warmupMs)))) : settings.warmupMs,
  };
  runSettings.width = QUALITY_PRESETS[runSettings.quality].width;
  runSettings.height = QUALITY_PRESETS[runSettings.quality].height;

  running = true;
  stopRequested = false;
  lastError = null;
  lastResult = null;
  activeRunUrls = runUrls.slice();
  totalUrls = runUrls.length;
  activeRunSettings = { ...runSettings };
  runStartedAt = new Date().toISOString();

  console.log(`Recorder starting from ${source}. ${runUrls.length} URL(s). Quality: ${runSettings.quality} (${runSettings.width}x${runSettings.height}), ${runSettings.recordSeconds}s each, warmup ${runSettings.warmupMs}ms.`);
  runUrls.forEach((u, i) => console.log(`  [${i + 1}/${runUrls.length}] ${u}`));

  try {
    for (let i = 0; i < runUrls.length; i += 1) {
      if (stopRequested) break;
      currentIndex = i;
      try {
        lastResult = await recordOneUrl(runUrls[i], i, runSettings);
      } catch (err) {
        lastError = `${runUrls[i]}: ${err.message}`;
        console.error(`Recording failed: ${lastError}`);
      }
    }
  } finally {
    running = false;
    currentUrl = null;
    currentIndex = null;
    totalUrls = 0;
    activeRunUrls = [];
    activeRunSettings = null;
    stopRequested = false;
    runStartedAt = null;
    livePreviewBuffer = null;
    livePreviewUpdatedAt = null;
    console.log('Recorder finished.');
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.use((_req, res, next) => {
  noStore(res);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: APP_VERSION, running, b2Configured, bucket: B2_BUCKET || null, region: B2_REGION, endpoint: B2_ENDPOINT, endpointError: b2EndpointError, settings, currentUrl, currentIndex, totalUrls, lastError });
});

app.get('/api/status', (_req, res) => res.json(safeStatus()));

app.get('/api/debug', (_req, res) => {
  let savedUrls = [];
  let urlsError = null;
  try { savedUrls = readUrls(); } catch (err) { urlsError = err.message; }
  res.json({
    ok: true,
    version: APP_VERSION,
    node: process.version,
    cwd: process.cwd(),
    b2Configured,
    b2Endpoint: B2_ENDPOINT,
    b2Region: B2_REGION,
    b2Bucket: B2_BUCKET || null,
    hasKeyId: Boolean(B2_KEY_ID),
    hasApplicationKey: Boolean(B2_APPLICATION_KEY),
    urlsFile: path.resolve(URLS_FILE),
    savedUrls,
    urlsError,
    settingsFile: path.resolve(SETTINGS_FILE),
    recordingsDir: path.resolve(RECORDINGS_DIR),
  });
});

app.post('/api/start', async (req, res) => {
  if (running) return res.status(409).json(renderError('Recorder is already running.', 409));
  try {
    const urls = normalizeUrls(Array.isArray(req.body?.urls) ? req.body.urls : req.body?.text);
    if (!urls.length) return res.status(400).json(renderError('Paste at least one valid URL into the panel.', 400));

    const quality = String(req.body?.quality || settings.quality);
    if (!QUALITY_PRESETS[quality]) return res.status(400).json(renderError(`Unsupported quality: ${quality}`, 400));
    const recordSeconds = clampSeconds(req.body?.recordSeconds ?? settings.recordSeconds);
    const warmupMs = Number.isFinite(Number(req.body?.warmupMs)) ? Math.min(30000, Math.max(0, Math.round(Number(req.body.warmupMs)))) : settings.warmupMs;
    const savedSettings = saveSettings({ quality, recordSeconds, warmupMs });
    console.log(`Panel start requested with ${urls.length} URL(s), ${savedSettings.quality}, ${savedSettings.recordSeconds}s.`);
    urls.forEach((u, i) => console.log(`  [${i + 1}] ${u}`));

    runPromise = runRecorder(urls, 'panel', savedSettings)
      .catch(err => { lastError = err.message; console.error(`Recorder fatal error: ${err.message}`); })
      .finally(() => { runPromise = null; });

    return res.json({ ok: true, started: true, source: 'panel', urls, settings: savedSettings });
  } catch (err) {
    return res.status(400).json(renderError(err.message, 400));
  }
});

app.post('/api/stop', async (_req, res) => {
  if (!running) return res.json({ ok: true, stopped: false, message: 'Recorder is not running.' });
  stopRequested = true;
  console.log('Stop requested from panel. Finalizing the current WebM now and stopping the queue.');
  // Closing the active page/context immediately makes Playwright finalize the current WebM
  // instead of waiting for the remaining timer. The recorder loop then sees stopRequested
  // and does not start the next URL.
  const page = activePage;
  const context = activeContext;
  try {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  } catch (_) {}
  return res.json({ ok: true, stopped: true, message: 'Stop requested. Current WebM is being finalized and the queue will stop.' });
});

app.get('/api/urls', (_req, res) => {
  try { res.json({ ok: true, urls: readUrls() }); }
  catch (err) { res.status(500).json(renderError(err.message, 500)); }
});

app.post('/api/urls', (req, res) => {
  try {
    const urls = writeUrls(Array.isArray(req.body?.urls) ? req.body.urls : req.body?.text);
    res.json({ ok: true, urls });
  } catch (err) { res.status(400).json(renderError(err.message, 400)); }
});

app.delete('/api/urls', (_req, res) => {
  try { res.json({ ok: true, urls: writeUrls([]) }); }
  catch (err) { res.status(500).json(renderError(err.message, 500)); }
});

app.post('/api/settings', (req, res) => {
  try {
    const quality = String(req.body?.quality || settings.quality);
    if (!QUALITY_PRESETS[quality]) throw new Error(`Unsupported quality: ${quality}`);
    const recordSeconds = clampSeconds(req.body?.recordSeconds ?? settings.recordSeconds);
    const warmupMs = Number.isFinite(Number(req.body?.warmupMs)) ? Math.min(30000, Math.max(0, Math.round(Number(req.body.warmupMs)))) : settings.warmupMs;
    res.json({ ok: true, settings: saveSettings({ quality, recordSeconds, warmupMs }) });
  } catch (err) { res.status(400).json(renderError(err.message, 400)); }
});

app.get('/api/files', async (_req, res) => {
  try {
    if (!b2Configured) return res.status(503).json(renderError('B2 is not configured. Add the B2 environment variables in Render.', 503));
    res.json({ ok: true, bucket: B2_BUCKET, files: await listB2Files() });
  } catch (err) {
    console.error(`B2 list error: ${err.message}`);
    res.status(502).json(renderError(`B2 list failed: ${err.message}`, 502));
  }
});

async function streamB2Object(req, res, key, attachment) {
  if (!b2Configured) throw new Error('B2 is not configured.');
  const request = { Bucket: B2_BUCKET, Key: key };
  if (req.headers.range) request.Range = req.headers.range;
  const out = await s3.send(new GetObjectCommand(request));
  const partial = Boolean(req.headers.range);
  res.status(partial ? 206 : 200);
  res.setHeader('Content-Type', out.ContentType || 'video/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
  if (out.ContentRange) res.setHeader('Content-Range', out.ContentRange);
  res.setHeader('Content-Disposition', attachment ? `attachment; filename="${path.basename(key).replace(/["\r\n]/g, '')}"` : 'inline');
  if (out.Body?.pipe) out.Body.pipe(res);
  else res.end(Buffer.from(await out.Body.transformToByteArray()));
}

app.get('/api/preview', async (req, res) => {
  try { await streamB2Object(req, res, validateKey(req.query.key), false); }
  catch (err) { console.error(`B2 preview error: ${err.message}`); if (!res.headersSent) res.status(502).send(`Preview failed: ${err.message}`); }
});

app.get('/api/download', async (req, res) => {
  try { await streamB2Object(req, res, validateKey(req.query.key), true); }
  catch (err) { console.error(`B2 download error: ${err.message}`); if (!res.headersSent) res.status(502).send(`Download failed: ${err.message}`); }
});

function removeLocalByKey(key) {
  const local = path.resolve(RECORDINGS_DIR, path.basename(key));
  if (fs.existsSync(local)) fs.unlinkSync(local);
}

app.post('/api/delete', async (req, res) => {
  try {
    const key = validateKey(req.body?.key);
    if (!b2Configured) throw new Error('B2 is not configured.');
    await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: key }));
    removeLocalByKey(key);
    res.json({ ok: true, deleted: key });
  } catch (err) {
    console.error(`B2 delete error: ${err.message}`);
    res.status(502).json(renderError(`Delete failed: ${err.message}`, 502));
  }
});

app.post('/api/delete-many', async (req, res) => {
  try {
    const input = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const keys = [...new Set(input.map(validateKey))];
    if (!keys.length) return res.status(400).json(renderError('No files selected.', 400));
    if (!b2Configured) throw new Error('B2 is not configured.');
    const result = await s3.send(new DeleteObjectsCommand({ Bucket: B2_BUCKET, Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true } }));
    for (const key of keys) removeLocalByKey(key);
    if (result.Errors?.length) throw new Error(result.Errors.map(e => `${e.Key}: ${e.Message}`).join('; '));
    res.json({ ok: true, deleted: keys });
  } catch (err) {
    console.error(`B2 bulk delete error: ${err.message}`);
    res.status(502).json(renderError(`Delete failed: ${err.message}`, 502));
  }
});

app.get('/api/live-preview', (_req, res) => {
  if (!livePreviewBuffer) return res.status(404).send('No live preview available.');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.end(livePreviewBuffer);
});

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B','KB','MB','GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

app.get('/api/bootstrap', (_req, res) => {
  noStore(res);
  res.json({
    ok: true,
    version: APP_VERSION,
    initialUrls: (() => { try { return readUrls(); } catch { return []; } })(),
    settings,
    qualityPresets: QUALITY_PRESETS,
    sitePresets: SITE_PRESETS,
  });
});

app.get('/app.js', (_req, res) => {
  noStore(res);
  res.type('application/javascript').sendFile(path.join(__dirname, 'app.js'));
});

app.get('/', (_req, res) => {
  let urls = [];
  try { urls = readUrls(); } catch (_) {}
  const options = Object.entries(QUALITY_PRESETS)
    .map(([q, p]) => '<option value="' + q + '" ' + (q === settings.quality ? 'selected' : '') + '>' + q + ' — ' + p.width + '×' + p.height + '</option>')
    .join('');

  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Cache-Control" content="no-store"><title>Pella Render Recorder v${APP_VERSION}</title>
<style>
:root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#101418;background:#f4f6f8}*{box-sizing:border-box}body{margin:0}main{max-width:1250px;margin:auto;padding:20px}.card{background:#fff;border:1px solid #dfe4e9;border-radius:14px;padding:18px;margin-bottom:16px}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}h1{margin:0;font-size:28px}h2{margin:0 0 10px;font-size:19px}.muted{color:#65717c;font-size:13px}.status{font-size:14px;color:#0b6b4f;margin-top:7px}.status.err{color:#a51e2a}.actions,.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.btn,button{font:inherit;border:1px solid #b9c2cb;border-radius:9px;background:#fff;color:#101418;padding:10px 13px;cursor:pointer;text-decoration:none}.btn:hover,button:hover{background:#f4f7f9}.btn:disabled,button:disabled{opacity:.55;cursor:not-allowed}.primary{background:#111827;color:#fff;border-color:#111827}.primary:hover{background:#0b1220}.danger{background:#fff1f1;border-color:#e8a8a8;color:#9a1c26}.danger:hover{background:#ffe6e6}.field{display:grid;gap:7px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}input,select,textarea{font:inherit;width:100%;padding:11px 12px;border:1px solid #c7d0d8;border-radius:9px;background:#fff}textarea{min-height:180px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.help{font-size:13px;color:#6b7782}.pill{padding:5px 9px;border-radius:999px;background:#edf1f5;font-size:12px;white-space:nowrap}.pill.active{background:#e7f7f0;color:#176844}.notice{padding:10px 12px;border-radius:10px;background:#eff7ff;border:1px solid #c7def4;color:#214d74;min-height:42px}.notice.err{background:#fff2f2;border-color:#efbbbb;color:#92202a}.notice.ok{background:#effaf5;border-color:#c8eadb;color:#176844}.preview{background:#0e1216;border-radius:11px;overflow:hidden;min-height:240px;display:flex;align-items:center;justify-content:center}.preview img{display:block;max-width:100%;width:100%;height:auto}.empty{color:#cbd2d9;padding:44px;text-align:center}.files{display:grid;gap:14px}.file{border:1px solid #dde4ea;border-radius:12px;padding:12px;background:#fbfcfd}.filehead{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;margin-bottom:10px}.name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{font-size:13px;color:#69757f;white-space:nowrap}.file video{width:100%;max-height:440px;background:#000;border-radius:9px}.small{font-size:12px}.hidden{display:none!important}.url-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.two-badges{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:760px){.grid{grid-template-columns:1fr}.filehead{grid-template-columns:1fr}.meta{white-space:normal}}
</style></head><body><main>
<section class="card"><div class="top"><div><h1>Pella Render Recorder</h1><div id="status" class="status">Version ${APP_VERSION} · Connecting…</div><div id="substatus" class="muted">Manual Start uses the URLs currently in the panel. Saved urls.txt is only loaded when you press Load urls.txt.</div></div><div class="actions"><button type="button" id="startBtn" class="primary">Start Recording</button><button type="button" id="stopBtn">Stop</button><button type="button" id="refreshBtn">Refresh</button></div></div></section>
<section class="card"><h2>Recording Settings</h2><div class="grid"><div class="field"><label for="quality">Video quality</label><select id="quality">${options}</select><div id="selectedQualityHelp" class="help">Selected: ${settings.quality} — ${settings.width}×${settings.height}. Applies to the next recording.</div></div><div class="field"><label for="recordSeconds">Seconds per URL</label><input id="recordSeconds" type="number" min="1" max="3600" value="${settings.recordSeconds}"><div class="help">Each URL is recorded for this many seconds.</div></div><div class="field"><label for="warmupSeconds">Page warmup seconds</label><input id="warmupSeconds" type="number" min="0" max="30" step="1" value="${Math.round(settings.warmupMs/1000)}"><div class="help">Wait this long after the page loads before the timed recording begins.</div></div></div><div class="actions" style="margin-top:12px"><button type="button" id="saveSettingsBtn">Save Settings</button><button type="button" id="wispbytePresetBtn">Use Wispbyte Preset</button></div></section>
<section class="card"><h2>URLs to Record</h2><div class="field"><label for="urls">Multiple links — one per line</label><textarea id="urls" placeholder="https://example.com/video1\nhttps://example.com/video2"></textarea><div class="help"><b>Start Recording uses exactly what is currently in this box.</b> It does not reload urls.txt and it does not overwrite the box.</div></div><div class="row" style="margin-top:10px"><input id="newUrl" type="url" placeholder="https://example.com/video-page"><button type="button" id="addUrlBtn">Add URL + Save</button><button type="button" id="saveUrlsBtn">Save URL List</button><button type="button" id="loadUrlsBtn">Load urls.txt</button><button type="button" id="clearPanelBtn" class="danger">Clear Panel</button><button type="button" id="clearSavedBtn" class="danger">Clear Saved List</button></div><div id="urlCount" class="help" style="margin-top:8px">0 URLs in panel</div></section>
<section class="card"><div class="top"><div><h2>Live Screen Preview</h2><div id="liveText" class="muted">No active recording.</div></div><div class="two-badges"><span id="selectedQuality" class="pill">Selected: ${settings.quality} · ${settings.width}×${settings.height}</span><span id="activeQuality" class="pill active">Active: none</span></div></div><div class="preview" style="margin-top:12px"><div id="liveEmpty" class="empty">Start a recording to see the current webpage.</div><img id="livePreview" alt="Live webpage preview" style="display:none"></div></section>
<section class="card"><div class="top"><div><h2>B2 Recordings</h2><div class="muted">Private WebM recordings from Backblaze B2.</div></div><div class="actions"><button type="button" id="selectAllBtn">Select All</button><button type="button" id="deleteSelectedBtn" class="danger">Delete Selected</button></div></div><div id="filesNotice" class="notice" style="margin-top:12px">Loading recordings…</div><div id="files" class="files" style="margin-top:12px"></div></section>
<section class="card"><div class="top"><h2>Panel Message</h2><button type="button" id="clearMessageBtn">Clear Message</button></div><div id="message" class="notice" style="margin-top:12px">Ready.</div><div class="small muted" style="margin-top:8px">Diagnostics: <a href="/health" target="_blank" rel="noreferrer">/health</a> · <a href="/api/debug" target="_blank" rel="noreferrer">/api/debug</a></div></section>
</main>
<script defer src="/app.js?v=20.4.0"></script></body></html>`);
});

const server = http.createServer(app);
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pella Render Recorder ${APP_VERSION} listening on 0.0.0.0:${PORT}`);
  console.log(`SERVER_PORT=${process.env.SERVER_PORT || '(not set)'}`);
  console.log(`PORT=${process.env.PORT || '(not set)'}`);
  console.log(`Selected listen port=${PORT}`);
  console.log(`B2 configured: ${b2Configured}`);
  console.log(`B2 endpoint: ${B2_ENDPOINT || '(not set)'}`);
  console.log(`B2 bucket: ${B2_BUCKET || '(not set)'}`);
  console.log(`B2 region: ${B2_REGION}`);
  console.log(`URLS_FILE=${URLS_FILE}`);
  console.log(`Settings: ${settings.quality} ${settings.width}x${settings.height}, ${settings.recordSeconds}s, warmup ${settings.warmupMs}ms`);
  if (b2EndpointError) console.log(b2EndpointError);
  if (AUTO_START) {
    const urls = (() => { try { return readUrls(); } catch { return []; } })();
    if (urls.length) {
      runPromise = runRecorder(urls, 'auto', settings).catch(err => { lastError = err.message; console.error(`Auto-start error: ${err.message}`); }).finally(() => { runPromise = null; });
    }
  }
});

async function shutdown(){
  stopRequested=true;
  try { if (runPromise) await runPromise; } catch (_) {}
  try { if (browser) await browser.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
