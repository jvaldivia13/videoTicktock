import { EventEmitter } from 'events';

function assertSafeGatewayUrl(url) {
  const u = new URL(url);
  const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  if (u.protocol !== 'https:' && !isLoopback) {
    throw new Error(`Refusing to send bearer token over ${u.protocol} to non-loopback host ${u.hostname}`);
  }
}

export class SwarmRunner extends EventEmitter {
  constructor(swarmConfig, config, hiveMind, logger) {
    super();
    this.config = swarmConfig;
    this.appConfig = config;
    this.hiveMind = hiveMind;
    this.logger = logger;
    this.llmClient = this.createLLMClient();
  }

  createLLMClient() {
    const baseUrl = this.appConfig.get('OPENCLAW_GATEWAY_URL') || 'http://localhost:18789/v1';
    const token = this.appConfig.get('OPENCLAW_TOKEN') || '';
    const primaryModel = this.appConfig.get('PRIMARY_MODEL') || 'nvidia/nemotron-3-ultra-550b-a55b';
    const fallbackModel = this.appConfig.get('FALLBACK_MODEL') || 'deepseek/deepseek-v4-flash';
    assertSafeGatewayUrl(baseUrl);

    return {
      baseUrl,
      token,
      primaryModel,
      fallbackModel,
      async complete(messages, options = {}) {
        const model = options.model || primaryModel;
        const timeoutMs = options.timeoutMs || 60000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response;
        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
              model,
              messages,
              temperature: options.temperature || 0.7,
              max_tokens: options.maxTokens || 2000,
              stream: false,
            }),
            signal: controller.signal,
          });
        } catch (err) {
          if (err.name === 'AbortError' && model !== fallbackModel) {
            return this.complete(messages, { ...options, model: fallbackModel });
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          // Try fallback
          if (model !== fallbackModel) {
            await response.body?.cancel();
            return this.complete(messages, { ...options, model: fallbackModel });
          }
          throw new Error(`LLM error: ${response.status} ${(await response.text()).slice(0, 300)}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (content == null) {
          throw new Error(`LLM response missing choices[0].message.content: ${JSON.stringify(data).slice(0, 300)}`);
        }
        return content;
      },
    };
  }

  async run({ topic, maxIterations = 3 }) {
    this.logger.info({ topic, maxIterations }, 'Starting swarm run');
    
    let iteration = 0;
    let feedback = null;
    const history = [];
    const outputs = {};
    
    // Load previous hive-mind context if exists
    const previousContext = await this.hiveMind.getContext(topic);
    if (previousContext) {
      this.logger.info('Loaded previous hive-mind context');
      feedback = previousContext.latestFeedback;
      history.push(...(previousContext.history || []));
    }
    
    while (iteration < maxIterations) {
      iteration++;
      this.logger.info({ iteration }, `Swarm iteration ${iteration}`);
      
      // Execute each agent in sequence
      for (const step of this.config.workflow.steps) {
        const agent = this.config.agents.find(a => a.id === step.agent);
        if (!agent) {
          throw new Error(`Agent ${step.agent} not found`);
        }
        
        this.logger.info({ agent: agent.id }, `Running agent: ${agent.name}`);
        
        // Build input for this agent
        const input = this.buildAgentInput(step, outputs, feedback, topic, history);
        
        // Call agent
        const output = await this.runAgent(agent, input);
        outputs[step.output] = output;
        
        this.emit('agent-complete', { agent: agent.id, output });
      }
      
      // Save iteration to history
      const iterationRecord = {
        iteration,
        topic,
        outputs: { ...outputs },
        timestamp: new Date().toISOString(),
      };
      history.push(iterationRecord);
      
      // Check loop condition
      const shouldContinue = this.evaluateLoopCondition(iteration, maxIterations, outputs.feedback);
      
      if (!shouldContinue) {
        this.logger.info('Loop condition false, ending swarm');
        break;
      }
      
      // Update feedback for next iteration
      feedback = outputs.feedback;
    }
    
    // Save to hive-mind
    await this.hiveMind.saveContext(topic, {
      latestFeedback: feedback,
      history,
      lastRun: new Date().toISOString(),
    });
    
    return {
      package: outputs.package,
      visualPlan: outputs.visual_plan,
      script: outputs.script,
      research: outputs.research,
      feedback: outputs.feedback,
      iteration,
      history,
    };
  }

  buildAgentInput(step, outputs, feedback, topic, history) {
    const input = {};
    
    for (const key of step.input) {
      switch (key) {
        case 'topic':
          input.topic = topic;
          break;
        case 'feedback':
          input.feedback = feedback ? JSON.stringify(feedback, null, 2) : 'Ninguno (primera iteración)';
          break;
        case 'history':
          input.history = JSON.stringify(history.slice(-3), null, 2); // Last 3 iterations
          break;
        case 'real_metrics':
          input.real_metrics = feedback?.real_metrics ? JSON.stringify(feedback.real_metrics, null, 2) : 'No disponible';
          break;
        default:
          if (outputs[key]) {
            input[key] = typeof outputs[key] === 'string' ? outputs[key] : JSON.stringify(outputs[key], null, 2);
          }
      }
    }
    
    return input;
  }

  async runAgent(agent, input) {
    const systemPrompt = agent.systemPrompt;
    const userPrompt = `Input:\n${JSON.stringify(input, null, 2)}\n\nOutput ONLY valid JSON as specified in your instructions.`;
    
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    
    try {
      const response = await this.llmClient.complete(messages, {
        temperature: agent.config?.temperature || 0.7,
        maxTokens: agent.config?.maxTokens || 2000,
      });

      // Parse JSON from response
      return this.parseJSONResponse(response);
    } catch (error) {
      this.logger.error({ agent: agent.id, error: error.message }, 'Agent failed');
      // Fail loudly instead of returning an {error} object that downstream
      // stages would otherwise treat as valid agent output.
      throw new Error(`Agent "${agent.id}" failed: ${error.message}`);
    }
  }

  parseJSONResponse(response) {
    if (typeof response !== 'string') {
      throw new Error('No valid JSON found in response (non-string response)');
    }
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        // Try to find valid JSON
        const lines = response.split('\n');
        let braceCount = 0;
        let startIdx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('{') && startIdx === -1) startIdx = i;
          if (startIdx !== -1) {
            braceCount += (lines[i].match(/{/g) || []).length;
            braceCount -= (lines[i].match(/}/g) || []).length;
            if (braceCount === 0 && startIdx !== -1) {
              try {
                return JSON.parse(lines.slice(startIdx, i + 1).join('\n'));
              } catch (e2) {
                // Continue searching
              }
            }
          }
        }
      }
    }
    throw new Error('No valid JSON found in response');
  }

  evaluateLoopCondition(iteration, maxIterations, feedback) {
    if (iteration >= maxIterations) return false;
    if (!feedback) return false;
    return feedback.continue_iterating === true;
  }
}