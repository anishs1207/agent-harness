import os
from langfuse import get_client
from langfuse.openai import OpenAI as LFOpenAI
from langfuse import observe
from langfuse import get_client as _gc
from langfuse import propagate_attributes
import uuid
from openai import OpenAI
import json as _json
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor
from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv()

MODEL = os.getenv("MODEL", "google/gemma-4-26b-a4b-it:free") 

langfuse = get_client()
assert langfuse.auth_check(), "Auth failed — check keys and that LANGFUSE_HOST region matches your project."
print("Langfuse connected.")

# OpenRouter is OpenAI-API-compatible -> reuse the OpenAI client, point base_url at it.
client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.environ["OPENROUTER_API_KEY"],
)

# --- Two trivial tools ---
def get_word_length(word: str) -> int:
    return len(word)

def multiply(a: float, b: float) -> float:
    return a * b

TOOLS = {
    "get_word_length": get_word_length,
    "multiply": multiply,
}

TOOL_SPEC = """You have these tools. To call one, output EXACTLY one line:
ACTION: <tool_name> <json_args>
Examples:
ACTION: get_word_length {"word": "observability"}
ACTION: multiply {"a": 6, "b": 7}
When you have the final answer, output:
FINAL: <answer>
Tools:
- get_word_length(word): returns integer length
- multiply(a, b): returns a*b
"""

# Agentic system setup

def call_model(messages):
    resp = client.chat.completions.create(model=MODEL, messages=messages, max_tokens=300)
    return resp.choices[0].message.content

def run_agent(question, max_steps=5):
    messages = [
        {"role": "system", "content": TOOL_SPEC},
        {"role": "user", "content": question},
    ]
    for step in range(max_steps):
        out = call_model(messages)
        print(f"[step {step}] model: {out.strip()[:120]}")
        if "FINAL:" in out:
            return out.split("FINAL:")[-1].strip()
        if "ACTION:" in out:
            line = [l for l in out.splitlines() if l.strip().startswith("ACTION:")][0]
            rest = line.split("ACTION:")[-1].strip()
            name, _, arg_str = rest.partition(" ")
            args = _json.loads(arg_str)
            result = TOOLS[name](**args)
            print(f"[step {step}] tool {name}{args} -> {result}")
            messages.append({"role": "assistant", "content": out})
            messages.append({"role": "user", "content": f"OBSERVATION: {result}"})
        else:
            messages.append({"role": "assistant", "content": out})
            messages.append({"role": "user", "content": "Use ACTION: or FINAL:"})
    return "(no final answer)"

print(run_agent("How long is the word 'observability', and what is that number times 3?"))

# Build the OTel pipeline by hand (tracer -> span processor -> exporter)
otel_provider = TracerProvider()
otel_provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
trace.set_tracer_provider(otel_provider)
tracer = trace.get_tracer("class24")

# Manually trace one agent step as raw OTel spans.
# A "generation" in OTel is just a span with conventionally-named attributes.
with tracer.start_as_current_span("agent-run") as root:
    root.set_attribute("user", "student")
    with tracer.start_as_current_span("llm-call") as gen:
        gen.set_attribute("gen_ai.request.model", MODEL)
        gen.set_attribute("gen_ai.usage.input_tokens", 412)   # we'd have to count these ourselves
        gen.set_attribute("gen_ai.usage.output_tokens", 87)
        gen.set_attribute("llm.prompt", "How long is 'observability' x3?")
        gen.set_attribute("llm.completion", "13 letters; 13 x 3 = 39.")
# Spans print on exit. Read the output carefully.

# Same constructor, now auto-traced.
client = LFOpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.environ["OPENROUTER_API_KEY"],
)

@observe()
def agent_step(messages, step):
    out = call_model(messages)   # auto-traced generation nests under this span
    return out

