"""HTTP and CLI entry points for the observable production agent."""

from __future__ import annotations

import argparse
import hmac
import logging
import uuid
from contextlib import asynccontextmanager, nullcontext
from typing import Annotated, Any

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field

from agent import AgentRuntime, build_agent, extract_answer, user_message
from config import Settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("production-agent")


class InvokeRequest(BaseModel):
    message: str = Field(min_length=1)
    thread_id: str = Field(min_length=1, max_length=128)
    user_id: str | None = Field(default=None, max_length=128)


class InvokeResponse(BaseModel):
    answer: str
    thread_id: str
    request_id: str


def _callbacks(settings: Settings) -> list[Any]:
    callbacks: list[Any] = []
    if settings.langsmith_enabled:
        from langchain_core.tracers import LangChainTracer
        from langsmith import Client

        callbacks.append(LangChainTracer(project_name=settings.langsmith_project, client=Client()))
    if settings.langfuse_enabled:
        from langfuse.langchain import CallbackHandler

        callbacks.append(CallbackHandler())
    return callbacks


def invoke_agent(
    runtime: AgentRuntime,
    settings: Settings,
    payload: InvokeRequest,
    *,
    request_id: str | None = None,
) -> InvokeResponse:
    if len(payload.message) > settings.max_input_chars:
        raise ValueError(f"message exceeds {settings.max_input_chars} characters")
    request_id = request_id or str(uuid.uuid4())
    config: RunnableConfig = {
        "configurable": {"thread_id": payload.thread_id},
        "callbacks": _callbacks(settings),
        "metadata": {
            "request_id": request_id,
            "environment": settings.environment,
            "langfuse_session_id": payload.thread_id,
            "langfuse_user_id": payload.user_id,
            "langfuse_tags": ["langgraph", settings.environment],
        },
        "run_name": "production-agent",
        "recursion_limit": settings.recursion_limit,
        "tags": ["langgraph", settings.environment],
    }

    trace_context: Any = nullcontext()
    if settings.langfuse_enabled:
        from langfuse import propagate_attributes

        trace_context = propagate_attributes(
            session_id=payload.thread_id,
            user_id=payload.user_id,
            tags=["langgraph", settings.environment],
            metadata={"request_id": request_id},
            trace_name="production-agent",
        )
    with trace_context:
        result = runtime.graph.invoke({"messages": [user_message(payload.message)]}, config=config)
    return InvokeResponse(
        answer=extract_answer(result["messages"]),
        thread_id=payload.thread_id,
        request_id=request_id,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings.from_env()
    app.state.settings = settings
    app.state.runtime = build_agent(settings)
    logger.info("agent started model=%s environment=%s", settings.model, settings.environment)
    try:
        yield
    finally:
        if settings.langfuse_enabled:
            from langfuse import get_client

            get_client().flush()
        app.state.runtime.close()


app = FastAPI(title="Observable LangGraph Agent", version="1.0.0", lifespan=lifespan)


def authorize(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    expected = request.app.state.settings.api_key
    if expected is None:
        return
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


@app.get("/healthz")
def health(request: Request) -> dict[str, str]:
    return {"status": "ok", "model": request.app.state.settings.model}


@app.post("/v1/agent/invoke", response_model=InvokeResponse)
def invoke(
    payload: InvokeRequest,
    request: Request,
    _: Annotated[None, Depends(authorize)],
) -> InvokeResponse:
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    try:
        return invoke_agent(
            request.app.state.runtime,
            request.app.state.settings,
            payload,
            request_id=request_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        logger.exception("agent invocation failed request_id=%s", request_id)
        raise HTTPException(status_code=500, detail="Agent invocation failed") from None


def cli() -> None:
    parser = argparse.ArgumentParser(description="Observable LangGraph agent")
    parser.add_argument("message", nargs="?", help="Run one message instead of the API")
    parser.add_argument("--thread-id", default="cli")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    if args.message:
        settings = Settings.from_env()
        runtime = build_agent(settings)
        try:
            response = invoke_agent(
                runtime,
                settings,
                InvokeRequest(message=args.message, thread_id=args.thread_id),
            )
            print(response.answer)
        finally:
            if settings.langfuse_enabled:
                from langfuse import get_client

                get_client().flush()
            runtime.close()
        return
    uvicorn.run("main:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    cli()
