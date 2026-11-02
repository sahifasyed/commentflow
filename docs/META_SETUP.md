# Meta app setup: connect real Instagram accounts

This guide gets you from nothing to a Meta app that lets CommentFlow receive
comments and send DMs for **your own** Instagram professional account.

Steps are tagged:

- **[YOU]**: needs your Meta/Instagram login, a secret, or a click only you can make.
- **[META]**: waits on Meta (an approval, a review, or verification).
- **[APP]**: done by CommentFlow automatically.

> CommentFlow uses the **Instagram API with Instagram Login** (Business Login
> for Instagram, host `graph.instagram.com`). It never asks for an Instagram
> password, never scrapes, and never automates a browser.

## Before you start

- **[YOU]** An Instagram **Business or Creator** account. Personal accounts can't
  be connected (Instagram app > Settings > Account type and tools > Switch to
  professional account).
- **[YOU]** A Facebook account to register as a Meta developer at
  <https://developers.facebook.com>.
- **[YOU]** CommentFlow deployed at a **public HTTPS URL** (see
  [DEPLOYMENT.md](DEPLOYMENT.md)). Meta can't reach `localhost`. For local
  testing, use a tunnel such as `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`
  and set `APP_URL` to the tunnel's https URL.
- A **second** Instagram account to test with. CommentFlow ignores comments
  from the connected account itself, and Meta rejects DMs to yourself.

Below, `https://YOUR-DOMAIN` means your `APP_URL`.

## 1. Create the app [YOU]

1. Go to <https://developers.facebook.com/apps> and click **Create app**.
2. When asked for a use case, choose **Manage messaging & content on Instagram**.
   Don't pick "Authenticate with Facebook Login" or the Marketing API use case:
   CommentFlow uses Instagram Login, and the wrong use case causes OAuth errors later.
