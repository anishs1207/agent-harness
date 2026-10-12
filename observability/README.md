# Observable production agent

A production-oriented service using LangChain for models/tools, LangGraph for
the agent loop and durable memory, and both LangSmith and Langfuse for tracing.

## Run

Use Python 3.11 or newer from this directory:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.sample .env
# Fill in OPENROUTER_API_KEY and either/both observability providers.
python main.py
```

Invoke it:

```powershell
$headers = @{ Authorization = "Bearer change-me" }
$body = @{ message = "How long is observability, multiplied by 3?"; thread_id = "demo-1" } | ConvertTo-Json
Invoke-RestMethod http://localhost:8000/v1/agent/invoke -Method Post -Headers $headers -ContentType application/json -Body $body
```

Reuse `thread_id` on later turns so LangGraph restores the conversation. A
one-off call is also available with `python main.py "Multiply 6 by 7"`.

## Production notes

- Set a strong `AGENT_API_KEY`; an empty value disables authentication.
- Put the service behind TLS and a rate-limiting gateway.
- SQLite is durable for one process. Use a shared Postgres checkpointer for
  multiple workers or replicas.
- LangSmith runs only when tracing is true and its key exists. Langfuse runs
  only when both keys exist. Langfuse buffers are flushed on graceful shutdown.
- `/healthz` is shallow: it does not spend tokens or call vendors.
