import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noteSubmitted } from "../prompt.ts";
import { at, claude, collectorSnapshot, handlers, hub, line, opencode, root, workingClaude } from "./status.fake.ts";

describe("the status hub's OpenCode subagents", () => {
  it("holds an OpenCode turn after Claude Code's on its subagent though its session is found after the turn, and calls its finish off", async () => {
    const h = hub();
    h.herdrSays(claude);
    handlers.onBaseline([claude]);
    await h.snapshot();
    handlers.onStatus("w1:p1", "working", "claude");
    handlers.onStatus("w1:p1", "idle", "claude");
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    // OpenCode's first turn there starts a subagent and ends before any snapshot
    h.herdrSays(opencode("ses_parent"));
    const from = h.alerts.length;
    handlers.onStatus("w1:p1", "working", "opencode");
    handlers.onStatus("w1:p1", "idle", "opencode");
    await h.settle();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(h.alerts.slice(from).at(-1)).toBe("working");
    // the snapshot that follows, Claude's tracker letting go of the pane, keeps it
    await h.snapshot();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
  });

  it("keeps an OpenCode turn held though a snapshot read before its session was found is answered after", async () => {
    const h = hub();
    h.herdrSays(claude);
    handlers.onBaseline([claude]);
    await h.snapshot();
    handlers.onStatus("w1:p1", "working", "claude");
    handlers.onStatus("w1:p1", "idle", "claude");
    // what herdr says as a snapshot's read begins: OpenCode's home screen
    h.herdrSays(opencode(null));
    const answer = await h.heldSnapshot();
    h.herdrSays(opencode("ses_parent"));
    handlers.onStatus("w1:p1", "working", "opencode");
    await h.settle();
    await answer();
    handlers.onStatus("w1:p1", "idle", "opencode");
    await h.settle();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
  });

  it("lets a Claude Code session that follows OpenCode's in the pane hold nothing of OpenCode's", async () => {
    const h = hub();
    h.herdrSays(opencode("ses_parent"));
    handlers.onBaseline([opencode("ses_parent")]);
    await h.snapshot();
    handlers.onStatus("w1:p1", "working", "opencode");
    handlers.onStatus("w1:p1", "idle", "opencode");
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    // a resting Claude session with a subagent running from before
    h.herdrSays(claude);
    await h.snapshot();
    handlers.onStatus("w1:p1", "idle", "claude");
    expect(h.last().bg).toBe(false);
  });
});

