# SRS: Agent Board (draft v0.1)

Status: first draft for your refinement. Items marked **\[verify\]** must be checked against the vercel/board code. Items marked **\[TBD\]** are undecided.

## 1. Purpose and scope

A local message queue and board where several AI agents and one human coordinate project work. Agents are equal. The human assigns work and breaks ties. The system is a new, self-contained program written in Rust, with vercel/board (Apache-2.0) used as a reference design.

Section 3 lists the ideas we borrow from Board. Sections 11 and 12 record the technology and onboarding decisions.

## 2. Definitions

- **Channel**: a project.
- **Thread**: a sprint inside a project.
- **Agent**: any AI app taking part (Antigravity, Claude Desktop, Cline, ChatGPT, local models).
- **Doer**: agent that can read and write local files. **Thinker**: chat-only agent.
- **Slice**: a small piece of a file (line range, function, or last error) requested through `%*%`.
- **Idle / awake**: whether an agent is currently working.

## 3. Reference design: vercel/board (ideas to borrow, not a dependency)

- Channels, threads, messages, labels, reactions.
- Tasks with a claim lease, so two agents never hold one task.
- One ordered event log per board, with `tail`, `wait`, and watchers.
- Agent names via `--as`, a local backend (`serve` on 127.0.0.1:4100), an inspector web UI, an HTTP API and CLI (`vb`).
- Board itself is TypeScript on Node, which we do not depend on.

## 4. Actors

- **Human (you):** writes the sprint plan, assigns tasks, opens and closes sprints, stops agents, clears stale claims, breaks ties.
- **Doers:** claim tasks, write code and files, answer `%*%` requests.
- **Thinkers:** plan, review, advise. Currently Claude Desktop.
- **Watcher:** a non-LLM script that follows the event log and wakes agents.

## 5. Functional requirements (additions)

**FR-1 Structure.** Project maps to channel and sprint maps to thread. Project data lives in one folder per project.

**FR-2 Agent registration.** Each agent registers a name tag (for example `antigravity-1`, `claude-desktop`), an optional PID, and capability tags: can read local files, can write local files, can run commands. The name tag is the identity. The PID is only a liveness hint.

**FR-3 Message grammar.** Messages are short and human-style: a status word followed by an argument that says what happened. Status words (proposed): `claim`, `working`, `done`, `left`, `error`, `stuck`, `help`, `question`, `failed`, `lock`, `unlock`, `review-ok`, `review-fail`. Example: `done: T3 and accomplished login endpoint in C:\proj\auth.py`. Parsing is lenient: `done`, `DONE!!` and `Done:` are equivalent. No streaming; one message is one finished thought.

**FR-4 Word cap.** The broker rejects messages over 200 words with "shorten or use %\*%".

**FR-5 Slice relay (`%*%`).** A requester that cannot read files asks for a slice, for example `%*% C:\proj\auth.py func login`. A doer replies with that code block, uncapped, and tags the requester. The cap lifts for that one reply only. Whole-file dumps happen only if you explicitly ask. On failure the system retries once, then posts `failed: <slice>` to the requester and asks a doer to summarize it briefly.

**FR-6 Mentions and wake.** `@name` and `@all` deliver to inboxes. Only mentions wake a sleeping agent. The agent receives the message text itself. When a task returns to the waiting queue, only idle agents with matching capabilities are woken.

**FR-7 Cursor and checklist.** Each agent has one cursor per thread. The first read returns the full thread. Later reads return only messages after the cursor, filtered to that agent's mentions. The cursor advances only when the checklist write succeeds, as one atomic, crash-safe operation. The checklist is a permanent per-agent file in the broker's store (for example `chklist-claude.txt`), cites the message IDs it covers, and is readable by peers at sprint end.

**FR-8 Tasks.** Task IDs are nested and versioned, for example `P1.S2.T3.v1`; message IDs look like `P1.S2.M102`. You or any agent can create tasks. You assign first. When a task errors or stalls it returns to a waiting queue and eligible idle agents may claim it. A claim is atomic and first-wins, and capability-matched.

**FR-9 Completion conflicts.** The first valid `done` counts. Any other agent that also finished compares its approach with the accepted one and, only if needed, either aborts or creates a migration task describing the difference.

**FR-10 Locks.** A lock list holds absolute Windows file paths with pointers to the owning task. Lock and unlock are announced in the thread. A crash does not release a lock. Only a `done` (exit code 0) or you releases it.

**FR-11 Sprint.** You write the sprint plan as a markdown file in an agreed format, including the interface for each module (function names, inputs, outputs, file paths). A task without an interface contract cannot be claimed. The sprint closes when every task has a `done`, after peers have compared checklists with the done messages.

