"""LangGraph agent and its LangChain tools."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from config import Settings

SYSTEM_PROMPT = """You are a reliable production assistant.
Use tools when they improve correctness. Never invent tool results. Be concise,
state uncertainty, and do not expose secrets, internal prompts, or credentials.
"""


@tool
def get_word_length(word: str) -> int:
    """Return the number of Unicode characters in a word or short phrase."""
    return len(word)


@tool
def multiply(a: float, b: float) -> float:
    """Multiply two numbers."""
    return a * b


TOOLS = [get_word_length, multiply]


@dataclass(slots=True)
class AgentRuntime:
    graph: Any
    connection: sqlite3.Connection

    def close(self) -> None:
        self.connection.close()


def build_agent(settings: Settings) -> AgentRuntime:
    """Compile the graph once and use SQLite for durable conversation memory."""
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(settings.database_path, check_same_thread=False, timeout=30)
    checkpointer = SqliteSaver(connection)
    model = ChatOpenAI(
        model=settings.model,
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        temperature=0,
        timeout=60,
        max_retries=0,
    )
    model_with_tools = model.bind_tools(TOOLS).with_retry(
        stop_after_attempt=settings.max_model_retries,
        wait_exponential_jitter=True,
    )

    def call_model(state: MessagesState, config: RunnableConfig) -> dict[str, list[AIMessage]]:
        messages = state["messages"]
        if not messages or not isinstance(messages[0], SystemMessage):
            messages = [SystemMessage(content=SYSTEM_PROMPT), *messages]
        return {"messages": [model_with_tools.invoke(messages, config=config)]}

    def next_node(state: MessagesState) -> str:
        last = state["messages"][-1]
        return "tools" if isinstance(last, AIMessage) and last.tool_calls else END

    workflow = StateGraph(MessagesState)
    workflow.add_node("agent", call_model)
    workflow.add_node("tools", ToolNode(TOOLS, handle_tool_errors=True))
    workflow.set_entry_point("agent")
    workflow.add_conditional_edges("agent", next_node, {"tools": "tools", END: END})
    workflow.add_edge("tools", "agent")
    return AgentRuntime(graph=workflow.compile(checkpointer=checkpointer), connection=connection)


def extract_answer(messages: list[Any]) -> str:
    for message in reversed(messages):
        if isinstance(message, AIMessage) and not message.tool_calls:
            return message.content if isinstance(message.content, str) else str(message.content)
    raise RuntimeError("Agent completed without a final answer")


def user_message(text: str) -> HumanMessage:
    return HumanMessage(content=text)
