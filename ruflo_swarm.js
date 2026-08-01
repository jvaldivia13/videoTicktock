#!/usr/bin/env node
/**
 * Ruflo / Claude-Flow Implementation: TikTok Motivational Video Pipeline
 * ======================================================================
 * Minimal 5-stage swarm: Research → Script → Visual Plan → Package → Learn
 * Test topic: "disciplina matutina"
 * 
 * Usage: node ruflo_swarm.js
 * 
 * Note: This uses the local @claude-flow/cli installed in node_modules
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const TOPIC = "disciplina matutina";
const MAX_ITERATIONS = 2;

console.log('🌊 Ruflo / Claude-Flow: TikTok Motivational Video Pipeline');
console.log(`📝 Tema: ${TOPIC}\n`);

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function runClaudeFlow(args, input = null) {
  const cmd = CLI === 'npx.cmd' || CLI === 'npx' ? [CLI, ...args] : [CLI, ...args];
  const result = spawnSync(cmd[0], cmd.slice(1), {
    input: input ? JSON.stringify(input) : undefined,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
    env: { ...process.env, FORCE_COLOR: '1' }
  });
  
  if (result.error) {
    console.error(`❌ Error ejecutando claude-flow ${args.join(' ')}:`, result.error.message);
    return null;
  }
  if (result.status !== 0) {
    console.error(`❌ claude-flow exited ${result.status}:`, result.stderr);
    return null;
  }
  return result.stdout;
}

function parseOutput(output) {
  try {
    // Claude-flow outputs JSON or text with JSON embedded
    const lines = output.trim().split('\n');
    for (const line of lines) {
      if (line.trim().startsWith('{') || line.trim().startsWith('[')) {
        return JSON.parse(line);
      }
    }
    return { raw: output };
  } catch (e) {
    return { raw: output };
  }
}

// ──────────────────────────────────────────────────────────────
// Swarm Definition (JSON config for Ruflo)
// ──────────────────────────────────────────────────────────────
const swarmConfig = {
  name: "tiktok-motivation-swarm",
  description: "Automated TikTok motivational video production swarm",
  version: "1.0.0",
  agents: [
    {
      id: "researcher",
      name: "Trend Scout",
      role: "research",
      systemPrompt: `Eres un Trend Scout para TikTok nicho motivacional.
Investiga hooks virales, ángulos de storytelling, hashtags tendencia y mejores horas de posteo (GMT-5 Perú).
Devuelve SOLO JSON válido con: hooks[], angles[], hashtags[], best_post_time.`,
      tools: ["web_search"],
    },
    {
      id: "writer",
      name: "Copywriter Motivacional",
      role: "script",
      systemPrompt: `Eres Copywriter Motivacional para TikTok (45-60 seg).
Recibes research y produces guion JSON con: hook, story, lesson, cta, duration_estimate_sec.
Estructura: HOOK(0-3s) → STORY(3-15s) → LESSON(15-40s) → CTA(40-45s).
Devuelve SOLO JSON válido.`,
      tools: [],
    },
    {
      id: "creative",
      name: "Creative Director",
      role: "visual_plan",
      systemPrompt: `Eres Creative Director para video vertical 1080x1920.
Recibes guion y produces shot list JSON: shots[{start_sec,end_sec,visual_type,description,text_overlay,transition}], music{mood,bpm,source}, subtitles{style}.
visual_type: "stock"|"text"|"split"|"broll".
Devuelve SOLO JSON válido.`,
      tools: [],
    },
    {
      id: "optimizer",
      name: "Growth Optimizer",
      role: "package",
      systemPrompt: `Eres Growth Optimizer para TikTok.
Recibes visual plan y produces paquete publicación JSON: caption, hashtags[8-12], post_time(GMT-5), thumbnail_text(≤3 palabras), first_comment.
Devuelve SOLO JSON válido.`,
      tools: [],
    },
    {
      id: "analyst",
      name: "Performance Analyst",
      role: "learn",
      systemPrompt: `Eres Analyst de rendimiento TikTok.
Recibes historial y paquete actual. Simula métricas 24h y genera feedback JSON:
simulated_metrics{views,avg_watch_pct,shares,saves,comments}, what_worked[], what_failed[], next_iteration_advice, continue_iterating.
Devuelve SOLO JSON válido.`,
      tools: [],
    },
  ],
  workflow: {
    // Sequential pipeline with feedback loop
    steps: [
      { agent: "researcher", input: "topic", output: "research" },
      { agent: "writer", input: "research", output: "script" },
      { agent: "creative", input: "script", output: "visual_plan" },
      { agent: "optimizer", input: "visual_plan", output: "package" },
      { agent: "analyst", input: ["history", "package"], output: "feedback" },
    ],
    // Feedback loop: analyst → researcher (max iterations)
    loop: {
      condition: "iteration < max_iterations && feedback.continue_iterating",
      backTo: "researcher",
      carryOver: ["feedback", "history", "iteration"],
    },
  },
  config: {
    maxIterations: MAX_ITERATIONS,
    sharedMemory: true,
    hiveMind: true,
  },
};

// ──────────────────────────────────────────────────────────────
// Execution
// ──────────────────────────────────────────────────────────────
async function main() {
  console.log('📋 Configurando swarm...');
  
  // Write swarm config
  const configPath = path.join(__dirname, 'swarm-config.json');
  fs.writeFileSync(configPath, JSON.stringify(swarmConfig, null, 2));
  
  console.log('🚀 Lanzando swarm con claude-flow...');
  
  // Try to run swarm via CLI
  // Note: Actual CLI commands may vary by version
  const commands = [
    // Initialize swarm
    ['swarm', 'init', '--config', configPath],
    // Run with topic
    ['swarm', 'run', '--topic', TOPIC, '--iterations', MAX_ITERATIONS.toString()],
  ];
  
  let history = [];
  let feedback = null;
  let iteration = 0;
  let finalOutput = null;
  
  for (const cmd of commands) {
    console.log(`\n🔧 Ejecutando: claude-flow ${cmd.join(' ')}`);
    const output = runClaudeFlow(cmd);
    
    if (output) {
      console.log('📤 Output:', output.substring(0, 500) + (output.length > 500 ? '...' : ''));
      const parsed = parseOutput(output);
      if (parsed.package) finalOutput = parsed;
      if (parsed.feedback) feedback = parsed;
      if (parsed.history) history = parsed.history;
    }
  }
  
  // If CLI doesn't support swarm directly, show equivalent commands
  console.log('\n📝 === COMANDOS EQUIVALENTES PARA EJECUCIÓN MANUAL ===');
  console.log(`
# 1. Crear swarm
claude-flow swarm create --name tiktok-motivation --agents researcher,writer,creative,optimizer,analyst

# 2. Ejecutar pipeline
claude-flow swarm run --topic "${TOPIC}" --max-iterations ${MAX_ITERATIONS}

# 3. Ver estado compartido (hive-mind)
claude-flow memory get --swarm tiktok-motivation

# 4. Continuar iteración con feedback
claude-flow swarm continue --feedback "mejorar hook emocional" --iteration 2
  `);
  
  // Simulated output for comparison
  const simulatedResult = {
    topic: TOPIC,
    iteration: MAX_ITERATIONS,
    research: {
      hooks: ["¿Por qué fallas cada mañana?", "El secreto de los que madrugan", "3 segundos que cambian tu día"],
      angles: ["micro-hábito", "mentalidad estoica", "compound effect"],
      hashtags: ["#disciplina", "#madrugadores", "#hbitos"],
      best_post_time: "06:30"
    },
    script: {
      hook: "Tu alarma suena. ¿Te levantas o aprietas 'posponer'?",
      story: "Hace 2 años yo también apretaba posponer. Hasta que entendí: la disciplina no es fuerza de voluntad, es diseño de entorno.",
      lesson: "Regla del 5-5-5: 5 min agua, 5 min movimiento, 5 min intención. Sin teléfono. Cambia tu trajectory.",
      cta: "Prueba 3 días y cuéntame. Sígueme por más sistemas, no motivación.",
      duration_estimate_sec: 48
    },
    visual_plan: {
      shots: [
        {start_sec: 0, end_sec: 3, visual_type: "split", description: "Alarma sonando / persona durmiendo", text_overlay: "¿Pospones?", transition: "cut"},
        {start_sec: 3, end_sec: 15, visual_type: "broll", description: "Persona bebiendo agua, estirando, escribiendo", text_overlay: "5-5-5 System", transition: "flow"},
        {start_sec: 15, end_sec: 40, visual_type: "text", description: "Texto animado: principios clave", text_overlay: "Entorno > Voluntad", transition: "fade"},
        {start_sec: 40, end_sec: 48, visual_type: "stock", description: "Persona sonriendo, día productivo", text_overlay: "3 días. Prueba.", transition: "zoom"}
      ],
      music: {mood: "epic calm", bpm: 85, source: "YouTube Audio Library - 'Dawn'" },
      subtitles: {style: "Montserrat Bold, blanco con outline negro, bottom-center, pop-in animation"}
    },
    package: {
      caption: "Tu mañana define tu vida. Sistema 5-5-5 🌅\n\n#disciplina #madrugadores #hbitos #productividad #mindset #rutinamatutina #crecimientopersonal #sistemas #motivacion #cambio",
      hashtags: ["#disciplina", "#madrugadores", "#hbitos", "#productividad", "#mindset", "#rutinamatutina", "#crecimientopersonal", "#sistemas", "#motivacion", "#cambio"],
      post_time: "06:30",
      thumbnail_text: "Sistema 5-5-5",
      first_comment: "¿Cuál es tu excusa matutina favorita? 👇 Leo todas."
    },
    feedback: {
      simulated_metrics: {views: 12400, avg_watch_pct: 67, shares: 89, saves: 234, comments: 67},
      what_worked: ["Hook directo y relatable", "Sistema concreto (5-5-5) no vaguedad", "CTA accionable y baja fricción"],
      what_failed: ["Visual plan muy dependiente de stock footage genérico", "Música 'epic calm' puede ser muy usada"],
      next_iteration_advice: "Probar hook 'Odio madrugar pero amo lo que logro' + ángulo 'anti-motivación'. Usar broll personal estilo POV. Postear 06:00 para captar early risers.",
      continue_iterating: true
    }
  };
  
  // Save simulated result
  fs.writeFileSync(
    path.join(__dirname, 'ruflo_result.json'),
    JSON.stringify(simulatedResult, null, 2)
  );
  
  console.log('\n✅ Simulación completada. Resultado guardado en ruflo_result.json');
  console.log('\n📦 PAQUETE FINAL (simulado):');
  console.log(JSON.stringify(simulatedResult.package, null, 2));
  console.log('\n🔄 FEEDBACK LOOP (iteración 2):');
  console.log(simulatedResult.feedback.next_iteration_advice);
}

main().catch(console.error);