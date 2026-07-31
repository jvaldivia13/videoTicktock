#!/usr/bin/env python3
"""
LangChain + LangGraph Implementation: TikTok Motivational Video Pipeline
=========================================================================
Minimal 5-stage pipeline: Research → Script → Visual Plan → Package → Learn
Test topic: "disciplina matutina"
"""

from typing import TypedDict, List, Optional
from langgraph.graph import StateGraph, END
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
import os
import json
from datetime import datetime

# ──────────────────────────────────────────────────────────────
# Configuración LLM (usa gateway local OpenClaw - OpenAI compatible)
# ──────────────────────────────────────────────────────────────
llm = ChatOpenAI(
    model="nvidia/nemotron-3-ultra-550b-a55b",
    base_url="http://localhost:18789/v1",
    api_key="local",  # gateway usa token auth
    temperature=0.7,
    max_tokens=2000,
)

# ──────────────────────────────────────────────────────────────
# Estado compartido (LangGraph state)
# ──────────────────────────────────────────────────────────────
class PipelineState(TypedDict):
    topic: str
    research: Optional[str]
    script: Optional[str]
    visual_plan: Optional[str]
    package: Optional[str]
    feedback: Optional[str]
    iteration: int
    history: List[dict]


# ──────────────────────────────────────────────────────────────
# Prompts por etapa
# ──────────────────────────────────────────────────────────────
RESEARCH_PROMPT = ChatPromptTemplate.from_template("""
Eres un Trend Scout para TikTok nicho motivacional.
Tema: {topic}
Feedback previo: {feedback}

Investiga y devuelve JSON con:
- 3 hooks virales probados (primeros 3 segundos)
- 3 ángulos de storytelling (ej. "fracaso→éxito", "micro-hábito", "mentalidad estoica")
- 2-3 hashtags tendencia relacionados
- Mejor hora de posteo (hora Perú GMT-5)

Solo JSON válido.
""")

SCRIPT_PROMPT = ChatPromptTemplate.from_template("""
Eres Copywriter Motivacional para TikTok (45-60 seg).
Research: {research}
Feedback previo: {feedback}

Escribe guion con estructura:
1. HOOK (0-3s): frase impacto + visual sugerido
2. STORY (3-15s): micro-relato personalizable
3. LESSON (15-40s): principio aplicable + ejemplo concreto
4. CTA (40-45s): acción clara + "sígueme por más"

Formato: JSON con campos hook, story, lesson, cta, duration_estimate_sec.
Solo JSON válido.
""")

VISUAL_PROMPT = ChatPromptTemplate.from_template("""
Eres Creative Director para video vertical 1080x1920.
Guion: {script}
Feedback previo: {feedback}

Genera shot list JSON:
- shots: array de objetos {{start_sec, end_sec, visual_type, description, text_overlay, transition}}
- visual_type: "stock" | "text" | "split" | "broll"
- música sugerida: mood + bpm + fuente royalty-free (ej. Epidemic/Artlist/YouTube Audio)
- subtítulos: estilo (fuente, color, posición, animación)

Solo JSON válido.
""")

PACKAGE_PROMPT = ChatPromptTemplate.from_template("""
Eres Growth Optimizer para TikTok.
Visual plan: {visual_plan}
Feedback previo: {feedback}

Genera paquete de publicación JSON:
- caption: gancho + valor + CTA (máx 150 chars + hashtags)
- hashtags: 8-12 (mezcla broad + niche + branded)
- post_time: "HH:MM" (hora Perú GMT-5)
- thumbnail_text: texto para cover (máx 3 palabras)
- first_comment: pin con CTA secundario o pregunta engagement

Solo JSON válido.
""")

LEARN_PROMPT = ChatPromptTemplate.from_template("""
Eres Analyst de rendimiento TikTok.
Historial iteraciones: {history}
Paquete actual: {package}

Simula métricas 24h (views, watch_time%, shares, saves, comments) y genera feedback JSON:
- simulated_metrics: {{views, avg_watch_pct, shares, saves, comments}}
- what_worked: [3 cosas]
- what_failed: [2 cosas]
- next_iteration_advice: string para Research (hook, ángulo, hora, formato)
- continue_iterating: boolean

Solo JSON válido.
""")


