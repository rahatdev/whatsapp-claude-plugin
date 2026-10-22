import { describe, expect, test } from "bun:test";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import {
  createSeenIds,
  isOwnSelfChat,
  selfCommandRoute,
  selfCommandsEnabled,
} from "./self-chat";

// The linked account under both of its addresses, the way the note-to-self
// actually arrives (the @lid form is the common one on current clients).
const OWN_PN = "15550001111@s.whatsapp.net";
const OWN_LID = "252333707526385@lid";
const OWN = [OWN_PN, OWN_LID];
const CONTACT = "15550002222@s.whatsapp.net";
const CONTACT_LID = "99887766554433@lid";
const GROUP = "120363000000000000@g.us";

describe("selfCommandsEnabled", () => {
  test("only an explicit 1 turns it on", () => {
    expect(selfCommandsEnabled("1")).toBe(true);
    expect(selfCommandsEnabled(" 1\n")).toBe(true);
    for (const raw of [undefined, "", "0", "true", "yes", "11"])
      expect(selfCommandsEnabled(raw)).toBe(false);
  });
});

describe("isOwnSelfChat", () => {
  test("matches the note-to-self under its phone jid and its @lid", () => {
    expect(isOwnSelfChat(OWN_PN, OWN, jidNormalizedUser)).toBe(true);
    expect(isOwnSelfChat(OWN_LID, OWN, jidNormalizedUser)).toBe(true);
  });

  test("a device-suffixed form of either address still matches", () => {
    expect(
      isOwnSelfChat("15550001111:12@s.whatsapp.net", OWN, jidNormalizedUser),
    ).toBe(true);
    expect(
      isOwnSelfChat(
        OWN_LID,
        ["15550001111@s.whatsapp.net", "252333707526385:3@lid"],
        jidNormalizedUser,
      ),
    ).toBe(true);
  });

  test("never another DM, under either form", () => {
    expect(isOwnSelfChat(CONTACT, OWN, jidNormalizedUser)).toBe(false);
    expect(isOwnSelfChat(CONTACT_LID, OWN, jidNormalizedUser)).toBe(false);
  });

  test("never a group, even one whose id collides with an own form", () => {
    expect(isOwnSelfChat(GROUP, OWN, jidNormalizedUser)).toBe(false);
    expect(isOwnSelfChat(GROUP, [GROUP], jidNormalizedUser)).toBe(false);
  });

  // Before the first `open`, ownJid is "" and there is no lid: nothing is
  // the self-chat, rather than everything (an empty string matching an
  // empty normalization would deliver every fromMe message).
  test("an unknown own identity matches nothing", () => {
    expect(isOwnSelfChat(OWN_PN, ["", undefined], jidNormalizedUser)).toBe(
      false,
    );
    expect(isOwnSelfChat("", ["", undefined], jidNormalizedUser)).toBe(false);
    expect(isOwnSelfChat("", OWN, jidNormalizedUser)).toBe(false);
  });
});

describe("createSeenIds", () => {
  test("claims an id once", () => {
    const claim = createSeenIds();
    expect(claim("a")).toBe(true);
    expect(claim("a")).toBe(false);
    expect(claim("b")).toBe(true);
  });

  test("evicts oldest first past its cap", () => {
    const claim = createSeenIds(2);
    claim("a");
    claim("b");
    claim("c"); // evicts a
    expect(claim("b")).toBe(false);
    expect(claim("c")).toBe(false);
    expect(claim("a")).toBe(true);
  });
});

describe("selfCommandRoute", () => {
  function input(over: Partial<Parameters<typeof selfCommandRoute>[0]> = {}) {
    return {
      enabled: true,
      id: "3EB0SELF",
      chatJid: OWN_LID,
      ownForms: OWN,
      blocked: () => false,
      hasContent: () => true,
      alreadyLogged: () => false,
      claim: createSeenIds(),
      ...over,
    };
  }
  const route = (over?: Parameters<typeof input>[0]) =>
    selfCommandRoute(input(over), jidNormalizedUser);

  test("the owner's text or media in their note-to-self is delivered", () => {
    expect(route()).toBe("deliver");
    expect(route({ chatJid: OWN_PN })).toBe("deliver");
  });

  test("off by default: everything stays a hand reply", () => {
    expect(route({ enabled: false })).toBe("hand-reply");
  });

  // The guarantee the feature rests on: the owner writing to anyone else
  // from their phone is never turned into a command.
  test("fromMe in any other chat stays a hand reply", () => {
    for (const chatJid of [CONTACT, CONTACT_LID, GROUP])
      expect(route({ chatJid })).toBe("hand-reply");
  });

  test("the caller's access rules (dmPolicy disabled, owner not allowlisted) bind the owner too", () => {
    expect(route({ blocked: () => true })).toBe("hand-reply");
  });

  test("reactions and protocol messages (no content) stay off the inbound route", () => {
    expect(route({ hasContent: () => false })).toBe("hand-reply");
  });

  test("a message without an id cannot be de-duplicated, so is not delivered", () => {
    expect(route({ id: undefined })).toBe("hand-reply");
    expect(route({ id: "" })).toBe("hand-reply");
  });

  test("a replay of a logged id is a duplicate, never a hand reply", () => {
    expect(route({ alreadyLogged: () => true })).toBe("duplicate");
  });

  // Multi-device / backlog: the second copy can land while the first is
  // still transcribing, before anything is in the log.
  test("a second copy before the first is logged is a duplicate", () => {
    const claim = createSeenIds();
    expect(route({ claim })).toBe("deliver");
    expect(route({ claim })).toBe("duplicate");
    expect(route({ claim, chatJid: OWN_PN })).toBe("duplicate");
    expect(route({ claim, id: "3EB0OTHER" })).toBe("deliver");
  });

  test("I/O is not touched for a message an earlier check settled", () => {
    const touched: string[] = [];
    const spy = {
      blocked: () => (touched.push("access"), false),
      hasContent: () => (touched.push("content"), true),
      alreadyLogged: () => (touched.push("log"), false),
      claim: () => (touched.push("claim"), true),
    };
    route({ ...spy, chatJid: CONTACT });
    route({ ...spy, enabled: false });
    expect(touched).toEqual([]);
  });
});
