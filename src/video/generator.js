import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import pino from 'pino';

export class VideoGenerator {
  constructor(config, logger = pino()) {
    this.config = config;
    this.logger = logger;
    this.ffmpegPath = config.get('FFMPEG_PATH') || 'ffmpeg';
    this.outputDir = config.get('VIDEO_OUTPUT_DIR') || './data/videos';
    this.tempDir = config.get('TEMP_DIR') || './tmp';
    
    // Ensure directories exist
    [this.outputDir, this.tempDir].forEach(d => {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    });
  }

  async generate(packageData) {
    const { visual_plan, package: pkg } = packageData;
    
    if (!visual_plan) {
      throw new Error('visual_plan required for video generation');
    }

    const visualPlan = typeof visual_plan === 'string' ? JSON.parse(visual_plan) : visual_plan;
    const pack = typeof pkg === 'string' ? JSON.parse(pkg) : pkg;

    this.logger.info('Generating video from visual plan...');

    // Create FFMPEG filter complex from shot list
    const filterComplex = this.buildFilterComplex(visualPlan, pack);
    
    // Generate output filename — strip anything but a safe charset so
    // LLM-controlled thumbnail_text can't path-traverse out of outputDir.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeSlug = String(pack.thumbnail_text || 'video')
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'video';
    const outputPath = join(this.outputDir, `tiktok-${safeSlug}-${timestamp}.mp4`);

    // Build FFMPEG command
    const ffmpegArgs = this.buildFFmpegArgs(visualPlan, filterComplex, outputPath);
    
    this.logger.debug({ args: ffmpegArgs.join(' ') }, 'Running FFMPEG');
    
    const result = spawnSync(this.ffmpegPath, ffmpegArgs, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300000, // 5 min max
    });

    if (result.error) {
      throw new Error(`Could not run ffmpeg at "${this.ffmpegPath}": ${result.error.message}`);
    }
    if (result.status !== 0) {
      this.logger.error({ stderr: result.stderr }, 'FFMPEG failed');
      throw new Error(`FFMPEG failed: ${result.stderr}`);
    }

    this.logger.info({ outputPath, size: this.getFileSize(outputPath) }, 'Video generated successfully');
    
    // Copy (not symlink) to a stable "latest.mp4" path — symlinks require
    // elevated privileges on Windows, so a copy keeps this cross-platform.
    const latestPath = join(this.outputDir, 'latest.mp4');
    try {
      if (existsSync(latestPath)) unlinkSync(latestPath);
      copyFileSync(outputPath, latestPath);
    } catch (e) {
      this.logger.warn({ err: e }, 'Could not update latest.mp4');
    }

