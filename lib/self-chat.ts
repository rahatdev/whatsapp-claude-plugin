// Self-commands: the owner's own note-to-self chat as a command channel.
//
// Off by default. With WHATSAPP_SELF_COMMANDS=1, a message the owner sends
// into their OWN note-to-self chat is delivered to the agent as an ordinary
// inbound message (meta self_command="true") instead of being logged as a
// hand reply. Every other fromMe message - the owner writing to a contact or
// a group from their phone - stays a hand reply, exactly as before.
//
// Pure, and typed against a passed-in jidNormalizedUser, so it is unit
// testable without server.ts's connect-on-import side effects (same reason
// lib/mentions.ts takes one).

export function selfCommandsEnabled(raw: string | undefined): boolean {
  return raw?.trim() === "1";
}

/** Is `chatJid` the linked account's own note-to-self chat? WhatsApp delivers
 *  that chat under either of the account's two addresses - its phone jid or
 *  its @lid - so `ownForms` carries both. A group can never be it, and an
 *  unknown own identity (before the first `open`) matches nothing. */
export function isOwnSelfChat(
  chatJid: string,
  ownForms: readonly (string | null | undefined)[],
  jidNormalizedUser: (jid: string) => string,
): boolean {
  if (!chatJid || chatJid.endsWith("@g.us")) return false;
  const chat = jidNormalizedUser(chatJid);
  if (!chat) return false;
  return ownForms.some((f) => !!f && jidNormalizedUser(f) === chat);
}

/** Ids already taken for delivery, so one self-command is delivered once.
 *  The durable check is the message log (messageAlreadyLogged), but nothing
 *  is logged until media is downloaded and transcribed, which takes seconds:
 *  a second copy of the same message (a multi-device resend, or the backlog
 *  replay of a reconnect) landing inside that window would pass the log check
 *  and be delivered twice. This closes that window. Bounded FIFO, because it
 *  only has to outlive one message's processing, not the process. */
export function createSeenIds(cap = 1000): (id: string) => boolean {
  const seen = new Set<string>();
  return (id: string) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > cap) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
    return true;
  };
}

export type SelfCommandRoute = "hand-reply" | "deliver" | "duplicate";

/** Where a fromMe message goes once it is known not to be one of the
 *  server's own sends and not a claimed permission answer (both checked by
 *  the caller first, in that order).
 *
 *  - "hand-reply": the existing path (logOwnerHandReply). Everything that is
 *    not a self-command: the feature off, any chat but the note-to-self,
 *    dmPolicy "disabled" (the DM kill switch binds the owner too), and
 *    content-less messages - reactions and the protocol messages the owner's
 *    own devices exchange in that chat - which that path ignores.
 *  - "duplicate": a self-command id already taken. Dropped, never handed to
 *    the hand-reply path, which would log it as the owner's reply and mark
 *    the chat replied under the real delivery.
 *  - "deliver": the inbound route, minus gate().
 *
 *  The I/O inputs are thunks so nothing is read for a message that an
 *  earlier, cheaper check already settled. */
export function selfCommandRoute(
  input: {
    enabled: boolean;
    id: string | null | undefined;
    chatJid: string;
    ownForms: readonly (string | null | undefined)[];
    dmDisabled: () => boolean;
    hasContent: () => boolean;
    alreadyLogged: (id: string) => boolean;
    claim: (id: string) => boolean;
  },
  jidNormalizedUser: (jid: string) => string,
): SelfCommandRoute {
  const { id } = input;
  if (!input.enabled || !id) return "hand-reply";
  if (!isOwnSelfChat(input.chatJid, input.ownForms, jidNormalizedUser))
    return "hand-reply";
  if (input.dmDisabled() || !input.hasContent()) return "hand-reply";
  if (input.alreadyLogged(id)) return "duplicate";
  return input.claim(id) ? "deliver" : "duplicate";
}
