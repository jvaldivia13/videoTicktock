import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = pino({ level: 'info' });

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
    
    // Generate output filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = join(this.outputDir, `tiktok-${pack.thumbnail_text?.replace(/\s+/g, '-') || 'video'}-${timestamp}.mp4`);
    
    // Build FFMPEG command
    const ffmpegArgs = this.buildFFmpegArgs(visualPlan, pack, filterComplex, outputPath);
    
    this.logger.debug({ args: ffmpegArgs.join(' ') }, 'Running FFMPEG');
    
    const result = spawnSync(this.ffmpegPath, ffmpegArgs, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300000, // 5 min max
    });

    if (result.status !== 0) {
      this.logger.error({ stderr: result.stderr }, 'FFMPEG failed');
      throw new Error(`FFMPEG failed: ${result.stderr}`);
    }

    this.logger.info({ outputPath, size: this.getFileSize(outputPath) }, 'Video generated successfully');
    
    // Also save latest symlink
    const latestPath = join(this.outputDir, 'latest.mp4');
    try {
      import('fs').then(fs => {
        if (existsSync(latestPath)) fs.unlinkSync(latestPath);
        fs.symlinkSync(outputPath, latestPath);
      });
    } catch (e) {
      // Ignore symlink errors
    }

    return outputPath;
  }

  buildFilterComplex(visualPlan, pack) {
    const shots = visualPlan.shots || [];
    const filters = [];
    let inputIndex = 0;
    const inputPaths = [];

    // For each shot, we'll create an input (stock video, color, text, etc.)
    // In production, you'd download stock footage based on stock_query
    // For now, generate synthetic clips with colors/text

    shots.forEach((shot, i) => {
      const duration = shot.end_sec - shot.start_sec;
      const inputLabel = `[v${i}]`;
      
      if (shot.visual_type === 'text' || shot.visual_type === 'animation') {
        // Generate text overlay clip
        const text = shot.text_overlay || '';
        const style = shot.text_style || {};
        const font = style.font || 'Montserrat-Bold';
        const color = style.color || 'white';
        const outline = style.outline || 'black';
        const position = style.position || 'center';
        
        filters.push(
          `color=black:1080x1920:d=${duration}[base${i}];` +
          `[base${i}]drawtext=text='${this.escapeText(text)}':fontfile=${this.getFontPath(font)}:` +
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
      
      inputIndex++;
    });

    // Concatenate all shots
    const concatInputs = shots.map((_, i) => `[v${i}]`).join('');
    filters.push(`${concatInputs}concat=n=${shots.length}:v=1:a=0[outv]`);

    // Add subtitles if specified
    if (visualPlan.subtitles && pack.caption) {
      const subStyle = visualPlan.subtitles;
      // In production, generate .ass subtitle file
      // For now, burn caption as text overlay on final video
      filters.push(`[outv]drawtext=text='${this.escapeText(pack.caption.split('#')[0].substring(0, 100))}':fontfile=${this.getFontPath('Montserrat-Bold')}:\
fontcolor=white:bordercolor=black:borderw=2:x=(w-text_w)/2:y=h-text_h-150:fontsize=48[final]`);
    } else {
      filters.push('[outv]copy[final]');
    }

    return filters.join(';');
  }

  buildFFmpegArgs(visualPlan, pack, filterComplex, outputPath) {
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
    return text.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/,/g, "\\,");
  }

  getFontPath(font) {
    // Try common font paths
    const paths = [
      `/usr/share/fonts/truetype/${font.toLowerCase()}.ttf`,
      `/usr/share/fonts/truetype/dejavu/${font.toLowerCase()}.ttf`,
      `/System/Library/Fonts/${font}.ttf`,
      `C:\\Windows\\Fonts\\${font}.ttf`,
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    // Fallback to default
    return '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  }

  hashToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 50%, 20%)`;
  }

  getFileSize(path) {
    try {
      const stats = readFileSync(path);
      return (stats.length / 1024 / 1024).toFixed(2) + ' MB';
    } catch {
      return 'unknown';
    }
  }
}