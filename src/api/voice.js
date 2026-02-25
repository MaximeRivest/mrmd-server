/**
 * Voice API routes
 *
 * Server-side voice transcription for browser/phone clients.
 * Mirrors electronAPI.voice.* from Electron main process.
 *
 * Routes:
 *   POST /api/voice/check-parakeet   - Check if Parakeet WS server is reachable
 *   POST /api/voice/transcribe-parakeet - Convert audio + send to Parakeet WS
 *   POST /api/voice/transcribe-api    - Proxy transcription to OpenAI/Groq
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Settings file location (shared with settings.js)
const CONFIG_DIR = path.join(os.homedir(), '.config', 'mrmd');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

// ============================================================================
// Helpers
// ============================================================================

function detectAudioExtension(mimeType = '') {
  const mt = String(mimeType || '').toLowerCase();
  if (mt.includes('ogg')) return 'ogg';
  if (mt.includes('mp4') || mt.includes('m4a')) return 'm4a';
  if (mt.includes('wav')) return 'wav';
  return 'webm';
}

function runFfmpegToPcm(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr?.on('data', (d) => { stderr += d.toString(); });

    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-500)}`));
      }
    });
  });
}

function transcribeParakeetPcm(url, pcmBuffer, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let ws;
    let resolved = false;
    const segments = [];

    const done = (err, result) => {
      if (resolved) return;
      resolved = true;
      try { ws?.close(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(result);
    };

    const timer = setTimeout(() => {
      done(new Error('Parakeet transcription timeout'));
    }, timeoutMs);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      clearTimeout(timer);
      done(new Error(`Failed to connect to Parakeet: ${err.message}`));
      return;
    }

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString());
      } catch {
        return;
      }

      if (msg.type === 'ready') {
        ws.send(pcmBuffer);
        ws.send(JSON.stringify({ type: 'flush' }));
        return;
      }

      if (msg.type === 'segment') {
        segments.push({
          text: msg.text || '',
          confidence: msg.confidence || 0,
          duration: msg.duration || 0,
        });
        return;
      }

      if (msg.type === 'flushed') {
        clearTimeout(timer);
        done(null, {
          text: segments.map(s => s.text).join(' ').trim(),
          segments,
          duration: segments.reduce((n, s) => n + (s.duration || 0), 0),
        });
        return;
      }

      if (msg.type === 'error') {
        clearTimeout(timer);
        done(new Error(msg.message || 'Parakeet error'));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      done(new Error(`Parakeet WebSocket error: ${err.message}`));
    });

    ws.on('close', () => {
      if (!resolved) {
        clearTimeout(timer);
        done(new Error('Parakeet connection closed unexpectedly'));
      }
    });
  });
}

function checkParakeetAvailable(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ available: false, error: 'Timeout' });
      try { ws.close(); } catch { /* ignore */ }
    }, timeoutMs);

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      clearTimeout(timer);
      resolve({ available: false, error: err.message });
      return;
    }

    ws.on('message', (data) => {
      if (settled) return;
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
        if (msg.type === 'ready') {
          settled = true;
          clearTimeout(timer);
          resolve({ available: true });
          try { ws.close(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    });

    ws.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: false, error: err.message });
    });

    ws.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: false, error: 'Closed before ready' });
    });
  });
}

// API provider configs
const API_PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/audio/transcriptions',
    defaultModel: 'gpt-4o-mini-transcribe',
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    defaultModel: 'whisper-large-v3-turbo',
  },
};

// ============================================================================
// Routes
// ============================================================================

