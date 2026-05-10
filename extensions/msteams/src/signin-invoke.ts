import { formatUnknownError } from "./errors.js";
import { isSigninInvokeAuthorized } from "./monitor-handler.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import {
  handleSigninTokenExchangeInvoke,
  handleSigninVerifyStateInvoke,
  parseSigninTokenExchangeValue,
  parseSigninVerifyStateValue,
} from "./sso.js";

/**
 * Legacy helper for explicit `signin/tokenExchange` and `signin/verifyState`
 * route handling.
 *
 * The production monitor now leaves the SDK's built-in sign-in routes in
 * control so Teams receives the SDK's 200/412 InvokeResponse semantics, then
 * persists successful tokens from the SDK `signin` event. Keep this helper for
 * lower-level token-exchange coverage and for any future caller that truly needs
 * to replace the SDK defaults. It must not ack by sending
 * `ctx.sendActivity({ type: "invokeResponse", … })`; on the new SDK that would
 * become an outbound BF activity instead of the HTTP response.
 */
export async function runMSTeamsSigninInvokeHandler(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<void> {
  const activity = context.activity;

  if (!(await isSigninInvokeAuthorized(context, deps))) {
    return;
  }

  if (!deps.sso) {
    deps.log.debug?.("signin invoke received but msteams.sso is not configured", {
      name: activity.name,
    });
    return;
  }

  const user = {
    userId: activity.from?.aadObjectId ?? activity.from?.id ?? "",
    channelId: activity.channelId ?? "msteams",
  };

  try {
    if (activity.name === "signin/tokenExchange") {
      const parsed = parseSigninTokenExchangeValue(activity.value);
      if (!parsed) {
        deps.log.debug?.("invalid signin/tokenExchange invoke value");
        return;
      }
      const result = await handleSigninTokenExchangeInvoke({
        value: parsed,
        user,
        deps: deps.sso,
      });
      if (result.ok) {
        deps.log.info("msteams sso token exchanged", {
          userId: user.userId,
          hasExpiry: Boolean(result.expiresAt),
        });
      } else {
        deps.log.error("msteams sso token exchange failed", {
          code: result.code,
          status: result.status,
          message: result.message,
        });
      }
      return;
    }

    // signin/verifyState
    const parsed = parseSigninVerifyStateValue(activity.value);
    if (!parsed) {
      deps.log.debug?.("invalid signin/verifyState invoke value");
      return;
    }
    const result = await handleSigninVerifyStateInvoke({
      value: parsed,
      user,
      deps: deps.sso,
    });
    if (result.ok) {
      deps.log.info("msteams sso verifyState succeeded", {
        userId: user.userId,
        hasExpiry: Boolean(result.expiresAt),
      });
    } else {
      deps.log.error("msteams sso verifyState failed", {
        code: result.code,
        status: result.status,
        message: result.message,
      });
    }
  } catch (err) {
    deps.log.error("msteams sso invoke handler error", {
      error: formatUnknownError(err),
    });
  }
}