describe("Claude rest evidence regressions (#2072)", () => {
  it("keeps a new terminal turn working before the next transcript entry", async () => {
    // Given a completed turn whose child still streams.
    const h = await workingClaude();
    h.rest(); h.poll();
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    // When herdr reports a new turn before Claude flushes its user record.
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    h.poll();
    // Then the queue cannot deliver during that turn.
    h.pending.enqueue("owner", h.pane.pane_id, 1, "queued", null, { agent: "claude", terminalId: "test", session: h.pane.agent_session.value });
    expect(h.last()).toEqual({ status: "working", tasks: 1, bg: false });
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("keeps working when the next user record is incomplete", async () => {
    const h = await workingClaude();
    h.rest();
    appendFileSync(h.path, '{"type":"user","message":{"content":"next');
    // When a poll reaches EOF without parsing every byte.
    h.poll();
    // Then the earlier rest cannot certify readiness.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
  });

  it("announces a rest first discovered by a snapshot", async () => {
    const h = await workingClaude();
    h.rest();
    // When a snapshot discovers the turn end before the timer.
    const snapshot = await h.snapshot();
    // Then events, pending delivery and the returned snapshot agree immediately.
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(snapshot.panes[0]).toMatchObject({ agent_status: "done", background_tasks: 1, background_wait: true });
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
    expect(h.alerts.at(-1)).toBe("working");
  });

  it("keeps Codex working when the previous Claude transcript ends", async () => {
    const h = await workingClaude();
    handlers.onStatus(h.pane.pane_id, "working", "codex");
    h.rest();
    // When the old tracker polls before the next roster refresh.
    h.poll();
    // Then no Claude finish replaces Codex's work.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
    expect(h.alerts.at(-1)).toBe("working");
  });

  it("keeps working when an oversized next user record is skipped", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    appendFileSync(h.path, line({ type: "user", message: { role: "user", content: "x".repeat(9 * 1024 * 1024) } }));
    // When the reader skips a complete record beyond its line budget.
    h.poll();
    // Then a skipped prompt cannot leave the previous rest in force.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
  });

  it("retains raw working evidence across collector snapshot replay", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    const snapshot = await collectorSnapshot();
    const pane = snapshot.panes[0];
    if (pane === undefined) throw new Error("Missing fixture pane");
    handlers.onStatus(pane.pane_id, pane.agent_status, "claude", { before: "working", agent: "claude" });
    h.next();
    // When the transcript catches up to the next turn after a collector replay.
    h.poll();
    // Then raw working is still available to restore work.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
  });

  it("announces a child ending when a snapshot reads it first", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    appendFileSync(h.child, line({ type: "assistant", isSidechain: true, timestamp: new Date(at + 500).toISOString(), message: { role: "assistant", stop_reason: "end_turn", content: [] } }));
    // When the snapshot discovers the child end instead of the timer (omo M1).
    const snapshot = await h.snapshot();
    // Then the old BG frame is replaced and alerts use the current status.
    expect(h.last()).toEqual({ status: "working", tasks: 0, bg: false });
    expect(snapshot.panes[0]).toMatchObject({ agent_status: "working" });
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
    expect(h.alerts.at(-1)).toBe("working");
  });

  it("invalidates old rest when a chat send succeeds before transcript logging", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // When the existing immediate/queued input seam confirms submission.
    noteSubmitted(h.pane.pane_id, "next");
    const snapshot = await h.snapshot();
    // Then a stale transcript cannot make the submitted turn ready.
    expect(h.last()).toEqual({ status: "working", tasks: 1, bg: false });
    expect(snapshot.panes[0]).toMatchObject({ agent_status: "working" });
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
  });
});

describe("Claude turn starts the transcript does not show yet (#2072)", () => {
  const queue = (h: Awaited<ReturnType<typeof workingClaude>>) =>
    h.pending.enqueue("owner", h.pane.pane_id, 1, "queued", null, { agent: "claude", terminalId: "test", session: h.pane.agent_session.value });
  const turnEnds = (h: Awaited<ReturnType<typeof workingClaude>>) =>
    appendFileSync(h.path, line({ type: "system", subtype: "turn_duration", timestamp: new Date(at + 6000).toISOString() }));

  it("closes the queue for a next turn herdr tells while the subagents' spinner never left working", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    expect(h.last().status).toBe("done");
    // When herdr says working again, with no idle between, before Claude writes the next prompt.
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    h.poll();
    queue(h);
    const snapshot = await h.snapshot();
    // Then the rest the transcript holds is the turn before's.
    expect(h.last().status).toBe("working");
    expect(snapshot.panes[0]?.agent_status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
    // And the turn's own rest, once written, ends it.
    h.next(); turnEnds(h); h.poll();
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
  });

  it("reaches rest when herdr's working event comes after the turn it tells has ended", async () => {
    const h = await workingClaude();
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    // Given a whole next turn written before herdr's event for it arrives.
    h.next(); turnEnds(h);
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    queue(h);
    h.poll();
    // Then that turn's rest is its own.
    expect(h.last().status).toBe("done");
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
    expect(h.pending.next(h.pane.pane_id)).not.toBeNull();
  });

  it("reaches rest when a chat send returns after the turn it started has ended", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    h.next(); turnEnds(h);
    noteSubmitted(h.pane.pane_id, "short question");
    h.poll();
    expect(h.last().status).toBe("done");
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
  });

  it("keeps the rest through a slash command the chat sent, which may run no turn", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    noteSubmitted(h.pane.pane_id, "/model sonnet");
    h.poll();
    const snapshot = await h.snapshot();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(snapshot.panes[0]?.agent_status).toBe("done");
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
  });

  it("leaves a pane herdr reads idle idle when the chat sends it a prompt", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    const alerts = h.alerts.length;
    // When a send returns before herdr or the transcript tells of any turn.
    noteSubmitted(h.pane.pane_id, "hello");
    queue(h);
    // Then the status stays herdr's: nothing ends a working the server made up.
    expect(h.last().status).toBe("done");
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
    expect(h.pending.next(h.pane.pane_id)).not.toBeNull();
    expect(h.alerts.slice(alerts)).not.toContain("working");
  });

  it("keeps working when herdr's working event came before the transcript was first found", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const path = join(root, `${id}.jsonl`);
    const dir = join(root, id, "subagents");
    mkdirSync(dir, { recursive: true });
    // Given a transcript whose last turn ended long ago, with a subagent still at work.
    writeFileSync(path, line({ type: "user", timestamp: new Date(at - 1000).toISOString(), message: { role: "user", content: "old" } })
      + line({ type: "system", subtype: "turn_duration", timestamp: new Date(at + 300).toISOString() }));
    writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", toolUseId: "toolu_a1", requestShape: "background" }));
    writeFileSync(join(dir, "agent-a1.jsonl"), line({ type: "user", isSidechain: true, agentId: "a1", sessionId: id, timestamp: new Date(at).toISOString(), message: { role: "user", content: "review" } }));
    const pane = { ...claude, agent_status: "working", agent_session: { ...claude.agent_session, value: id } };
    const h = hub(path);
    h.herdrSays(pane);
    // When herdr's working event comes before the pane's transcript is looked up.
    handlers.onStatus(pane.pane_id, "working", "claude");
    await h.snapshot();
    h.poll();
    h.pending.enqueue("owner", pane.pane_id, 1, "queued", null, { agent: "claude", terminalId: "test", session: id });
    // Then the old rest ends no turn begun since.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(pane.pane_id)).toBe("working");
    expect(h.pending.next(pane.pane_id)).toBeNull();
  });
});

