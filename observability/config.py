"""Validated runtime configuration for the agent service."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def _as_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    return default if value is None else value.lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class Settings:
    model: str
    openrouter_api_key: str
    openrouter_base_url: str
    database_path: Path
    environment: str
    max_input_chars: int
    max_model_retries: int
    recursion_limit: int
    api_key: str | None
    langsmith_enabled: bool
    langsmith_project: str
    langfuse_enabled: bool

    @classmethod
    def from_env(cls) -> "Settings":
        key = os.getenv("OPENROUTER_API_KEY", "").strip()
        if not key:
            raise RuntimeError("OPENROUTER_API_KEY is required")
        database_path = Path(os.getenv("CHECKPOINT_DB", str(BASE_DIR / "agent-checkpoints.sqlite")))
        if not database_path.is_absolute():
            database_path = BASE_DIR / database_path
        return cls(
            model=os.getenv("MODEL", "openai/gpt-4.1-mini"),
            openrouter_api_key=key,
            openrouter_base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
            database_path=database_path.resolve(),
            environment=os.getenv("APP_ENV", "development"),
            max_input_chars=int(os.getenv("MAX_INPUT_CHARS", "12000")),
            max_model_retries=int(os.getenv("MAX_MODEL_RETRIES", "3")),
            recursion_limit=int(os.getenv("RECURSION_LIMIT", "25")),
            api_key=os.getenv("AGENT_API_KEY") or None,
            langsmith_enabled=_as_bool("LANGSMITH_TRACING") and bool(os.getenv("LANGSMITH_API_KEY")),
            langsmith_project=os.getenv("LANGSMITH_PROJECT", "production-agent"),
            langfuse_enabled=bool(os.getenv("LANGFUSE_PUBLIC_KEY") and os.getenv("LANGFUSE_SECRET_KEY")),
        )
