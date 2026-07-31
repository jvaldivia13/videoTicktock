import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import pino from 'pino';

import { Config } from '../shared/config.js';
import { HiveMind } from '../shared/memory.js';
import { SwarmRunner } from '../swarm/runner.js';
import { VideoGenerator } from '../video/generator.js';
import { TikTokPublisher } from '../publish/tiktok.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

class DailyPipeline {
  constructor() {
    this.config = new Config();
    this.hiveMind = new HiveMind(this.config.get('SHARED_MEMORY_PATH'));
    this.runner = null;
    this.videoGen = null;
    this.publisher = null;
    this.isRunning = false;
  }

  async init() {
    const swarmConfig = JSON.parse(
      await import('fs').then(fs => fs.promises.readFile(
        join(__dirname, '../swarm/config.json'), 'utf-8'
      ))
    );
    
    this.runner = new SwarmRunner(swarmConfig, this.config, this.hiveMind, logger);
    this.videoGen = new VideoGenerator(this.config, logger);
    this.publisher = new TikTokPublisher(this.config, logger);
    
    logger.info('Daily pipeline initialized');
  }

  async runDaily(topic = null) {
    if (this.isRunning) {
      logger.warn('Pipeline already running, skipping');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      // Use provided topic or get from hive-mind suggestions
      const finalTopic = topic || await this.getNextTopic();
      logger.info({ topic: finalTopic }, 'Starting daily pipeline');
      
      // Run swarm
      const swarmResult = await this.runner.run({
        topic: finalTopic,
        maxIterations: this.config.getNumber('MAX_ITERATIONS'),
      });
      
      // Save package
      const outputDir = join(__dirname, '../../data/output');
      await import('fs').then(fs => fs.promises.mkdir(outputDir, { recursive: true }));
      await import('fs').then(fs => fs.promises.writeFile(
        join(outputDir, 'package-latest.json'),
        JSON.stringify(swarmResult.package, null, 2)
      ));
      
      // Generate video
      const videoPath = await this.videoGen.generate({
        visual_plan: swarmResult.visualPlan,
        package: swarmResult.package,
      });
      
      // Schedule post for optimal time
      const pack = typeof swarmResult.package === 'string' ? JSON.parse(swarmResult.package) : swarmResult.package;
      const postTime = this.getNextPostTime(pack.post_time);
      
      await this.publisher.schedulePost(videoPath, swarmResult.package, postTime);
      
      // Log metrics
      const duration = Date.now() - startTime;
      logger.info({ 
        topic: finalTopic, 
        duration: `${duration}ms`,
        videoPath,
        scheduledFor: postTime,
      }, 'Daily pipeline completed');
      
      // Notify webhook if configured
      await this.notifyWebhook({
        topic: finalTopic,
        videoPath,
        scheduledFor: postTime,
        duration,
      });
      
    } catch (error) {
      logger.error({ err: error }, 'Daily pipeline failed');
      await this.notifyWebhook({ error: error.message, topic });
    } finally {
      this.isRunning = false;
    }
  }

  async getNextTopic() {
    // Get learned patterns from hive-mind
    const patterns = await this.hiveMind.getLearnedPatterns('daily');
    if (patterns?.next_topic_suggestions?.length) {
      return patterns.next_topic_suggestions[0];
    }
    
    // Default topics rotation
    const topics = [
      'disciplina matutina',
      'consistencia vs intensidad',
      'entorno > voluntad',
      'micro-hábitos poderosos',
      'mentalidad estoica diaria',
      'vencer la procrastinación',
      'sistemas no motivación',
      'compound effect pequeños pasos',
    ];
    
    const dayIndex = new Date().getDate() % topics.length;
    return topics[dayIndex];
  }

  getNextPostTime(preferredTime) {
    const now = new Date();
    const [hours, minutes] = (preferredTime || this.config.get('POST_TIME_MORNING')).split(':').map(Number);
    
    const postTime = new Date(now);
    postTime.setHours(hours, minutes, 0, 0);
    
    // If time already passed today, schedule for tomorrow
    if (postTime <= now) {
      postTime.setDate(postTime.getDate() + 1);
    }
    
    return postTime.toISOString();
  }

  async notifyWebhook(data) {
    const webhookUrl = this.config.get('WEBHOOK_URL');
    if (!webhookUrl) return;
    
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, timestamp: new Date().toISOString() }),
      });
    } catch (e) {
      logger.warn({ err: e }, 'Webhook notification failed');
    }
  }

  startCron() {
    const cronTime = this.config.get('DAILY_CRON_TIME') || '05:30';
    const [minute, hour] = cronTime.split(':').map(Number);
    const cronExpr = `${minute} ${hour} * * *`;
    
    logger.info({ cronExpr, timezone: this.config.get('TIMEZONE') }, 'Starting daily cron');
    
    cron.schedule(cronExpr, () => {
      this.runDaily();
    }, {
      timezone: this.config.get('TIMEZONE') || 'America/Lima',
    });
    
    // Keep process alive
    setInterval(() => {}, 1000);
  }
}

// CLI entry
const args = process.argv.slice(2);
const pipeline = new DailyPipeline();

async function main() {
  await pipeline.init();
  
  if (args.includes('--once')) {
    const topicIdx = args.indexOf('--topic');
    const topic = topicIdx !== -1 ? args[topicIdx + 1] : null;
    await pipeline.runDaily(topic);
    process.exit(0);
  }
  
  if (args.includes('--cron')) {
    pipeline.startCron();
  }
  
  // Default: run once with default topic
  await pipeline.runDaily();
}

main().catch(e => {
  logger.error({ err: e }, 'Fatal error');
  process.exit(1);
});