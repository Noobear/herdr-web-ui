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
