import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneSendKeys, paneSendText } from "./herdr/client.ts";

/**
 * herdr's terminal stream draws a screen whole once and then only the cells that change. A tab
 * joining a busy pane late (a phone coming back to a pane a desktop tab holds) used to get only
 * the replay's bounded tail, and every row nothing had rewritten since (the prompt and the
 * status line under an agent's spinner) stayed blank for good.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-late-joiner-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const socket of sockets) socket.close();
  server.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace }).catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(20);
  }
}

function client(paneId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  sockets.push(ws);
  const state = { bytes: 0, text: "" };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "pty-data" && frame.pane_id === paneId) {
      state.bytes += Buffer.byteLength(frame.data);
      state.text += frame.data;
    }
  });
  const attach = async () => {
    await until(() => ws.readyState === WebSocket.OPEN, "socket open");
    ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 80, rows: 24 }));
  };
  return { state, attach };
}

// a footer drawn once, then ten rows rewritten as fast as the pane takes them
const BUSY = `
process.stdout.write("\\x1b[?1049h\\x1b[2J\\x1b[20;1H>_FOOTER_PROMPT\\x1b[22;1H__STATUS_FOOTER");
const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
setInterval(() => {
  let out = "";
  for (let row = 5; row < 15; row++) {
    out += "\\x1b[" + row + ";1H";
    for (let i = 0; i < 60; i++) out += letters[Math.floor(Math.random() * letters.length)];
  }
  process.stdout.write(out);
}, 10);
setTimeout(() => process.exit(0), 120_000);
`;

describe("a late joiner of a busy pane", () => {
  it("is drawn the rows nothing rewrote since the replay lost its start", async () => {
    const script = join(root, "busy.js");
    writeFileSync(script, BUSY);
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "herdr-web-ui-test-late-joiner", cwd: root, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;
    const first = client(paneId);
    await first.attach();
    await until(() => first.state.bytes > 0, "the first tab's output");
    await paneSendText(paneId, `'${process.execPath}' '${script}'`);
    await paneSendKeys(paneId, ["Enter"]);
    await until(() => first.state.text.includes("FOOTER_PROMPT"), "the footer");
    // well past the 256 KiB replay: its first whole frame is gone
    await until(() => first.state.bytes > 400 * 1024, "400 KiB of output", 90_000);
    const late = client(paneId);
    await late.attach();
    await until(() => late.state.text.includes("FOOTER_PROMPT") && late.state.text.includes("STATUS_FOOTER"), "the late tab's footer", 10_000);
    expect(late.state.text).toContain("STATUS_FOOTER");
  }, 150_000);
});
