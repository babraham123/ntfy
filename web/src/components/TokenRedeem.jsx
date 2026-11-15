import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Typography, Button, Box, CircularProgress } from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { useTranslation } from "react-i18next";
import AvatarBox from "./AvatarBox";
import routes from "./routes";
import { EnrollCodeInvalidError } from "../app/errors";
import { fadeReload } from "../app/transition";
import {
  acceptRedeem,
  declineRedeem,
  parseTokenRedeemFragment,
  RedeemResult,
  SignedInAsOtherUserError,
  startRedeem,
} from "../app/tokenRedeem";

const STATUS_WORKING = "working";
const STATUS_CONFIRM = "confirm";
const STATUS_WARNING = "warning";
const STATUS_ERROR = "error";

// The app must fully reload to pick up a new session and its local database
const goToApp = () => fadeReload(routes.app);

const errorState = (t, e) => {
  console.log(`[TokenRedeem] Redeeming link failed`, e);
  if (e instanceof EnrollCodeInvalidError) {
    return { status: STATUS_ERROR, message: t("token_redeem_error_invalid_description") };
  }
  if (e instanceof SignedInAsOtherUserError) {
    return { status: STATUS_ERROR, message: t("token_redeem_error_other_user_description", { username: e.username }) };
  }
  return { status: STATUS_ERROR, message: e.message };
};

// TokenRedeem is the landing page for enrollment links (/account/token/redeem#code=..&user=..&subscribe=..).
// It asks before signing in (naming the account the server returned for the code, not the one in the
// link) and before subscribing, so a link from someone else cannot silently act on this browser. The
// link is stripped from the URL on load to keep the code out of browser history.
const TokenRedeem = () => {
  const { t } = useTranslation();
  const [state, setState] = useState({ status: STATUS_WORKING });
  const ran = useRef(false);

  const accept = async (pending) => {
    setState({ status: STATUS_WORKING });
    try {
      const failedTopics = await acceptRedeem(pending);
      if (failedTopics.length > 0) {
        setState({ status: STATUS_WARNING, username: pending.username, failedTopics });
      } else {
        goToApp();
      }
    } catch (e) {
      setState(errorState(t, e));
    }
  };

  const decline = async (pending) => {
    setState({ status: STATUS_WORKING });
    try {
      await declineRedeem(pending);
    } catch (e) {
      console.log(`[TokenRedeem] Deleting the declined token failed`, e);
    }
    goToApp();
  };

  useEffect(() => {
    if (ran.current) {
      return; // Guard against double-invoke (e.g. React StrictMode) consuming the code twice
    }
    ran.current = true;
    const link = parseTokenRedeemFragment(window.location.hash);
    window.history.replaceState(null, "", routes.tokenRedeem);
    (async () => {
      try {
        const pending = await startRedeem(link);
        if (pending.result === RedeemResult.ALREADY_SIGNED_IN && pending.topics.length === 0) {
          goToApp(); // Nothing to sign in to or subscribe to
        } else {
          setState({ status: STATUS_CONFIRM, pending });
        }
      } catch (e) {
        setState(errorState(t, e));
      }
    })();
  }, [t]);

  const { status, pending } = state;
  const signingIn = pending?.result === RedeemResult.SIGNED_IN;
  return (
    <AvatarBox>
      {status === STATUS_WORKING && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <CircularProgress size={24} />
          <Typography sx={{ typography: "h6" }}>{t("token_redeem_progress_title")}</Typography>
        </Box>
      )}
      {status === STATUS_CONFIRM && (
        <>
          <Typography sx={{ typography: "h6" }}>
            {signingIn
              ? t("token_redeem_confirm_sign_in_title", { username: pending.username })
              : t("token_redeem_confirm_subscribe_title")}
          </Typography>
          <Typography sx={{ mt: 1, textAlign: "center" }}>
            {signingIn
              ? t("token_redeem_confirm_sign_in_description", { username: pending.username })
              : t("token_redeem_confirm_subscribe_description", { username: pending.username })}
          </Typography>
          {pending.topics.length > 0 && (
            <Typography sx={{ mt: 1, textAlign: "center" }}>
              {t("token_redeem_confirm_topics", { topics: pending.topics.join(", ") })}
            </Typography>
          )}
          <Box sx={{ display: "flex", gap: 1, mt: 2 }}>
            <Button onClick={() => decline(pending)}>{t("common_cancel")}</Button>
            <Button onClick={() => accept(pending)} variant="contained">
              {signingIn ? t("token_redeem_button_sign_in") : t("token_redeem_button_subscribe")}
            </Button>
          </Box>
        </>
      )}
      {status === STATUS_WARNING && (
        <>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <WarningAmberIcon color="warning" sx={{ fontSize: 28 }} />
            <Typography sx={{ typography: "h6" }}>{t("token_redeem_warning_title")}</Typography>
          </Box>
          <Typography sx={{ mt: 1, textAlign: "center" }}>
            {t("token_redeem_warning_description", { username: state.username, topics: state.failedTopics.join(", ") })}
          </Typography>
          <Button onClick={goToApp} variant="contained" sx={{ mt: 2 }}>
            {t("token_redeem_button_app")}
          </Button>
        </>
      )}
      {status === STATUS_ERROR && (
        <>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <ErrorOutlineIcon color="error" sx={{ fontSize: 28 }} />
            <Typography sx={{ typography: "h6" }}>{t("token_redeem_error_title")}</Typography>
          </Box>
          <Typography sx={{ mt: 1, textAlign: "center" }}>{state.message}</Typography>
          <Button onClick={goToApp} variant="contained" sx={{ mt: 2 }}>
            {t("token_redeem_button_app")}
          </Button>
        </>
      )}
    </AvatarBox>
  );
};

export default TokenRedeem;
