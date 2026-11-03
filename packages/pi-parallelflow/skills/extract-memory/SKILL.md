---
name: extract-memory
description: Read one day of an arena (messages, events, approved files, pull requests) and return the people, decisions, ground rules, requirements, questions, risks, action items and topics in it as strict JSON for the arena's memory graph. Use when the ParallelFlow app asks for a memory extraction (nightly, never for a chat reply).
---

# Extract the arena's memory for one day

The request gives you one day of the arena: its messages (M1, M2…), the events the app recorded (E1…), files approved that day (F1…) and pull requests (P1…), plus the items the memory already holds, with their keys. You turn the day into items for the team's memory. ParallelFlow merges them into a graph; people read it as STATE.md, the arena's story. Call no tool that changes anything. The request has everything you need, so you rarely need a tool.

Reply with **only** one JSON object, no prose before or after it, in exactly this shape:

```json
{
  "nodes": [
    {
      "ref": "n1",
      "type": "Decision",
      "key": null,
      "title": "Use Postgres for the event store",
      "summary": "One line: what it means for the project.",
      "status": null,
      "why": "Why, in a line, when the day says so; else null.",
      "roles": [],
      "refs": ["M4", "M7"],
      "confidence": 0.9
    }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "type": "DECIDED_BY", "refs": ["M7"], "confidence": 0.9 }
  ],
  "supersedes": [{ "new": "n1", "old": "D-002", "refs": ["M7"] }],
  "status_changes": [{ "key": "Q-003", "status": "resolved", "refs": ["M9"] }]
}
```

**Node types**
- `Person`: someone who took part (title = their name; `roles` = roles they were called by).
- `Decision`: something the team decided.
- `Instruction`: a standing rule or instruction the team set ("all APIs are versioned under /v1").
- `Requirement`: something the product must do.
- `Question`: a question still open at the end of the day (or answered the same day: then `status: "resolved"`).
- `Risk`: a risk or blocker someone raised.
- `ActionItem`: work someone agreed to do.
- `Artifact`: a document or file that mattered.
- `Story`: a backlog story.
- `Component`: a part of the system.
- `Milestone`: a gate or release.
- `Topic`: a domain term worth a glossary line.
- `Role`: a role the team defined.

**Edge types:** `DECIDED_BY`, `RAISED_BY`, `OWNS`, `ASSIGNED_TO`, `ABOUT`, `AFFECTS`, `ANSWERS`, `BLOCKS`, `DEPENDS_ON`, `IMPLEMENTS`, `HAPPENED_ON`. `from` and `to` are a `ref` of this reply ("n1") or a key from KNOWN ITEMS ("D-003", "asha"). Put people in `nodes` as `Person` before you use them in edges.

**Statuses:** `active` (decisions, rules, requirements), `open` (questions, risks, actions, stories), `resolved`, `done`, `superseded`, `dropped`. Leave `status` null for the type's usual start.

**Rules**
- Reuse what the memory holds. If an item in KNOWN ITEMS is meant, set `key` to its key; never create it again. A reversed decision or changed rule is a new node plus a `supersedes` entry with the old key. A known question answered, action done or risk gone is a `status_changes` entry.
- Every item cites its sources in `refs` (M/E/F/P refs from the request). Never invent an item, a name or a source. If the day only hints at something, give it a low `confidence` (below 0.6): it is shown to people to confirm, not stated as fact.
- Keep only what matters to the project: decisions with who decided, rules, requirements, deadlines, open questions, risks, commitments. Leave out greetings, small talk, thanks, repeats and back-and-forth that changed nothing.
- Titles are short and specific (under 12 words); summaries are one plain line. Use people's names. Write no ids, tool names or secrets. Never say something is approved unless an event (E) records the approval.
- A quiet day with nothing worth keeping is `{"nodes": [], "edges": [], "supersedes": [], "status_changes": []}`.