export function createVoiceRoutes(ctx) {
  const router = Router();

  /**
   * POST /api/voice/check-parakeet
   * Body: { url: string }
   * Returns: { available: boolean, error?: string }
   */
  router.post('/check-parakeet', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.json({ available: false, error: 'Missing URL' });

      // If tunnel is available, Parakeet is reachable through the user's desktop
      if (ctx.tunnelClient?.isAvailable()) {
        // We can't easily "check" Parakeet through the tunnel without doing
        // a full transcribe, but if the tunnel provider is connected and a
        // Parakeet URL is configured, report it as available.
        return res.json({ available: true, via: 'tunnel' });
      }

      // Direct check (works when Parakeet is reachable from server)
      const result = await checkParakeetAvailable(url);
      res.json(result);
    } catch (err) {
      res.json({ available: false, error: err.message });
    }
  });

  /**
   * POST /api/voice/transcribe-parakeet
   * Body: { audioBase64: string, mimeType: string, url: string }
   * Returns: { text: string, segments: [...], duration: number }
   *
   * If the runtime tunnel is available (Electron desktop connected),
   * routes transcription through the tunnel to the user's local machine
   * (which can reach LAN Parakeet servers like 192.168.x.x).
   */
  router.post('/transcribe-parakeet', async (req, res) => {
    const { audioBase64, mimeType, url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing Parakeet URL' });
    if (!audioBase64) return res.status(400).json({ error: 'Missing audio data' });

    // Try tunnel first (Electron desktop can reach LAN Parakeet servers)
    if (ctx.tunnelClient?.isAvailable()) {
      try {
        console.log('[voice:transcribe-parakeet] Routing through tunnel to Electron provider');
        const result = await ctx.tunnelClient.voiceTranscribe({ audioBase64, mimeType, url });
        return res.json(result);
      } catch (err) {
        console.warn('[voice:transcribe-parakeet] Tunnel transcription failed, trying direct:', err.message);
        // Fall through to direct connection
      }
    }

    // Direct connection (works when Parakeet is reachable from the server)
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrmd-voice-'));
    const ext = detectAudioExtension(mimeType);
    const inputPath = path.join(tempDir, `input.${ext}`);
    const outputPath = path.join(tempDir, 'output.pcm');

    try {
      fs.writeFileSync(inputPath, Buffer.from(audioBase64, 'base64'));
      await runFfmpegToPcm(inputPath, outputPath);
      const pcm = fs.readFileSync(outputPath);
      const result = await transcribeParakeetPcm(url, pcm);
      res.json(result);
    } catch (err) {
      console.error('[voice:transcribe-parakeet]', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
      try { fs.rmdirSync(tempDir); } catch { /* ignore */ }
    }
  });

  /**
   * POST /api/voice/transcribe-api
   * Body: { audioBase64: string, mimeType: string, provider: string, model?: string }
   *
   * Uses server-side API keys (never exposed to browser).
   * Proxies to OpenAI/Groq transcription endpoint.
   */
  router.post('/transcribe-api', async (req, res) => {
    const { audioBase64, mimeType, provider, model } = req.body;
    if (!audioBase64) return res.status(400).json({ error: 'Missing audio data' });
    if (!provider) return res.status(400).json({ error: 'Missing provider' });

    const providerConfig = API_PROVIDERS[provider];
    if (!providerConfig) {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    // Read API key from server settings
    const settings = readSettings();
    const apiKey = settings?.apiKeys?.[provider];
    if (!apiKey) {
      return res.status(400).json({ error: `No API key configured for ${provider}` });
    }

    try {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const ext = detectAudioExtension(mimeType);
      const fileName = `recording.${ext}`;

      // Build multipart form data manually
      const boundary = '----MrmdVoice' + Date.now().toString(36);

      const parts = [];

      // file field
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${mimeType || 'audio/webm'}\r\n\r\n`
      );
      parts.push(audioBuffer);
      parts.push('\r\n');

      // model field
      const modelValue = model || providerConfig.defaultModel;
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `${modelValue}\r\n`
      );

      parts.push(`--${boundary}--\r\n`);

      // Concatenate all parts into a single Buffer
      const bodyParts = parts.map(p => typeof p === 'string' ? Buffer.from(p) : p);
      const body = Buffer.concat(bodyParts);

      const response = await fetch(providerConfig.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`${provider} transcription failed (${response.status}): ${text.slice(0, 200)}`);
      }

      const data = await response.json();
      res.json({
        text: data?.text || '',
        segments: data?.segments || [],
        duration: data?.duration || 0,
      });
    } catch (err) {
      console.error(`[voice:transcribe-api:${provider}]`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/voice/providers
   * Returns available voice providers and their status.
   */
  router.get('/providers', (req, res) => {
    const settings = readSettings();
    const voiceProvider = settings?.voice?.provider || 'parakeet';
    const parakeetUrl = settings?.voice?.parakeetUrl || '';

    const providers = [
      {
        name: 'parakeet',
        active: voiceProvider === 'parakeet',
        configured: !!parakeetUrl,
        url: parakeetUrl,
      },
      {
        name: 'openai',
        active: voiceProvider === 'openai',
        configured: !!(settings?.apiKeys?.openai),
      },
      {
        name: 'groq',
        active: voiceProvider === 'groq',
        configured: !!(settings?.apiKeys?.groq),
      },
    ];

    res.json({ provider: voiceProvider, providers });
  });

  return router;
}
