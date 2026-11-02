import { useSearchParams } from "react-router-dom";

/**
 * Meta requires a privacy policy, terms and data deletion instructions URL
 * before an app can go Live. These are starting templates: the operator of
 * this instance must review and adapt them (they are not legal advice).
 */
export function LegalPage({ kind }: { kind: "privacy" | "terms" | "data-deletion" }) {
  const [params] = useSearchParams();
  const host = window.location.host;
  return (
    <div className="legal">
      <p><a href="/">← Back</a></p>
      {kind === "privacy" && (
        <>
          <h1>Privacy policy</h1>
          <p>This CommentFlow instance at {host} is operated by the owner of this website, who is responsible for the data described here.</p>
          <h2>What we collect</h2>
          <p>When an Instagram professional account is connected, we store its account ID, username and an encrypted access token. When someone comments on, messages, or replies to a Story of a connected account, we store the comment or message text, the person’s Instagram-scoped ID and username, and what we sent in reply. When someone opens a tracked link we store the time, a hashed IP address and the browser user agent.</p>
          <h2>How we use it</h2>
          <p>Only to send the automated replies the account owner configured and to show the account owner delivery logs and statistics. We do not sell data or use it for advertising.</p>
          <h2>Retention and deletion</h2>
          <p>Data is kept while the account is connected. Disconnecting an account deletes its access token immediately. See the data deletion page to remove everything.</p>
          <h2>Contact</h2>
          <p>Contact the operator of this instance to exercise your data rights.</p>
        </>
      )}
      {kind === "terms" && (
        <>
          <h1>Terms of service</h1>
          <p>This software is provided as-is by the operator of {host}. Account owners are responsible for the messages their campaigns send and must follow Instagram’s Terms of Use, Community Guidelines and Meta’s Platform Terms, including messaging windows and rate limits.</p>
          <p>Do not use this service to send spam, unsolicited bulk messages, or deceptive content. The operator may suspend workspaces that do.</p>
        </>
      )}
      {kind === "data-deletion" && (
        <>
          <h1>Data deletion</h1>
          {params.get("code") && (
            <p className="notice ok">Your deletion request was received and processed. Confirmation code: <b className="mono">{params.get("code")}</b></p>
          )}
          <p>To delete the data this instance holds about your Instagram account:</p>
          <ol>
            <li>If you connected the account: open Instagram accounts in the dashboard and click Disconnect, or remove the app in Instagram under Settings, Apps and websites. Removing the app sends us an automatic deletion request and we delete the account’s campaigns, logs and messages.</li>
            <li>If you only interacted with an account that uses this service, contact that account or the operator of {host} and ask for your data to be deleted.</li>
          </ol>
        </>
      )}
    </div>
  );
}