describe("the status hub's Claude turn at rest under its background subagent", () => {
  // the session's turn starts a background subagent, which works on after the turn ends
  const RESTING = "22222222-2222-4222-8222-222222222222";
  const path = join(root, `${RESTING}.jsonl`);
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const ts = (ms: number) => new Date(at + ms).toISOString();
  mkdirSync(join(root, RESTING, "subagents"), { recursive: true });
  writeFileSync(path, line({ type: "user", origin: { kind: "human" }, timestamp: ts(-1000), permissionMode: "default", message: { role: "user", content: "go" } }));
  writeFileSync(join(root, RESTING, "subagents", "agent-b1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "essays", toolUseId: "toolu_b1", requestShape: "background" }));
  writeFileSync(join(root, RESTING, "subagents", "agent-b1.jsonl"), line({ isSidechain: true, sessionId: RESTING, agentId: "b1", type: "user", timestamp: ts(0), message: { role: "user", content: "write" } }));
  const pane = { ...claude, agent_session: { ...claude.agent_session, value: RESTING } };

  it("takes herdr's working for a rest held on the subagent, and herdr's word again once a next turn starts (#2069)", async () => {
    const h = hub(path);
    h.herdrSays(pane);
    handlers.onBaseline([pane]);
    await h.snapshot();
    h.herdrSays({ ...pane, agent_status: "working" });
    handlers.onStatus("w1:p1", "working", "claude");
    expect(h.last().status).toBe("working");
    // the turn ends (its `turn_duration` entry), and Claude's busy title stays up while the subagent streams: herdr says nothing new
    appendFileSync(path, line({ type: "assistant", isSidechain: false, timestamp: ts(200), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] } })
      + line({ type: "system", subtype: "turn_duration", isSidechain: false, timestamp: ts(300), pendingBackgroundAgentCount: 1 }));
    h.poll();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(h.alerts.at(-1)).toBe("working");
    // a snapshot read meanwhile says the same
    await h.snapshot();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    // the person prompts again while the subagent works: the session is at work, as herdr has said all along
    appendFileSync(path, line({ type: "user", origin: { kind: "human" }, timestamp: ts(5000), permissionMode: "default", message: { role: "user", content: "next" } }));
    h.poll();
    expect(h.last().status).toBe("working");
  });
});