@observe()
def traced_agent(question, max_steps=5):
    messages = [
        {"role": "system", "content": TOOL_SPEC},
        {"role": "user", "content": question},
    ]
    for step in range(max_steps):
        out = agent_step(messages, step)
        if "FINAL:" in out:
            return out.split("FINAL:")[-1].strip()
        if "ACTION:" in out:
            line = [l for l in out.splitlines() if l.strip().startswith("ACTION:")][0]
            rest = line.split("ACTION:")[-1].strip()
            name, _, arg_str = rest.partition(" ")
            args = _json.loads(arg_str)
            result = TOOLS[name](**args)
            messages.append({"role": "assistant", "content": out})
            messages.append({"role": "user", "content": f"OBSERVATION: {result}"})
        else:
            messages.append({"role": "assistant", "content": out})
            messages.append({"role": "user", "content": "Use ACTION: or FINAL:"})
    return "(no final answer)"

answer = traced_agent("How long is the word 'observability', and what is that number times 3?")
langfuse.flush()   # short-lived process -> force the batch out (more on this in Part 5)
print("Answer:", answer)
print("Open https://cloud.langfuse.com -> your project -> Traces. Click the latest trace.")

with langfuse.start_as_current_observation(as_type="span", name="manual-demo") as span:
    span.update(input={"task": "demo"})
    with langfuse.start_as_current_observation(
        as_type="generation", name="llm-call", model=MODEL
    ) as gen:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": "Say 'traced' and nothing else."}],
            max_tokens=10,
        )
        gen.update(output=resp.choices[0].message.content)
    span.update(output="done")

langfuse.flush()
print("Manual trace sent. Note how the generation nests under the span in the UI.")

# Capture the trace id of a fresh run so we can attach a score to it.
with langfuse.start_as_current_observation(as_type="span", name="scored-run") as root:
    answer = traced_agent("What is the length of 'trace' multiplied by 10?")
    trace_id = langfuse.get_current_trace_id()
    root.update(output=answer)

langfuse.flush()
print("answer:", answer, "| trace:", trace_id)

# Simple LLM-as-judge: does the answer correctly reason about the task?
judge_prompt = f"""You are grading an agent answer. Question involved len('trace')=5 times 10 = 50.
Agent answer: {answer!r}
Reply with ONLY a number 1 if the answer is 50 (or clearly states 50), else 0."""

judge = client.chat.completions.create(
    model=MODEL, messages=[{"role": "user", "content": judge_prompt}], max_tokens=5
)
raw = judge.choices[0].message.content.strip()
score_value = 1.0 if "1" in raw else 0.0

langfuse.create_score(
    trace_id=trace_id,
    name="judge_correct",
    value=score_value,
    comment=f"LLM judge raw output: {raw!r}",
)
langfuse.flush()
print(f"Attached score judge_correct={score_value} to trace {trace_id}")
print("Refresh the trace in the UI — the score now appears on it.")

# Group two turns of a conversation under one session, tagged as a non-prod environment.
# v4: trace-level fields (session_id, tags, user_id, environment) are set with
# propagate_attributes() as a context manager — everything traced inside inherits them.

session_id = f"demo-session-{uuid.uuid4().hex[:8]}"

for turn in ["How long is 'span'?", "Multiply that by 4."]:
    with propagate_attributes(session_id=session_id, tags=["class24", "env:dev"]):
        with langfuse.start_as_current_observation(as_type="span", name="chat-turn") as s:
            ans = traced_agent(turn)
            s.update(output=ans)

langfuse.flush()
print(f"Two turns grouped under session {session_id}. See Sessions view in the UI.")

# THE BREAK: run, then immediately "end" without flushing.
# In a real script the process would exit here. We simulate by NOT calling flush
# and creating a brand-new client so nothing else triggers a flush.

_lf = _gc()

with _lf.start_as_current_observation(as_type="span", name="unflushed-run") as s:
    s.update(input={"q": "this trace may never arrive"}, output="done")

# (no flush)  -> check the UI now. The 'unflushed-run' trace is likely missing/partial.
print("Created 'unflushed-run' WITHOUT flushing. Check the UI — likely not there yet.")

# THE FIX: one line. Forces the queue to send and blocks until done.
_lf.flush()
print("Flushed. 'unflushed-run' now appears in the UI.")
print("Lesson: ANY OTel-based tracing batches by default ->")
print("short-lived processes need an explicit flush() / shutdown().")
