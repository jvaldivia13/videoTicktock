#!/usr/bin/env node
/**
 * TikTok Motivation Swarm - Entry Point
 * 
 * Usage: node src/swarm/index.js --topic "disciplina matutina" [--iterations 3] [--publish]
 */

import { Command } from 'commander';
import { readFileSync, promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import pino from 'pino';

import { SwarmRunner } from './runner.js';
import { VideoGenerator } from '../video/generator.js';
import { TikTokPublisher } from '../publish/tiktok.js';
import { HiveMind } from '../shared/memory.js';
import { Config } from '../shared/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const program = new Command();

program
  .name('tiktok-swarm')
  .description('Automated TikTok motivational video pipeline')
  .version('1.0.0')
  .requiredOption('-t, --topic <string>', 'Video topic (e.g., "disciplina matutina")')
  .option('-i, --iterations <number>', 'Max swarm iterations', '3')
  .option('-p, --publish', 'Publish to TikTok after generation', false)
  .option('--video-only', 'Only generate video from existing package', false)
  .option('--package-path <string>', 'Path to package JSON (for --video-only / --publish-only)')
  .option('--publish-only', 'Only publish an existing video using package JSON', false)
  .option('--video <string>', 'Path to existing video file (for --publish-only)')
  .parse(process.argv);

const options = program.opts();
if (options.publishOnly && !options.video) {
  logger.error('--publish-only requires --video <path>');
  process.exit(1);
}

async function main() {
  const config = new Config();
  const hiveMind = new HiveMind(config.get('SHARED_MEMORY_PATH'));

  try {
    logger.info({ topic: options.topic }, '🚀 Starting TikTok Motivation Pipeline');

    if (options.publishOnly) {
      const pkgPath = options.packagePath || join(__dirname, '../../data/output/package-latest.json');
      const { package: pkg } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      logger.info('📤 Publishing existing video to TikTok...');
      const publisher = new TikTokPublisher(config, logger);
      const publishResult = await publisher.publish(options.video, pkg);
      logger.info({ publishResult }, '✅ Published to TikTok');
      return;
    }

    // Initialize swarm runner
    const swarmConfig = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf-8'));
    const runner = new SwarmRunner(swarmConfig, config, hiveMind, logger);

    let packageData;

    if (options.videoOnly) {
      // Load existing package (shape: { visual_plan, package })
      const pkgPath = options.packagePath || join(__dirname, '../../data/output/package-latest.json');
      packageData = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      logger.info('📦 Loaded existing package for video generation');
    } else {
      // Run swarm
      logger.info('🌊 Running swarm...');
      const result = await runner.run({
        topic: options.topic,
        maxIterations: parseInt(options.iterations),
      });

      packageData = { visual_plan: result.visualPlan, package: result.package };
      logger.info({ iterations: result.iteration }, '✅ Swarm completed');

      // Save package
      const outputDir = join(__dirname, '../../data/output');
      await fsp.mkdir(outputDir, { recursive: true });
      await fsp.writeFile(
        join(outputDir, 'package-latest.json'),
        JSON.stringify(packageData, null, 2)
      );
      await fsp.writeFile(
        join(outputDir, `package-${Date.now()}.json`),
        JSON.stringify(packageData, null, 2)
      );
    }

    // Generate video
    logger.info('🎬 Generating video...');
    const videoGen = new VideoGenerator(config, logger);
    const videoPath = await videoGen.generate(packageData);
    logger.info({ videoPath }, '✅ Video generated');

    // Publish if requested
    if (options.publish) {
      logger.info('📤 Publishing to TikTok...');
      const publisher = new TikTokPublisher(config, logger);
      const publishResult = await publisher.publish(videoPath, packageData.package);
      logger.info({ publishResult }, '✅ Published to TikTok');
    }

    logger.info('🎉 Pipeline completed successfully!');

  } catch (error) {
    logger.error({ err: error }, '❌ Pipeline failed');
    process.exitCode = 1;
  } finally {
    await hiveMind.close();
  }
}

main();