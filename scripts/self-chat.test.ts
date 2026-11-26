import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The note-to-self setup, end to end: the linked device IS the owner's own
// number, so everything the owner types in "Message yourself" reaches this
// server as fromMe. Spawns the real server.ts with Baileys' socket swapped for
// a fake one (a preload replaces the module, the way cloud-server.test.ts
// replaces Graph), so the whole inbound path runs: messages.upsert, the fromMe
// branch, gate, media download, the whisper script, the message log and the
// MCP notification Claude would see.

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await pause(25);
  expect(check()).toBe(true);
}

const OWN_PHONE = "15550001111@s.whatsapp.net";
// The self-chat arrives under the owner's own @lid on a current account.
const OWN_LID = "99990001111@lid";
const CONTACT = "15550002222@s.whatsapp.net";

const BAILEYS = require.resolve("@whiskeysockets/baileys");

// The fake socket. Every send is appended to fake-sent.jsonl and its echo is
// emitted the way Baileys schedules it (Socket/messages-send.js): an "append"
// upsert of the full message queued on process.nextTick once the awaited
// relay is done. Under Bun that tick runs BEFORE the caller's
// `await sendMessage` continuation (Node runs it after), so this is the
// earliest the real echo can arrive; Baileys' own mutex and event buffer only
// ever push it later. A fake that emitted later would let an echo whose id
// was recorded only after the send pass by luck.
const PRELOAD = `
import { plugin } from "bun";
import { appendFileSync } from "node:fs";
const real = await import(${JSON.stringify(BAILEYS)});
const SENT = process.env.FAKE_WA_SENT;
let current;
let n = 0;
function makeFakeSocket() {
  const listeners = new Map();
  const ev = {
    on(name, fn) { (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn); },
    off(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn)); },
    removeAllListeners(name) { listeners.delete(name); },
    emit(name, data) { for (const fn of listeners.get(name) ?? []) fn(data); },
  };
  const target = {
    ev,
    user: { id: "15550001111:12@s.whatsapp.net", lid: "99990001111:12@lid", name: "Owner" },
    ws: { on() {}, off() {}, close() {} },
    resyncAppState: undefined,
    async sendMessage(jid, content, options = {}) {
      const id = options?.messageId ?? "FAKESENT" + ++n;
      const message = "text" in content
        ? { conversation: content.text }
        : "react" in content
          ? { reactionMessage: { key: content.react.key, text: content.react.text } }
          : { documentMessage: { fileName: "file" } };
      const full = { key: { remoteJid: jid, fromMe: true, id }, message, messageTimestamp: Math.floor(Date.now() / 1000) };
      // The relay (a socket write, so a macrotask) is awaited before the echo
      // is scheduled, as in Baileys.
      await new Promise((r) => setTimeout(r, 1));
      appendFileSync(SENT, JSON.stringify({ jid, id, content: "text" in content ? { text: content.text } : "react" in content ? { react: content.react.text } : { other: true } }) + "\\n");
      process.nextTick(() => ev.emit("messages.upsert", { messages: [full], type: "append" }));
      return full;
    },
    async sendPresenceUpdate() {},
    async readMessages() {},
    async groupFetchAllParticipating() { return {}; },
    async updateMediaMessage(m) { return m; },
    end() {},
  };
  current = new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === "then") return undefined;
      return async () => undefined;
    },
  });
  return current;
}
plugin({
  name: "fake-baileys",
  setup(build) {
    build.module("@whiskeysockets/baileys", () => ({
      loader: "object",
      exports: {
        ...real,
        default: makeFakeSocket,
        makeWASocket: makeFakeSocket,
        fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
        // The "media" is the url field's text, so the fake whisper script can
        // decide per message whether to succeed.
        downloadMediaMessage: async (msg) => {
          const c = msg.message ?? {};
          const part = c.audioMessage ?? c.imageMessage ?? c.documentMessage ?? {};
          return Buffer.from(String(part.url ?? "media"));
        },
      },
    }));
  },
});
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.FAKE_WA_PORT),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ready") return new Response(current ? "yes" : "no");
    const body = await req.json();
    if (url.pathname === "/open") current.ev.emit("connection.update", { connection: "open" });
    if (url.pathname === "/upsert") current.ev.emit("messages.upsert", body);
    return new Response("ok");
  },
});
`;

// Stands in for ~/whisper-transcribe.sh. The audio file holds the fake
// download's bytes: anything containing FAIL exits non-zero, the rest is
// "transcribed" by echoing it back.
const WHISPER = `#!/bin/sh
body=$(cat "$1")
case "$body" in *FAIL*) echo "model crashed" >&2; exit 1 ;; esac
echo "heard: $body"
`;

let dir = "";
let sentLog = "";
let port = 0;
let child: ReturnType<typeof spawn>;
let stderr = "";
const replies = new Map<number, any>();
const notifications: any[] = [];
let nextCall = 10;

