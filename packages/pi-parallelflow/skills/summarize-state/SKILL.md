---
name: summarize-state
description: Write the arena's STATE.md day section (summary, decisions, what was discussed, open questions) from the conversation and the facts given. Use when the ParallelFlow app asks for the state of the arena or a day summary.
---

# Summarize the arena's state

You are writing one day's section of `STATE.md`, the team's memory. The request gives you the facts of the window (counts, stage moves, gates, versions) and the day's section so far, if any. Your own conversation holds only what people asked you, so first read the window's messages with `arena_read_history` (most of the team's talk is there), then use `artifacts_list` / `artifacts_read` for documents the facts name. Call no tool that changes anything.

Follow the exact output format the request asks for. When it gives none, answer with exactly these parts and nothing before or after them:

Summary: two to four sentences on where the arena stands and what moved today.

**Decisions**

- One bullet per decision: what was decided, and by whom ("Asha decided …"). "None" if there were none.

Discussed

- One bullet per topic the team talked about, in a few words each.

Open questions

- One bullet per question still unanswered, with who asked it. "None" if there are none.

What goes in: only what matters to the project. Decisions (highlighted, with who decided), timelines and deadlines agreed, and how open topics landed. What stays out: chat noise, such as greetings, small talk, thanks, repeated questions, back-and-forth that changed nothing, and anything already settled earlier with no change.

Rules: merge with the day's section so far (keep its decisions, update the rest); people and documents by name; dates in plain words; no ids, tool names, greetings, chatter or advice; never say something is approved unless a gate approval is in the facts.
