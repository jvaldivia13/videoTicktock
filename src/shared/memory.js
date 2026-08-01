import { Level } from 'level';

export class HiveMind {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    if (!this.db) {
      this.db = new Level(this.dbPath, { valueEncoding: 'json' });
    }
    return this.db;
  }

  async saveContext(topic, context) {
    await this.init();
    const key = `context:${topic}`;
    const existing = await this.getContext(topic);
    // context.history, when provided, is already the full merged history
    // (callers load existing history and append to it themselves) — so it
    // replaces rather than appends onto `existing.history`, or it would
    // duplicate every entry on each save.
    const updated = {
      ...existing,
      ...context,
      history: (context.history || existing?.history || []).slice(-20),
      updatedAt: new Date().toISOString(),
    };
    await this.db.put(key, updated);
  }

  async getContext(topic) {
    await this.init();
    try {
      return await this.db.get(`context:${topic}`);
    } catch (e) {
      if (e.code === 'LEVEL_NOT_FOUND') return null;
      throw e;
    }
  }

  async saveMetric(topic, metric) {
    await this.init();
    const key = `metric:${topic}:${Date.now()}`;
    await this.db.put(key, metric);
  }

  async getMetrics(topic, limit = 10) {
    await this.init();
    const metrics = [];
    for await (const [key, value] of this.db.iterator({
      gte: `metric:${topic}:`,
      lte: `metric:${topic}:\uffff`,
      reverse: true,
      limit,
    })) {
      metrics.push(value);
    }
    return metrics;
  }

  async getLearnedPatterns(topic) {
    const context = await this.getContext(topic);
    if (!context?.history?.length) return null;
    
    const latest = context.history[context.history.length - 1];
    return latest.outputs?.feedback?.learned_patterns || null;
  }

  async close() {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}