function send(value: unknown) {
  child.stdin!.write(JSON.stringify(value) + "\n");
}
async function tool(name: string, args: unknown = {}): Promise<any> {
  const id = ++nextCall;
  send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  await until(() => replies.has(id));
  return replies.get(id).result;
}
const toolText = (result: any): string =>
  result.content.map((item: any) => item.text ?? "").join("\n");
async function control(path: string, body: unknown = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.text();
}
const now = () => Math.floor(Date.now() / 1000);
async function upsert(message: Record<string, unknown>, type = "notify") {
  await control("/upsert", {
    type,
    messages: [{ messageTimestamp: now(), pushName: "Owner", ...message }],
  });
}
const loggedLines = (): any[] => {
  const path = join(dir, "messages.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
};
const sends = (): any[] =>
  existsSync(sentLog)
    ? readFileSync(sentLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const channelNotes = () =>
  notifications.filter((n) => n.method === "notifications/claude/channel");
const noteFor = (id: string) =>
  channelNotes().find((n) => n.params?.meta?.message_id === id);
// Settles anything in flight (the whisper script, the echo of a send) before
// a test asserts that something did NOT happen.
const settle = () => pause(700);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wa-self-chat-"));
  sentLog = join(dir, "fake-sent.jsonl");
  const preload = join(dir, "fake-baileys.ts");
  writeFileSync(preload, PRELOAD);
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(home, "whisper-transcribe.sh"), WHISPER);
  chmodSync(join(home, "whisper-transcribe.sh"), 0o755);
  writeFileSync(
    join(dir, "access.json"),
    JSON.stringify({
      dmPolicy: "allowlist",
      // The note-to-self setup: permission requests go to the owner's own
      // chat. Without this, ownerStamp keeps the first allowlisted contact.
      allowFrom: [CONTACT, OWN_PHONE],
      owner: OWN_PHONE,
      groups: {},
      pending: {},
    }),
  );
  const reserve = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("x"),
  });
  port = reserve.port;
  reserve.stop(true);
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("WHATSAPP_") || key.endsWith("TRANSCRIPTION_PROVIDER"))
      delete env[key];
  child = spawn(
    "bun",
    ["--preload", preload, join(import.meta.dir, "..", "server.ts")],
    {
      env: {
        ...env,
        HOME: home,
        WHATSAPP_STATE_DIR: dir,
        WHATSAPP_TRANSCRIPTION_PROVIDER: "local",
        WHATSAPP_QUIET: "1",
        FAKE_WA_PORT: String(port),
        FAKE_WA_SENT: sentLog,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stderr!.on("data", (data) => {
    stderr += data;
  });
  let partial = "";
  child.stdout!.on("data", (data) => {
    partial += data.toString();
    const lines = partial.split("\n");
    partial = lines.pop()!;
    for (const line of lines) {
      const value = JSON.parse(line);
      if (typeof value.id === "number") replies.set(value.id, value);
      else notifications.push(value);
    }
  });
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "self-chat-fixture", version: "1" },
    },
  });
  await until(() => replies.has(1));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await until(() => stderr.includes("whatsapp channel: starting"));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await control("/ready")) === "yes") break;
    } catch {}
    await pause(50);
  }
  await control("/open");
  await until(() => stderr.includes("permission requests go to"));
}, 30000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      pause(3000),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("owner commands Claude from their own note-to-self chat", () => {
  test("typed text reaches Claude, the log and unreplied", async () => {
    await upsert({
      key: { remoteJid: OWN_LID, fromMe: true, id: "SELF-TEXT-1" },
      message: { conversation: "what is on my calendar today?" },
    });
    await until(() => !!noteFor("SELF-TEXT-1"));
    const note = noteFor("SELF-TEXT-1");
    expect(note.params.content).toBe("what is on my calendar today?");
    expect(note.params.meta.chat_id).toBe(OWN_LID);
    const line = loggedLines().find((l) => l.id === "SELF-TEXT-1");
    expect(line).toMatchObject({ direction: "in", replied: false });
    expect(toolText(await tool("unreplied"))).toContain(
      "what is on my calendar today?",
    );
  }, 20000);

  test("a voice note is transcribed by the whisper script and delivered as text", async () => {
    await upsert({
      key: { remoteJid: OWN_LID, fromMe: true, id: "SELF-VOICE-OK" },
      message: {
        audioMessage: {
          ptt: true,
          mimetype: "audio/ogg; codecs=opus",
          url: "remind me to call the bank",
        },
      },
    });
    await until(() => !!noteFor("SELF-VOICE-OK"));
    const note = noteFor("SELF-VOICE-OK");
    expect(note.params.content).toBe(
      "[Voice message] heard: remind me to call the bank",
    );
    expect(note.params.meta.attachment_file_id).toBeUndefined();
    expect(loggedLines().find((l) => l.id === "SELF-VOICE-OK")).toMatchObject({
      direction: "in",
      replied: false,
    });
  }, 20000);

  test("a voice note whose transcription fails arrives as a downloadable attachment", async () => {
    await upsert({
      key: { remoteJid: OWN_LID, fromMe: true, id: "SELF-VOICE-FAIL" },
      message: {
        audioMessage: {
          ptt: true,
          mimetype: "audio/ogg; codecs=opus",
          url: "FAIL this one",
        },
      },
    });
    await until(() => !!noteFor("SELF-VOICE-FAIL"));
    const meta = noteFor("SELF-VOICE-FAIL").params.meta;
    expect(meta.attachment_kind).toBe("voice");
    expect(meta.attachment_file_id).toBe("SELF-VOICE-FAIL");
    expect(noteFor("SELF-VOICE-FAIL").params.content).toBe("(voice)");
  }, 20000);

  test("a replay of an already-delivered self-chat message is not delivered twice", async () => {
    const before = channelNotes().length;
    await upsert({
      key: { remoteJid: OWN_LID, fromMe: true, id: "SELF-TEXT-1" },
      message: { conversation: "what is on my calendar today?" },
    });
    await settle();
    expect(channelNotes().length).toBe(before);
    expect(loggedLines().filter((l) => l.id === "SELF-TEXT-1").length).toBe(1);
  }, 20000);

  test("Claude's reply into the self-chat is never routed back to Claude", async () => {
    const before = channelNotes().length;
    const result = await tool("reply", {
      chat_id: OWN_LID,
      text: "You have two meetings today.",
    });
    expect(result.isError).toBeFalsy();
    const echo = sends().find(
      (s) => s.content.text === "You have two meetings today.",
    );
    expect(echo).toBeTruthy();
    await settle();
    expect(channelNotes().length).toBe(before);
    expect(
      loggedLines().some((l) => l.id === echo.id && l.direction === "in"),
    ).toBe(false);
    // The reply answered the command.
    expect(loggedLines().find((l) => l.id === "SELF-TEXT-1")?.replied).toBe(
      true,
    );
  }, 20000);

  test("a permission reply typed in the self-chat is claimed, not delivered as chat", async () => {
    const before = channelNotes().length;
    send({
      jsonrpc: "2.0",
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "Fixture approval",
        input_preview: '{"command":"echo fixture"}',
      },
    });
    await until(() => sends().some((s) => s.content.text?.includes("[abcde]")));
    expect(sends().find((s) => s.content.text?.includes("[abcde]")).jid).toBe(
      OWN_PHONE,
    );
    await upsert({
      key: { remoteJid: OWN_LID, fromMe: true, id: "SELF-YES" },
      message: { conversation: "yes abcde" },
    });
    await until(() =>
      notifications.some(
        (n) =>
          n.method === "notifications/claude/channel/permission" &&
          n.params.request_id === "abcde" &&
          n.params.behavior === "allow",
      ),
    );
    await settle();
    // Neither the request's own echo nor the "yes" became a chat message.
    expect(channelNotes().length).toBe(before);
    expect(sends().some((s) => s.content.react === "✅")).toBe(true);
  }, 20000);

  test("a reaction the owner adds in the self-chat is neither delivered nor acked", async () => {
    const before = { notes: channelNotes().length, sends: sends().length };
    await upsert({
      key: { remoteJid: OWN_LID, fromMe: true, id: "SELF-REACT" },
      message: {
        reactionMessage: {
          key: { remoteJid: OWN_LID, fromMe: true, id: "SELF-TEXT-1" },
          text: "👍",
        },
      },
    });
    await settle();
    expect(channelNotes().length).toBe(before.notes);
    expect(sends().length).toBe(before.sends);
    expect(loggedLines().some((l) => l.id === "SELF-REACT")).toBe(false);
  }, 20000);

  test("the owner typing in any other chat is still only logged as a hand reply", async () => {
    await upsert({
      key: { remoteJid: CONTACT, fromMe: false, id: "CONTACT-IN" },
      message: { conversation: "are you free tomorrow?" },
    });
    await until(() => !!noteFor("CONTACT-IN"));
    const before = channelNotes().length;
    await upsert({
      key: { remoteJid: CONTACT, fromMe: true, id: "OWNER-HAND" },
      message: { conversation: "yes, after 3" },
    });
    await until(() => loggedLines().some((l) => l.id === "OWNER-HAND"));
    await settle();
    expect(channelNotes().length).toBe(before);
    expect(loggedLines().find((l) => l.id === "OWNER-HAND")).toMatchObject({
      direction: "out",
      by: "owner",
      replied: true,
    });
    expect(loggedLines().find((l) => l.id === "CONTACT-IN")?.replied).toBe(
      true,
    );
  }, 20000);
});
