import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import session from "./Session";
import { EnrollCodeInvalidError } from "./errors";
import { acceptRedeem, declineRedeem, parseTokenRedeemFragment, RedeemResult, SignedInAsOtherUserError, startRedeem } from "./tokenRedeem";

vi.mock("i18next", () => ({ default: { changeLanguage: vi.fn() } }));

let fetchMock;

const respond = (status, body = {}) => ({ status, json: async () => body });

// Routes the fake server's answers by endpoint, so each test states only what differs
const serve = (handlers) => {
  fetchMock.mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) {
      throw new Error(`unexpected request to ${path}`);
    }
    return handler();
  });
};

const requestsTo = (path) => fetchMock.mock.calls.filter(([url]) => new URL(url).pathname === path);

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  await session.db.kv.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parseTokenRedeemFragment", () => {
  it("reads the code, user, and topics, dropping topics the app could not subscribe to", () => {
    expect(parseTokenRedeemFragment("#code=abc123&user=phil&subscribe=alerts,phil-inbox,bad/topic,app,")).toEqual({
      code: "abc123",
      user: "phil",
      topics: ["alerts", "phil-inbox"],
    });
  });

  it("treats a missing fragment as an empty link", () => {
    expect(parseTokenRedeemFragment("")).toEqual({ code: "", user: "", topics: [] });
  });
});

describe("signed out", () => {
  it("redeems the code but waits for confirmation, naming the account the server returned", async () => {
    serve({ "/v1/account/token/redeem": () => respond(200, { token: "tk_new", username: "mallory" }) });

    const pending = await startRedeem({ code: "abc123", user: "phil", topics: ["alerts"] });

    expect(pending).toEqual({ result: RedeemResult.SIGNED_IN, username: "mallory", token: "tk_new", topics: ["alerts"] });
    expect(session.exists()).toBeFalsy();
    expect(requestsTo("/v1/account/subscription")).toHaveLength(0);

    const [[, redeem]] = requestsTo("/v1/account/token/redeem");
    expect(redeem.method).toBe("POST");
    expect(redeem.headers).toBeUndefined(); // The code is the credential
    expect(JSON.parse(redeem.body)).toEqual({ code: "abc123", label: "Web app" });
  });

  it("signs in on accept, then subscribes the new account to each topic", async () => {
    serve({
      "/v1/account/token/redeem": () => respond(200, { token: "tk_new", username: "phil" }),
      "/v1/account/subscription": () => respond(200, {}),
    });

    const pending = await startRedeem({ code: "abc123", user: "phil", topics: ["alerts", "phil-inbox"] });
    expect(await acceptRedeem(pending)).toEqual([]);

    expect(session.username()).toBe("phil");
    expect(session.token()).toBe("tk_new");
    expect(await session.usernameAsync()).toBe("phil"); // The service worker reads the IndexedDB replica

    const subscriptions = requestsTo("/v1/account/subscription");
    expect(subscriptions.map(([, options]) => JSON.parse(options.body).topic)).toEqual(["alerts", "phil-inbox"]);
    subscriptions.forEach(([, options]) => expect(options.headers.Authorization).toBe("Bearer tk_new"));
  });

  it("deletes the redeemed token on decline and stays signed out", async () => {
    serve({
      "/v1/account/token/redeem": () => respond(200, { token: "tk_new", username: "mallory" }),
      "/v1/account/token": () => respond(200, {}),
    });

    await declineRedeem(await startRedeem({ code: "abc123", user: "", topics: ["alerts"] }));

    const [[, del]] = requestsTo("/v1/account/token");
    expect(del.method).toBe("DELETE");
    expect(del.headers["X-Token"]).toBe("tk_new");
    expect(del.headers.Authorization).toBe("Bearer tk_new");
    expect(session.exists()).toBeFalsy();
    expect(requestsTo("/v1/account/subscription")).toHaveLength(0);
  });

  it("treats topics the account already has as subscribed", async () => {
    serve({
      "/v1/account/token/redeem": () => respond(200, { token: "tk_new", username: "phil" }),
      "/v1/account/subscription": () => respond(409, { code: 40903, error: "conflict: topic subscription already exists" }),
    });

    expect(await acceptRedeem(await startRedeem({ code: "abc123", user: "", topics: ["alerts"] }))).toEqual([]);
  });

  it("stays signed in when a topic cannot be added, and reports that topic", async () => {
    serve({
      "/v1/account/token/redeem": () => respond(200, { token: "tk_new", username: "phil" }),
      "/v1/account/subscription": () => respond(500, { code: 50001, error: "internal server error" }),
    });

    const failed = await acceptRedeem(await startRedeem({ code: "abc123", user: "phil", topics: ["alerts", "phil-inbox"] }));

    expect(failed).toEqual(["alerts", "phil-inbox"]);
    expect(session.username()).toBe("phil");
    expect(session.token()).toBe("tk_new");
  });

  it("does not sign in when the code is invalid or expired", async () => {
    serve({
      "/v1/account/token/redeem": () => respond(400, { code: 40060, error: "invalid request: enrollment code invalid or expired" }),
    });

    await expect(startRedeem({ code: "used", user: "phil", topics: ["alerts"] })).rejects.toBeInstanceOf(EnrollCodeInvalidError);
    expect(session.exists()).toBeFalsy();
  });

  it("rejects a link without a code", async () => {
    await expect(startRedeem({ code: "", user: "phil", topics: ["alerts"] })).rejects.toBeInstanceOf(EnrollCodeInvalidError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("signed in", () => {
  it("leaves the code unused when signed in as the link's user, and subscribes only on accept", async () => {
    await session.store("phil", "tk_existing");
    serve({ "/v1/account/subscription": () => respond(200, {}) });

    const pending = await startRedeem({ code: "abc123", user: "phil", topics: ["alerts"] });
    expect(pending).toEqual({ result: RedeemResult.ALREADY_SIGNED_IN, username: "phil", topics: ["alerts"] });
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await acceptRedeem(pending)).toEqual([]);
    expect(session.token()).toBe("tk_existing");
    expect(requestsTo("/v1/account/token/redeem")).toHaveLength(0);
    expect(requestsTo("/v1/account/subscription")[0][1].headers.Authorization).toBe("Bearer tk_existing");
  });

  it("changes nothing on decline", async () => {
    await session.store("phil", "tk_existing");

    await declineRedeem(await startRedeem({ code: "abc123", user: "phil", topics: ["alerts"] }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.token()).toBe("tk_existing");
  });

  it("never replaces a session that belongs to someone else", async () => {
    await session.store("ben", "tk_ben");

    await expect(startRedeem({ code: "abc123", user: "phil", topics: ["alerts"] })).rejects.toBeInstanceOf(SignedInAsOtherUserError);
    expect(session.username()).toBe("ben");
    expect(session.token()).toBe("tk_ben");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