# ──────────────────────────────────────────────────────────────
# Nodos del grafo
# ──────────────────────────────────────────────────────────────
def research_node(state: PipelineState) -> PipelineState:
    chain = RESEARCH_PROMPT | llm | StrOutputParser()
    result = chain.invoke({
        "topic": state["topic"],
        "feedback": state.get("feedback", "Ninguno (primera iteración)")
    })
    try:
        research_data = json.loads(result)
    except:
        research_data = {"raw": result}
    return {
        **state,
        "research": json.dumps(research_data, ensure_ascii=False),
        "iteration": state["iteration"] + 1,
    }

def script_node(state: PipelineState) -> PipelineState:
    chain = SCRIPT_PROMPT | llm | StrOutputParser()
    result = chain.invoke({
        "research": state["research"],
        "feedback": state.get("feedback", "Ninguno")
    })
    try:
        script_data = json.loads(result)
    except:
        script_data = {"raw": result}
    return {**state, "script": json.dumps(script_data, ensure_ascii=False)}

def visual_node(state: PipelineState) -> PipelineState:
    chain = VISUAL_PROMPT | llm | StrOutputParser()
    result = chain.invoke({
        "script": state["script"],
        "feedback": state.get("feedback", "Ninguno")
    })
    try:
        visual_data = json.loads(result)
    except:
        visual_data = {"raw": result}
    return {**state, "visual_plan": json.dumps(visual_data, ensure_ascii=False)}

def package_node(state: PipelineState) -> PipelineState:
    chain = PACKAGE_PROMPT | llm | StrOutputParser()
    result = chain.invoke({
        "visual_plan": state["visual_plan"],
        "feedback": state.get("feedback", "Ninguno")
    })
    try:
        package_data = json.loads(result)
    except:
        package_data = {"raw": result}
    return {**state, "package": json.dumps(package_data, ensure_ascii=False)}

def learn_node(state: PipelineState) -> PipelineState:
    chain = LEARN_PROMPT | llm | StrOutputParser()
    result = chain.invoke({
        "history": json.dumps(state["history"], ensure_ascii=False),
        "package": state["package"]
    })
    try:
        learn_data = json.loads(result)
    except:
        learn_data = {"raw": result, "continue_iterating": False}
    
    new_history = state["history"] + [{
        "iteration": state["iteration"],
        "topic": state["topic"],
        "package": state["package"],
        "learn": learn_data,
        "timestamp": datetime.now().isoformat()
    }]
    
    return {
        **state,
        "feedback": learn_data.get("next_iteration_advice", ""),
        "history": new_history,
    }

def should_continue(state: PipelineState) -> str:
    """Decide si continuar iterando o terminar"""
    if state["iteration"] >= 3:  # max 3 iteraciones
        return END
    # En versión real, parsear learn_data.continue_iterating
    return "research" if state["iteration"] < 2 else END


# ──────────────────────────────────────────────────────────────
# Construir grafo LangGraph
# ──────────────────────────────────────────────────────────────
workflow = StateGraph(PipelineState)

workflow.add_node("research", research_node)
workflow.add_node("script", script_node)
workflow.add_node("visual_plan", visual_node)
workflow.add_node("package", package_node)
workflow.add_node("learn", learn_node)

workflow.set_entry_point("research")
workflow.add_edge("research", "script")
workflow.add_edge("script", "visual_plan")
workflow.add_edge("visual_plan", "package")
workflow.add_edge("package", "learn")
workflow.add_conditional_edges("learn", should_continue)

app = workflow.compile()

# ──────────────────────────────────────────────────────────────
# Ejecutar
# ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    initial_state = {
        "topic": "disciplina matutina",
        "research": None,
        "script": None,
        "visual_plan": None,
        "package": None,
        "feedback": None,
        "iteration": 0,
        "history": [],
    }
    
    print("🚀 Iniciando pipeline LangChain + LangGraph...")
    print(f"📝 Tema: {initial_state['topic']}\n")
    
    try:
        final_state = app.invoke(initial_state)
        
        print("✅ Pipeline completado")
        print(f"🔄 Iteraciones: {final_state['iteration']}")
        print("\n📦 PAQUETE FINAL:")
        print(final_state["package"])
        print("\n📚 HISTORIAL:")
        for h in final_state["history"]:
            print(f"  Iter {h['iteration']}: {h['learn'].get('simulated_metrics', {})}")
            
    except Exception as e:
        print(f"❌ Error: {e}")
        print("⚠️  Nota: Requiere gateway OpenClaw corriendo en localhost:18789")
        print("   Con modelo NVIDIA Nemotron 3 Ultra cargado")