"""JSON-lines protocol between the sidecar and the app.

The sidecar's whole output contract is one JSON object per line on **stdout**,
and nothing else. That is why every diagnostic in this package goes to stderr:
a stray ``print`` would land in the middle of the stream and the app would drop
a frame it could not parse.

The events are deliberately graph-shaped rather than log-shaped. The app draws
the run as a network — executors and questions as nodes, dataflow as edges — so
what it needs is the graph's structure up front and status changes as they
happen, not prose it would have to parse back into a graph.
"""

from __future__ import annotations

import json
import sys
import threading
from dataclasses import dataclass, field
from typing import Any, Literal

NodeKind = Literal["plan", "research", "reflect", "synthesize", "question"]
NodeStatus = Literal["pending", "running", "done", "failed", "skipped"]

# One lock around stdout: executors run concurrently under asyncio, and two
# half-written lines interleaved is a stream the app cannot recover from.
_write_lock = threading.Lock()


def emit(event: dict[str, Any]) -> None:
    """Write one event. Flushed immediately — the app is drawing from this live."""
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(message: str, **fields: Any) -> None:
    """Diagnostics, on stderr, where they cannot corrupt the event stream."""
    detail = " ".join(f"{key}={value!r}" for key, value in fields.items())
    print(f"[iq-research] {message} {detail}".rstrip(), file=sys.stderr, flush=True)


@dataclass(slots=True)
class Node:
    id: str
    kind: NodeKind
    label: str
    status: NodeStatus = "pending"
    detail: str = ""
    round: int = 1


@dataclass(slots=True)
class Graph:
    """The run's reasoning graph, emitted as it is discovered.

    Held here as well as streamed because a client that attaches late — or
    reloads — needs the whole graph, and replaying a status stream to rebuild it
    would make the app responsible for the sidecar's bookkeeping.
    """

    nodes: dict[str, Node] = field(default_factory=dict)
    edges: list[tuple[str, str]] = field(default_factory=list)

    def node(self, node: Node) -> Node:
        # An unchanged node is not news. `publish_static` is deliberately called
        # both before the client is built and again inside `build`, so without
        # this every stage node went out twice on every run.
        existing = self.nodes.get(node.id)
        if existing is not None and (
            existing.kind,
            existing.label,
            existing.status,
            existing.detail,
            existing.round,
        ) == (node.kind, node.label, node.status, node.detail, node.round):
            return existing
        self.nodes[node.id] = node
        emit(
            {
                "type": "node",
                "id": node.id,
                "kind": node.kind,
                "label": node.label,
                "status": node.status,
                "detail": node.detail,
                "round": node.round,
            }
        )
        return node

    def edge(self, source: str, target: str) -> None:
        if (source, target) in self.edges:
            return
        self.edges.append((source, target))
        emit({"type": "edge", "from": source, "to": target})

    def status(self, node_id: str, status: NodeStatus, detail: str = "") -> None:
        node = self.nodes.get(node_id)
        if node is None:
            return
        node.status = status
        if detail:
            node.detail = detail
        emit({"type": "node_status", "id": node_id, "status": status, "detail": node.detail})

    def snapshot(self) -> dict[str, Any]:
        return {
            "nodes": [
                {
                    "id": n.id,
                    "kind": n.kind,
                    "label": n.label,
                    "status": n.status,
                    "detail": n.detail,
                    "round": n.round,
                }
                for n in self.nodes.values()
            ],
            "edges": [{"from": s, "to": t} for s, t in self.edges],
        }