3. Choose app type **Business** if asked, and give it a name that doesn't
   contain "Insta" or "Gram" (Meta's brand rules).

## 2. Copy the credentials into `.env` [YOU]

In the app dashboard open **Instagram > API setup with Instagram login**.

| `.env` variable | Where to find it |
| --- | --- |
| `INSTAGRAM_APP_ID` | "Instagram app ID" on that page. It is **not** the Facebook App ID shown under App settings > Basic. |
| `INSTAGRAM_APP_SECRET` | "Instagram app secret" on the same page (click Show). |
| `FACEBOOK_APP_SECRET` | App settings > Basic > App secret. Optional; webhook signatures are accepted from either secret. |
| `WEBHOOK_VERIFY_TOKEN` | Any long random string you make up, e.g. `openssl rand -hex 16`. |

Restart CommentFlow (web **and** worker) after editing `.env`. The Instagram
accounts page will then enable **Connect Instagram**.

Treat these secrets like passwords. If one is ever pasted somewhere public
(including a chat), reset it in the dashboard.

## 3. Register the OAuth redirect URI [YOU]

On the same page, open **Set up Instagram business login > Business login settings**
and add this to **OAuth redirect URIs**, exactly, with no trailing slash:

```
https://YOUR-DOMAIN/api/instagram/callback
```

CommentFlow builds its own login URL; you don't need Meta's "Embed URL".

## 4. Configure webhooks [YOU] + [APP]

Still under **API setup with Instagram login**, find **Configure webhooks**:

- **Callback URL:** `https://YOUR-DOMAIN/api/webhook`
- **Verify token:** the exact `WEBHOOK_VERIFY_TOKEN` value
- Click **Verify and save**. **[APP]** CommentFlow answers Meta's challenge.
  If it fails, check that the app is reachable over HTTPS and the token matches.
- **Subscribe** to the fields **`comments`** and **`messages`**.
  `comments` powers comment-to-DM. `messages` powers DM and Story-reply triggers;
  without it those triggers never fire.

To check delivery: click **Test** next to `comments`, then **Send to My Server**.
Then open **Instagram accounts** in CommentFlow; "Last webhook received" should
update. (Test events don't belong to a connected account, so they won't appear
in the message log.)

When an account connects, **[APP]** CommentFlow also calls
`POST /me/subscribed_apps?subscribed_fields=comments,messages` for that account.
If that fails, use **Resubscribe webhooks** on the Instagram accounts page.

## 5. Add yourself as an Instagram tester [YOU]

While the app has only Standard Access, it works only for Instagram accounts
that have a role on the app. This step has **two halves, and both are required**.

1. **In Meta:** App roles > Roles > **Instagram Testers** > Add, and enter the
   exact username of the Instagram account you'll connect.
2. **In Instagram** (as that account): Settings and activity > **Website
   permissions / Apps and websites** > **Tester invites** > Accept.

If you skip the second half, Instagram login fails with "Insufficient developer role".

## 6. Privacy, terms and data deletion URLs [YOU]

Meta requires these before the app can go Live. CommentFlow serves starter pages,
which you must **review and adapt** for your situation (they are templates, not legal advice):

| Field in App settings > Basic | URL |
| --- | --- |
| Privacy policy URL | `https://YOUR-DOMAIN/privacy` |
| Terms of service URL | `https://YOUR-DOMAIN/terms` |
| User data deletion | "Data deletion callback URL": `https://YOUR-DOMAIN/api/meta/data-deletion` (or the instructions page `https://YOUR-DOMAIN/data-deletion`) |

Optionally, set the **Deauthorize callback URL** (Instagram > API setup > Business
login settings) to `https://YOUR-DOMAIN/api/meta/deauthorize`. **[APP]** When
someone removes the app, CommentFlow wipes the token and pauses campaigns. A
signed data-deletion request deletes the account and all its data.

## 7. Publish the app (Live mode) [YOU] + [META]

Real comment and message webhooks are only delivered once the app is **Live**.
In Development mode, only the dashboard's Test button delivers events. This is
the most common reason for "I set everything up and nothing happens".

Open **Publish** in the left sidebar and publish. Depending on your account,
Meta may let you go Live right away for your own tester accounts, or may first
ask for verification or review **[META]**.

## 8. Connect Instagram in CommentFlow [YOU]

Sign in to CommentFlow > **Instagram accounts** > **Connect Instagram**. Approve
the permissions on Instagram's consent screen. You return to CommentFlow with
"Connected @yourname". **[APP]** The token is exchanged for a 60-day long-lived
token, encrypted with AES-256-GCM, refreshed automatically before expiry, and
the account is subscribed to webhooks.

Then follow [LIVE_TEST.md](LIVE_TEST.md) to test a real campaign.

## Permissions CommentFlow requests

| Permission | Why |
| --- | --- |
| `instagram_business_basic` | Identify the connected account and list its posts for the post picker. |
| `instagram_business_manage_comments` | Receive comment webhooks and post optional public replies under comments. |
| `instagram_business_manage_messages` | Send the private reply / DM, and receive DMs and Story replies. |

## Letting other people connect their accounts: App Review [META]

Everything above is enough to run CommentFlow for **your own** accounts and any
accounts you add as Instagram testers. To let accounts **without a role** on your
app connect (clients, the public), you need **Advanced Access** for the three
permissions, which means **App Review** and usually **Business Verification**:

- **[YOU]** Record a screencast on your live app, in one take: sign in, connect
  Instagram (show the consent screen), create a campaign with keyword `LINK`,
  comment `LINK` from a second account, show the DM arriving and the public
  reply, then show the SENT row in the message log.
- **[YOU]** Write a justification per permission. Starting text you can adapt:
  - *instagram_business_basic*: identifies the connected professional account so
    automations and logs are attributed to it, and lists the account's own posts
    so the owner can choose which posts a campaign applies to.
  - *instagram_business_manage_comments*: receives comments on the account
    owner's own posts via webhook so a configured keyword can trigger a reply,
    and posts the optional public reply the owner wrote.
  - *instagram_business_manage_messages*: sends one private reply to a person
    who commented a keyword on the owner's post, or replied to a DM/Story within
    the 24-hour window, containing content the owner configured.
- **[META]** Business Verification asks for documents proving a legal business
  entity. Without a registered business you generally can't complete it;
  running CommentFlow for your own accounts doesn't need it.
- Expect Meta to scrutinize automated messaging and possibly reject the first
  submission. Budget time to resubmit.

Meta's docs note that some webhook fields may require Advanced Access. In
OpenReply's experience, Live mode plus tester roles is enough for your own
accounts. If comment webhooks never arrive for a tester account on a Live app,
check the troubleshooting list below, and then whether Meta now requires
Advanced Access for your setup.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Insufficient developer role" on the Instagram login screen | The tester invite wasn't accepted inside Instagram (step 5, second half). |
| `redirect_uri` mismatch | The redirect URI in step 3 doesn't exactly match `APP_URL` + `/api/instagram/callback`. |
| Connection succeeds, then every call fails with `Unsupported request ... code=100` | That account has no role on the app (Standard Access). Add it as a tester, or get Advanced Access. |
| Webhook verification fails | `WEBHOOK_VERIFY_TOKEN` differs, or the URL isn't reachable over HTTPS. Use your primary domain: Meta doesn't reliably follow redirects. |
| Comments arrive (Last webhook updates) but nothing appears in the log | No active campaign matched. Check the keyword, match mode, post scope and campaign status. |
| Log rows stay "Queued" | The worker isn't running. `/api/health` shows `worker.healthy`. |
| Webhooks never arrive for real comments | App not Live (step 7), `comments` not subscribed (step 4), or the account isn't subscribed (use Resubscribe). |
| 401 "Invalid signature" in system events | The app secret in `.env` belongs to a different app. |
| First DM works, but later sends fail with "not the thread owner" | Another tool (e.g. ManyChat) still owns the conversation. In Meta Business Suite > Settings > Integrations > Conversation routing, remove the old tool under Partner apps, and give your app control of conversations. |
| "Comment older than 7 days" skip | Meta allows a private reply only within 7 days of the comment. |
| "Outside 24-hour window" skip | Meta allows replying to a DM only within 24 hours of the person's last message. |
| Account shows "Reconnect needed" | The token was revoked or expired. Click Reconnect. |
