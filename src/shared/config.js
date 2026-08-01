import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });

export class Config {
  constructor() {
    this.values = new Map();
    this.loadFromEnv();
  }

  loadFromEnv() {
    const mappings = {
      'OPENCLAW_GATEWAY_URL': 'OPENCLAW_GATEWAY_URL',
      'OPENCLAW_TOKEN': 'OPENCLAW_TOKEN',
      'PRIMARY_MODEL': 'PRIMARY_MODEL',
      'FALLBACK_MODEL': 'FALLBACK_MODEL',
      'TIKTOK_CLIENT_KEY': 'TIKTOK_CLIENT_KEY',
      'TIKTOK_CLIENT_SECRET': 'TIKTOK_CLIENT_SECRET',
      'TIKTOK_ACCESS_TOKEN': 'TIKTOK_ACCESS_TOKEN',
      'TIKTOK_REFRESH_TOKEN': 'TIKTOK_REFRESH_TOKEN',
      'TIKTOK_PRIVACY_LEVEL': 'TIKTOK_PRIVACY_LEVEL',
      'PEXELS_API_KEY': 'PEXELS_API_KEY',
      'STORYBLOCKS_API_KEY': 'STORYBLOCKS_API_KEY',
      'EPIDEMIC_SOUND_API_KEY': 'EPIDEMIC_SOUND_API_KEY',
      'FFMPEG_PATH': 'FFMPEG_PATH',
      'VIDEO_OUTPUT_DIR': 'VIDEO_OUTPUT_DIR',
      'TEMP_DIR': 'TEMP_DIR',
      'DAILY_CRON_TIME': 'DAILY_CRON_TIME',
      'POST_TIME_MORNING': 'POST_TIME_MORNING',
      'POST_TIME_EVENING': 'POST_TIME_EVENING',
      'TIMEZONE': 'TIMEZONE',
      'MAX_ITERATIONS': 'MAX_ITERATIONS',
      'SHARED_MEMORY_PATH': 'SHARED_MEMORY_PATH',
      'LOG_LEVEL': 'LOG_LEVEL',
      'WEBHOOK_URL': 'WEBHOOK_URL',
    };

    for (const [key, envKey] of Object.entries(mappings)) {
      if (process.env[envKey]) {
        this.values.set(key, process.env[envKey]);
      }
    }

    // Defaults
    this.setDefaults();
  }

  setDefaults() {
    const defaults = {
      'OPENCLAW_GATEWAY_URL': 'http://localhost:18789/v1',
      'PRIMARY_MODEL': 'nvidia/nemotron-3-ultra-550b-a55b',
      'FALLBACK_MODEL': 'deepseek/deepseek-v4-flash',
      'TIKTOK_PRIVACY_LEVEL': 'SELF_ONLY',
      'FFMPEG_PATH': 'ffmpeg',
      'VIDEO_OUTPUT_DIR': './data/videos',
      'TEMP_DIR': './tmp',
      'DAILY_CRON_TIME': '05:30',
      'POST_TIME_MORNING': '06:30',
      'POST_TIME_EVENING': '19:30',
      'TIMEZONE': 'America/Lima',
      'MAX_ITERATIONS': '3',
      'SHARED_MEMORY_PATH': './data/swarm-memory',
      'LOG_LEVEL': 'info',
    };

    for (const [key, value] of Object.entries(defaults)) {
      if (!this.values.has(key)) {
        this.values.set(key, value);
      }
    }
  }

  get(key) {
    return this.values.get(key);
  }

  getNumber(key) {
    const val = this.values.get(key);
    return val ? parseInt(val, 10) : 0;
  }

  getBoolean(key) {
    const val = this.values.get(key);
    return val === 'true' || val === '1';
  }

  set(key, value) {
    this.values.set(key, value);
  }

  all() {
    // Redact anything that looks like a credential so this can't be
    // logged/dumped by accident.
    const SECRET_PATTERN = /(TOKEN|SECRET|KEY)/i;
    return Object.fromEntries(
      [...this.values].map(([k, v]) => [k, SECRET_PATTERN.test(k) ? '[REDACTED]' : v])
    );
  }
}