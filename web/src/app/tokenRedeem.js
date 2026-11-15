import accountApi from "./AccountApi";
import session from "./Session";
import { EnrollCodeInvalidError, SubscriptionExistsError } from "./errors";
import { validTopic } from "./utils";

const tokenLabel = "Web app";

export const RedeemResult = {
  SIGNED_IN: "signed_in",
  ALREADY_SIGNED_IN: "already_signed_in",
};

export class SignedInAsOtherUserError extends Error {
  constructor(username) {
    super(`Already signed in as ${username}`);
    this.username = username;
  }
}

// parseTokenRedeemFragment reads an enrollment link's fragment: #code=<code>&user=<username>&subscribe=<t1,t2>.
// The values live in the fragment, not the query, so browsers never send them to the server.
export const parseTokenRedeemFragment = (hash) => {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const topics = (params.get("subscribe") || "")
    .split(",")
    .map((topic) => topic.trim())
    .filter((topic) => validTopic(topic));
  return { code: params.get("code") || "", user: params.get("user") || "", topics };
};

// startRedeem prepares an enrollment link for the user to confirm. Signed out, it redeems the one-time
// code, since only the server knows which account the code belongs to, but does not store the session:
// the caller must show the account the server named and let the user accept or decline, so a link
// someone else crafted cannot silently sign this browser in to their account. Signed in, it never
// replaces the session: when the session is the link's user's (or the link names no user), the code is
// left to expire and only the topics are offered; a session belonging to someone else is refused.
export const startRedeem = async ({ code, user, topics }) => {
  if (session.exists()) {
    if (user && session.username() !== user) {
      throw new SignedInAsOtherUserError(session.username());
    }
    return { result: RedeemResult.ALREADY_SIGNED_IN, username: session.username(), topics };
  }
  if (!code) {
    throw new EnrollCodeInvalidError();
  }
  const { token, username } = await accountApi.redeemToken(code, tokenLabel);
  return { result: RedeemResult.SIGNED_IN, username, token, topics };
};

// acceptRedeem stores the session of a confirmed link and subscribes the account to the link's topics.
// A topic that cannot be added does not undo the sign-in: the failed topics are returned so the caller
// can warn about them. The caller must reload the app afterwards, since a new session switches to that
// user's local database.
export const acceptRedeem = async ({ result, username, token, topics }) => {
  if (result === RedeemResult.SIGNED_IN) {
    await session.store(username, token);
  }
  const failedTopics = [];
  for (const topic of topics) {
    try {
      // Added to the account, not the local database, which belongs to the session the page loaded with.
      // One at a time: the server appends to the stored list, so concurrent adds could drop each other.
      // eslint-disable-next-line no-await-in-loop
      await accountApi.addSubscription(config.base_url, topic);
    } catch (e) {
      if (!(e instanceof SubscriptionExistsError)) {
        console.log(`[TokenRedeem] Subscribing to ${topic} failed`, e);
        failedTopics.push(topic);
      }
    }
  }
  return failedTopics;
};

// declineRedeem deletes the token a declined link was redeemed for, authenticating with that token
// itself, since it was never stored as this browser's session.
export const declineRedeem = async ({ result, token }) => {
  if (result === RedeemResult.SIGNED_IN) {
    await accountApi.deleteToken(token, token);
  }
};
