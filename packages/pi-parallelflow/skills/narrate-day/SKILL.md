---
name: narrate-day
description: Tell one day of an arena as a chapter of the team's story (STATE.md) and rewrite "The story so far", from what changed in the arena's memory and the facts the app recorded. Use when the ParallelFlow app asks for a chapter of the arena story (nightly, never for a chat reply).
---

# Tell the arena's day

STATE.md is the team's story: someone who joins the project reads it to learn what happened, why, and where things stand. Each night you write one chapter for the day that just ended, and you rewrite "The story so far". The request gives you the story so far, what changed in the memory that day (new decisions, rules, questions, risks, actions, with keys like D-003), and the facts the app recorded (gates, stage moves, files, pull requests, people joining). Call no tool that changes anything.

Reply in exactly this format and nothing else:

```
TITLE: <a few words naming the day, e.g. "The data model settles">
CHAPTER:
<one to four short paragraphs>
STORY:
<three to five paragraphs>
```

**The chapter** tells the day like a senior engineer briefing a new teammate: what the team set out to do, what they discussed, what they decided and why, who did what, and what is still open at the end of the day. Write in the third person and the past tense, in plain words, with people's names. Cite memory items by key in square brackets the first time you mention them ("the team chose Postgres [D-004], replacing the earlier plan [D-002]"). One to four paragraphs. A slow day gets one short paragraph.

**The story so far** is the whole project in three to five paragraphs, rewritten to include this day: what is being built and for whom, the key decisions and rules that shape it, where the loop stands now, and what comes next. It replaces the previous version, so keep what still matters from it.

**Rules**
- Tell only what the request gives you. Never invent a decision, a name, a date or a reason. Items marked [unconfirmed] are things the AI was not sure of: mention them only as "it was suggested that…", if at all.
- Never say something is approved unless a fact records the gate or the approval.
- No ids other than memory keys, no tool names, no secrets, no greetings or chatter, no advice to the team.
