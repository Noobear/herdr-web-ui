import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneSendKeys, paneSendText } from "./herdr/client.ts";

/**
 * A model list's search box types into the list's own filter line: POST /api/pane/prompt/filter
 * replaces what the line holds and answers the list as it then shows, and refuses (409) once no
 * model list is on screen, where the keys would land in the agent's prompt. The pane runs a small
 * program that draws OmO's /model the way OmO 5.1.30 does and filters as keys arrive.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-prompt-filter-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
const base = `http://127.0.0.1:${server.port}`;
const workspaces: string[] = [];
afterAll(async () => {
  server.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace }).catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

const LIST = `
const models = ["claude-opus-4-8 [anthropic]", "claude-fable-5 [anthropic]", "gpt-5.5 [chatgpt-subscription]", "gpt-6-sol [chatgpt-subscription]", "gpt-6-astra [chatgpt-subscription]"];
let filter = "";
let open = true;
const draw = () => {
  let out = "\\x1b[2J\\x1b[H";
  if (open) {
    const rows = models.filter((model) => model.includes(filter));
    out += "Only showing models from configured providers. Use /login to add providers.\\r\\n";
    out += "enter select  ctrl+s select as default  ctrl+f favorite\\r\\n";
    out += "> " + filter + "\\r\\n";
    out += rows.length ? rows.map((row, index) => (index === 0 ? "→   " : "    ") + row + (row.startsWith("claude-opus-4-8") ? " ✓" : "")).join("\\r\\n") + "\\r\\n" : "  No matching models\\r\\n";
    out += "  Model catalogs refreshed.\\r\\n";
  } else {
    out += "prompt closed\\r\\n";
  }
  out += "${"─".repeat(40)}\\r\\n/tmp/app • 0/1M (0.0%) (auto)  (anthropic) claude-opus-4-8 • effort medium\\r\\n";
  process.stdout.write(out);
};
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  for (const ch of data.toString("utf8")) {
    if (ch === "\\x7f" || ch === "\\b") filter = filter.slice(0, -1);
    else if (ch === "\\x1b") open = false;
    else if (!open && ch === "r") { open = true; filter = ""; models.reverse(); }
    else if (ch >= " ") filter += ch;
  }
  draw();
});
draw();
setTimeout(() => process.exit(0), 120_000);
`;

type Card = { id: string; question: string; options: { label: string }[]; filter?: { text: string } } | null;
const card = async (pane: string): Promise<Card> => (await (await fetch(`${base}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json() as { prompt: Card }).prompt;
const search = (pane: string, promptId: string, text: string) => fetch(`${base}/api/pane/prompt/filter`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: pane, prompt_id: promptId, text }),
});

async function until<T>(read: () => Promise<T | null>, label: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(100);
  }
}

describe("a model list's search box", () => {
  it("types a search into the list's filter line and answers the list it leaves", async () => {
    const script = join(root, "list.js");
    writeFileSync(script, LIST);
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "herdr-web-ui-test-prompt-filter", cwd: root, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    const pane = created.root_pane.pane_id;
    await paneSendText(pane, `'${process.execPath}' '${script}'`);
    await paneSendKeys(pane, ["Enter"]);
    const first = await until(async () => { const shown = await card(pane); return shown?.filter ? shown : null; }, "the list's card");
    expect(first.filter).toEqual({ text: "" });
    expect(first.options.length).toBe(5);

    const gpt = await (await search(pane, first.id, "gpt")).json() as { prompt: Card };
    expect(gpt.prompt?.filter).toEqual({ text: "gpt" });
    expect(gpt.prompt?.options.map((option) => option.label)).toEqual(["gpt-5.5 [chatgpt-subscription]", "gpt-6-sol [chatgpt-subscription]", "gpt-6-astra [chatgpt-subscription]"]);
    // a card typing ahead of the last answer still sends the id it started from, which still counts
    const ahead = await (await search(pane, first.id, " gpt-6 ")).json() as { prompt: Card };
    expect(ahead.prompt?.filter).toEqual({ text: "gpt-6" });

    // a different word replaces the old one: only what differs is erased and typed
    const astra = await (await search(pane, gpt.prompt!.id, "gpt-6-a")).json() as { prompt: Card };
    expect(astra.prompt?.options.map((option) => option.label)).toEqual(["gpt-6-astra [chatgpt-subscription]"]);
    const none = await (await search(pane, astra.prompt!.id, "zzz")).json() as { prompt: Card };
    expect(none.prompt?.options).toEqual([]);
    expect(none.prompt?.question).toBe('No model matches "zzz"');
    const back = await (await search(pane, none.prompt!.id, "")).json() as { prompt: Card };
    expect(back.prompt?.options.length).toBe(5);

    // a list opened since is not the one the card searched: a request it queued types nothing there
    await paneSendKeys(pane, ["esc"]);
    await until(async () => (await card(pane)) === null ? true : null, "the list closed");
    await paneSendText(pane, "r");
    const reopened = await until(async () => { const shown = await card(pane); return shown?.filter ? shown : null; }, "the list again");
    expect(reopened.id).not.toBe(back.prompt!.id);
    expect((await search(pane, back.prompt!.id, "gpt")).status).toBe(409);
    expect((await card(pane))?.filter).toEqual({ text: "" });

    // the list gone, no key goes out: the search is refused
    await paneSendKeys(pane, ["esc"]);
    await until(async () => (await card(pane)) === null ? true : null, "the list closed");
    const refused = await search(pane, back.prompt!.id, "gpt");
    expect(refused.status).toBe(409);

    const bad = await search(pane, back.prompt!.id, "a\u0003b");
    expect(bad.status).toBe(400);
  }, 60_000);
});
