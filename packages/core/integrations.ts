import { isDemo } from "./common";

export type OidcProvider = "google" | "microsoft";
const oauth = {
  google: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET", issuer: "https://accounts.google.com" },
  microsoft: { id: "MICROSOFT_CLIENT_ID", secret: "MICROSOFT_CLIENT_SECRET", issuer: "https://login.microsoftonline.com/consumers/v2.0" },
} as const;

function get(name: string) {
  return process.env[name]?.trim() || undefined;
}
function origin(value: string | undefined, allowLocal = false) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol === "https:" || (allowLocal && url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) {
      return url.origin;
    }
  } catch {
    return null;
  }
  return null;
}
export function oidcSettings(provider: OidcProvider) {
  const { id, secret, issuer } = oauth[provider];
  const clientId = get(id), clientSecret = get(secret);
  const base = origin(get("APP_URL") ?? "http://localhost:3000", process.env.NODE_ENV !== "production");
  const callback=base&&base+"/api/v1/auth/"+provider+"/callback";
  return {clientId,clientSecret,issuer,callback,configured:!!(clientId && clientSecret && callback)};
}
export function stripeSettings() {
  const key = get("STRIPE_SECRET_KEY"), webhook = get("STRIPE_WEBHOOK_SECRET");
  const mode = /^(sk|rk)_live_\S+$/.test(key ?? "") ? "live" : /^(sk|rk)_test_\S+$/.test(key ?? "") ? "test" : null;
  return {
    key, mode, webhook: /^whsec_\S+$/.test(webhook ?? "") ? webhook : undefined,
    liveEnabled: get("STRIPE_LIVE_ENABLED") === "1" && origin(get("APP_URL")) !== null && !isDemo(),
  };
}
export function postmarkSettings() {
  const token = get("POSTMARK_SERVER_TOKEN"), from = get("EMAIL_FROM");
  const stream = get("POSTMARK_MESSAGE_STREAM") ?? "outbound";
  const webhookToken = get("POSTMARK_WEBHOOK_TOKEN");
  const testToken = token === "POSTMARK_API_TEST";
  return {token, from, stream, webhookToken, testToken, enabled: !isDemo() && !!(token && from) && !testToken};
}
export function trackingSettings() {
  return {
    key: get("KUAIDI100_KEY"), customer: get("KUAIDI100_CUSTOMER"),
    callbackBase: origin(get("TRACKING_CALLBACK_BASE_URL") ?? get("APP_URL")),
  };
}
export function signInMethods() {
  return {
    google:oidcSettings("google").configured,
    microsoft:oidcSettings("microsoft").configured,
    email:postmarkSettings().enabled,
    demo:isDemo(),
  };
}
export type SignInMethods = ReturnType<typeof signInMethods>;

export function integrationPreflight() {
  const demo = isDemo(), stripe = stripeSettings(), mail = postmarkSettings(), tracking = trackingSettings();
  function oidcStatus(provider: OidcProvider) {
    const {configured,callback}=oidcSettings(provider);
    return {configured,callback};
  }
  return {
    demo, google: oidcStatus("google"), microsoft: oidcStatus("microsoft"),
    stripe: {mode: stripe.mode, webhookConfigured: !!stripe.webhook, liveEnabled: stripe.liveEnabled,
      checkoutConfigured: !demo && !!stripe.webhook && (stripe.mode === "test" || stripe.mode === "live" && stripe.liveEnabled)},
    postmark: {configured: !!(mail.token && mail.from), testToken: mail.testToken, enabled: mail.enabled},
    kuaidi100: {queryConfigured: !!(tracking.key && tracking.customer), httpsCallbackConfigured: !!tracking.callbackBase,
      subscribeConfigured: !!(tracking.key && tracking.callbackBase), workerEnabled: !demo && !!(tracking.key && (tracking.customer || tracking.callbackBase))},
  };
}