    return outputPath;
  }

  buildFilterComplex(visualPlan, pack) {
    const shots = visualPlan.shots || [];
    if (!shots.length) {
      throw new Error('visual_plan.shots is empty — nothing to render');
    }
    const filters = [];

    // For each shot, we'll create an input (stock video, color, text, etc.)
    // In production, you'd download stock footage based on stock_query
    // For now, generate synthetic clips with colors/text

    shots.forEach((shot, i) => {
      // Clamp so malformed/adversarial LLM output can't produce a negative,
      // zero, or absurdly long clip.
      const duration = Math.min(Math.max(Number(shot.end_sec) - Number(shot.start_sec) || 0, 0.1), 60);

      if (shot.visual_type === 'text' || shot.visual_type === 'animation') {
        // Generate text overlay clip
        const text = shot.text_overlay || '';
        const style = shot.text_style || {};
        const fontPath = this.getFontPath(this.sanitizeFontName(style.font));
        const color = this.sanitizeColor(style.color, 'white');
        const outline = this.sanitizeColor(style.outline, 'black');
        const position = style.position || 'center';

        filters.push(
          `color=black:1080x1920:d=${duration}[base${i}];` +
          `[base${i}]drawtext=text='${this.escapeText(text)}':${fontPath ? `fontfile=${fontPath}:` : ''}` +
          `fontcolor=${color}:bordercolor=${outline}:borderw=3:` +
          `x=(w-text_w)/2:y=${position === 'center' ? '(h-text_h)/2' : 'h-text_h-100'}:` +
          `fontsize=80${style.animation === 'pop-in' ? ':enable=between(t,0,0.5)' : ''}[v${i}]`
        );
      } else if (shot.visual_type === 'split') {
        // Split screen - two colors
        filters.push(
          `color=0x1a1a2e:1080x960:d=${duration}[top${i}];` +
          `color=0x16213e:1080x960:d=${duration}[bot${i}];` +
          `[top${i}][bot${i}]vstack[v${i}]`
        );
      } else {
        // Stock/broll/pov - generate placeholder color with query as comment
        const color = this.hashToColor(shot.stock_query || shot.description || 'video');
        filters.push(`color=${color}:1080x1920:d=${duration}[v${i}]`);
      }
    });

    // Concatenate all shots
    const concatInputs = shots.map((_, i) => `[v${i}]`).join('');
    filters.push(`${concatInputs}concat=n=${shots.length}:v=1:a=0[outv]`);

    // Add subtitles if specified
    if (visualPlan.subtitles && pack.caption) {
      // In production, generate .ass subtitle file
      // For now, burn caption as text overlay on final video
      const fontPath = this.getFontPath('Montserrat-Bold');
      filters.push(
        `[outv]drawtext=text='${this.escapeText(pack.caption.split('#')[0].substring(0, 100))}':${fontPath ? `fontfile=${fontPath}:` : ''}` +
        `fontcolor=white:bordercolor=black:borderw=2:x=(w-text_w)/2:y=h-text_h-150:fontsize=48[final]`
      );
    } else {
      filters.push('[outv]copy[final]');
    }

    return filters.join(';');
  }

  sanitizeColor(value, fallback) {
    const v = String(value ?? '');
    return /^(0x[0-9a-fA-F]{6,8}|#[0-9a-fA-F]{6}|[a-zA-Z]{3,20})$/.test(v) ? v : fallback;
  }

  sanitizeFontName(value) {
    const v = String(value ?? '');
    return /^[A-Za-z0-9 _-]{1,40}$/.test(v) ? v : 'DejaVuSans-Bold';
  }

  buildFFmpegArgs(visualPlan, filterComplex, outputPath) {
    const args = [
      '-y', // Overwrite
      '-filter_complex', filterComplex,
      '-map', '[final]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-r', '30', // 30 fps
      '-s', '1080x1920', // Vertical
    ];

    // Add music if specified
    if (visualPlan.music) {
      // In production: download and add music track
      // args.push('-i', musicPath, '-c:a', 'aac', '-b:a', '128k', '-shortest');
    }

    args.push(outputPath);
    return args;
  }

  escapeText(text) {
    // This value sits inside a single-quoted filtergraph string (text='...').
    // Inside '...', ffmpeg's parser treats ONLY the quote character as
    // special — backslash has no meaning there, so escaping ':,[];\' with a
    // backslash (as earlier code did) just prints literal backslashes. The
    // one real risk is an embedded ' (very common in Spanish text, e.g.
    // "yo también"), which would otherwise terminate the quote early and
    // let the rest of the string be parsed as filtergraph syntax — fixed
    // here with ffmpeg's documented '\'' idiom (close, escaped quote, reopen).
    // `%` is escaped separately because drawtext runs its own %{...}
    // expansion pass on the text value after filtergraph parsing.
    return String(text)
      .replace(/'/g, `'\\''`)
      .replace(/%/g, '\\%');
  }

  getFontPath(font) {
    // Try common font paths across platforms, ending with real Windows
    // fonts (Montserrat/DejaVu are not shipped with Windows).
    const paths = [
      `/usr/share/fonts/truetype/${font.toLowerCase()}.ttf`,
      `/usr/share/fonts/truetype/dejavu/${font.toLowerCase()}.ttf`,
      `/System/Library/Fonts/${font}.ttf`,
      `C:\\Windows\\Fonts\\${font}.ttf`,
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      'C:\\Windows\\Fonts\\arialbd.ttf',
      'C:\\Windows\\Fonts\\segoeuib.ttf',
    ];
    for (const p of paths) {
      if (existsSync(p)) return this.toFfmpegPath(p);
    }
    // Nothing found — omit fontfile= and let drawtext use fontconfig's default.
    return null;
  }

  toFfmpegPath(p) {
    // ffmpeg filtergraph option values treat ':' and '\' as special —
    // use forward slashes and escape the drive-letter colon (Windows).
    return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  }

  hashToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    // ffmpeg's color filter doesn't understand CSS hsl(), only names or
    // 0xRRGGBB hex — convert here instead of emitting an unparseable value.
    return `0x${this.hslToHex(hue, 50, 20)}`;
  }

  hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = n => Math.round(f(n) * 255).toString(16).padStart(2, '0');
    return `${toHex(0)}${toHex(8)}${toHex(4)}`;
  }

  getFileSize(path) {
    try {
      return (statSync(path).size / 1024 / 1024).toFixed(2) + ' MB';
    } catch {
      return 'unknown';
    }
  }
}