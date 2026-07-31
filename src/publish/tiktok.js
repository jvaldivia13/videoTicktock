import fetch from 'node-fetch';
import { FormData } from 'formdata-node';
import { fileTypeFromFile } from 'file-type';
import pino from 'pino';

const logger = pino({ level: 'info' });

export class TikTokPublisher {
  constructor(config, logger = pino()) {
    this.config = config;
    this.logger = logger;
    this.clientKey = config.get('TIKTOK_CLIENT_KEY');
    this.clientSecret = config.get('TIKTOK_CLIENT_SECRET');
    this.accessToken = config.get('TIKTOK_ACCESS_TOKEN');
    this.refreshToken = config.get('TIKTOK_REFRESH_TOKEN');
    this.baseUrl = 'https://open.tiktokapis.com/v2';
  }

  async publish(videoPath, packageData) {
    this.logger.info({ videoPath }, 'Publishing to TikTok...');

    const pack = typeof packageData === 'string' ? JSON.parse(packageData) : packageData;
    
    // Prepare post data
    const postData = {
      post_info: {
        title: pack.caption || '',
        privacy_level: 'PUBLIC',
        disable_duet: false,
        disable_stitch: false,
        disable_comment: false,
        brand_content_toggle: false,
        brand_organic_toggle: false,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: this.getFileSize(videoPath),
        chunk_size: this.getFileSize(videoPath),
        total_chunk_count: 1,
      },
    };

    try {
      // Step 1: Initialize upload
      const initResponse = await this.apiCall('/post/publish/video/init', 'POST', postData);
      
      if (!initResponse.data?.upload_url) {
        throw new Error('Failed to get upload URL: ' + JSON.stringify(initResponse));
      }

      const uploadUrl = initResponse.data.upload_url;
      const publishId = initResponse.data.publish_id;

      // Step 2: Upload video file
      await this.uploadVideo(uploadUrl, videoPath);

      // Step 3: Check status / complete
      const statusResponse = await this.checkPublishStatus(publishId);
      
      this.logger.info({ publishId, status: statusResponse }, 'TikTok publish completed');
      
      return {
        success: true,
        publish_id: publishId,
        video_url: statusResponse.data?.video_url,
        status: statusResponse.data?.status,
      };
    } catch (error) {
      this.logger.error({ err: error }, 'TikTok publish failed');
      throw error;
    }
  }

  async uploadVideo(uploadUrl, videoPath) {
    const videoBuffer = await import('fs').then(fs => fs.promises.readFile(videoPath));
    
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': videoBuffer.length.toString(),
      },
      body: videoBuffer,
    });

    if (!response.ok) {
      throw new Error(`Video upload failed: ${response.status} ${await response.text()}`);
    }
  }

  async checkPublishStatus(publishId) {
    // Poll for completion
    for (let i = 0; i < 30; i++) {
      const response = await this.apiCall(`/post/publish/status/fetch`, 'POST', { publish_id: publishId });
      
      if (response.data?.status === 'PUBLISH_COMPLETE') {
        return response;
      }
      
      if (response.data?.status === 'FAILED') {
        throw new Error(`Publish failed: ${response.data?.fail_reason}`);
      }
      
      // Wait 2 seconds before next poll
      await new Promise(r => setTimeout(r, 2000));
    }
    
    throw new Error('Publish timeout');
  }

  async apiCall(endpoint, method, body) {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();
    
    if (data.error?.code !== 'ok') {
      throw new Error(`TikTok API error: ${data.error?.message || JSON.stringify(data)}`);
    }
    
    return data;
  }

  async refreshAccessToken() {
    // Implement token refresh if needed
    // POST https://open.tiktokapis.com/v2/oauth/token/refresh
  }

  getFileSize(path) {
    try {
      const stats = await import('fs').then(fs => fs.promises.stat(path));
      return stats.size;
    } catch {
      return 0;
    }
  }

  async schedulePost(videoPath, packageData, scheduleTime) {
    // For scheduled posts, use the same API but with schedule_time
    // TikTok API supports scheduled publishing
    const pack = typeof packageData === 'string' ? JSON.parse(packageData) : packageData;
    
    const postData = {
      post_info: {
        title: pack.caption || '',
        privacy_level: 'PUBLIC',
        schedule_time: Math.floor(new Date(scheduleTime).getTime() / 1000), // Unix timestamp
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: this.getFileSize(videoPath),
        chunk_size: this.getFileSize(videoPath),
        total_chunk_count: 1,
      },
    };

    const initResponse = await this.apiCall('/post/publish/video/init', 'POST', postData);
    const uploadUrl = initResponse.data.upload_url;
    const publishId = initResponse.data.publish_id;

    await this.uploadVideo(uploadUrl, videoPath);
    
    return { publish_id: publishId, scheduled: true };
  }
}