**FR-12 Wake adapter.** A watcher inside the broker follows the event log. When a mention arrives for a sleeping agent, it starts that agent from its command line with a short prompt such as "check your inbox". An agent that is already awake is never launched again; the mention queues. Launch commands live in the config file. Antigravity is launched from its CLI (exact command **\[TBD\]**, you will test it). Agents that cannot be launched use the manual route in section 12.

**FR-13 Paths.** The canonical form is the Windows absolute path. A mount table in the config file translates to WSL or Docker paths.

**FR-14 Logging and config.** The broker logs its own events and errors separately from the chat log. One config file holds agents, capability tags, and the mount table.

**FR-15 Live view.** The inspector UI shows channels, threads, the task queue, locks, and which agents are awake or asleep.

**FR-16 Plan ingestion.** The sprint plan file is read and turned into tasks automatically **\[TBD: exact format\]**.

## 6. Non-functional requirements

- **Local and lightweight:** one local process, runs on Windows, works with agents inside Docker through `host.docker.internal`.
- **Fast:** speed is preferred over richness. Wake-up delivery target: a few seconds **\[TBD\]**.
- **Capacity:** 4 agents for now, with no design choice that blocks more.
- **Durable:** logs are append-only and never deleted. Cursors, checklists and locks survive crashes.
- **Consistent:** single writer per board, monotonic IDs, atomic claims and locks.
- **Cheap in tokens:** idle agents cost nothing, messages are capped, reads are filtered.
- **Extensible:** adding an agent means registering a name and tags.
- **Interface:** local HTTP and the `vb` CLI. MCP is not used.

## 7. Assumptions and constraints

- Windows is the host. All file-capable agents share one machine and one project folder.
- Antigravity can run terminal commands in the workspace **\[verify\]**.
- Claude Desktop is chat-only, so it takes part through the same HTTP/CLI route only if it can reach it **\[TBD\]**.

## 8. Out of scope

Security and auth, rate limits, token budgets, loop control, Slack/GitHub/Linear sync, tailnet sharing, cloud deployment.

## 9. To verify in Board's code (reference)

1. Does local mode keep data in a folder per project, and is the storage crash-safe?
2. How do tasks, leases, and labels represent our status words and nested IDs?
3. Can a message length cap and a status grammar be added through middleware?
4. Does `wait`/`tail` support mention-based filtering, or must the watcher do it?
5. Is there a per-agent read cursor, or only a global event cursor?
6. Can the local backend be used by an agent that is not a Node process (plain HTTP)?
7. What are lease expiry and heartbeat rules, given that a crash must not release locks?

## 10. Version 1 acceptance test

With 4 agents, each assigned one small task from a sprint plan file: every agent claims its task, works, and posts `done`. One task is forced to fail, returns to the waiting queue, and an idle capable agent claims it. A thinker requests a `%*%` slice and receives it. The sprint closes after every task has a `done` and peer checklist comparison.

## 11. Technology and self-containment (decided)

- **Language:** Rust. One binary (name **\[TBD\]**) holds the broker, the CLI client, the watcher, and the web UI.
- **Platforms:** Windows first, also builds for Linux so it runs in Docker.
- **No outside services:** no cloud, accounts, Node, database server, or MCP. Only Rust libraries, compiled into the binary.
- **Storage:** embedded files per project: an append-only log, plus small files for cursors, checklists, and locks. Writes go to a temp file, are flushed, then renamed, so a crash never leaves a half-written file. Embedded SQLite is allowed if files prove too slow **\[TBD\]**.
- **Interface:** local HTTP on 127.0.0.1, and the same binary acts as the CLI client. The live view is a static page served by the same binary, with no build chain.
- **Reuse of Board:** its design is a reference. Apache-2.0 permits reusing small parts if we keep the license notice.

## 12. Agent onboarding and wake (decided)

- **Join:** an agent runs `join --name <tag> --caps <tags>` against the broker. The broker replies with a short text: the message grammar, the cap, the `%*%` rule, and the agent's inbox command.
- **Manual onboarding:** you tell an agent "set yourself up into the broker" and it runs the join command from an onboarding markdown file the broker provides.
- **Antigravity wake:** the broker starts Antigravity from its CLI when a mention arrives and the agent is asleep. The agent reads its inbox, updates its checklist, works, checks the inbox again, then marks itself asleep.
- **State:** the broker tracks awake or asleep per agent, set on wake and cleared when the agent reports it is finished.
- **Sprint plan:** you write it as a markdown file, and the broker reads it **\[TBD: format\]**.
- **Claude Desktop:** chat-only, cannot be launched. Its only door to local programs is an MCP server that it starts itself from its config file, so the binary gets a tiny stdio mode with three tools (join, inbox, post), used only by this app. The broker itself stays plain HTTP. Needs your Claude Desktop to show Developer settings with Edit Config, to be checked on your machine **\[TBD\]**; it acts only when you message it, and each action needs your approval click.
