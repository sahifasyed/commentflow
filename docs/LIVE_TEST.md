# Testing a real comment-to-DM campaign

Do this after [DEPLOYMENT.md](DEPLOYMENT.md) and [META_SETUP.md](META_SETUP.md).
Treat live messaging as **unverified until this test passes on your setup**:
the automated tests use a simulated Instagram, not Meta's servers.

You need:

- **Account A**: your connected Business/Creator account (the one sending).
- **Account B**: any other Instagram account (the commenter). Use one you
  control. If your Meta app only has Standard Access, B doesn't need a role
  just to *receive* a reply. A must have a role, because A is the account that connected.

## 1. Pre-flight

1. Open `https://YOUR-DOMAIN/api/health`. Expect `"status":"ok"` and `"worker":{"healthy":true}`.
2. In CommentFlow > **Instagram accounts**, account A shows **Active** and
   **Subscribed**.
3. The Meta app is **Live** and subscribed to `comments` and `messages`.

## 2. Create the campaign

**Campaigns > New campaign**:

- Account: A
- Triggers: *Comments on posts and reels* (optionally *Direct messages* / *Story replies*)
- Post scope: *Only selected posts*, pick a recent post (keeps the test contained)
- Keyword: `TEST`
- Message: `Hi {username}! Here's your link`
- Link 1: any URL you control, button label `Open`
- Optionally enable a public reply: `Sent you a DM {username}`

Save. The campaign shows **Active**.

## 3. Trigger it

From account **B**, comment `TEST` on the selected post.

Within a few seconds you should see:

- In CommentFlow > **Message log**: a row from `@B` with DM **Sent** (and Public reply **Sent**).
- On account B: a message from A (in **Requests** if B doesn't follow A), with the **Open** button.
- Under the comment: A's public reply, if enabled.

Tap **Open** on B. The click appears in the campaign's **Tracked links** and the CTR updates.

## 4. Optional: DM and Story reply triggers

- With *Direct messages* enabled, send `TEST` to A from B in a DM.
- With *Story replies* enabled, post a Story on A and reply `TEST` to it from B.

## 5. If something doesn't work

| What you see | Where to look |
| --- | --- |
| No row in the message log, and "Last webhook received" on Instagram accounts didn't change | Meta isn't delivering. Check Live mode, webhook fields, the callback URL, and Resubscribe. See META_SETUP troubleshooting. |
| "Last webhook received" changed but no log row | The comment didn't match: wrong post, keyword, or a paused campaign. Or it came from account A itself (ignored on purpose). |
| Row stuck at **Queued** | The worker is down or can't reach Redis. Check `docker compose logs worker`. |
| **Failed** with an error code | Expand **Details**. `code=10/200` means a permission is missing. `code=190` means the token is invalid: reconnect. "not the thread owner" means another DM tool still controls the inbox. |
| **Unconfirmed** | Instagram gave an ambiguous answer. CommentFlow doesn't retry, to avoid duplicates. Check B's inbox. |

When a comment from B produces a **Sent** row and B actually receives the DM,
live messaging is verified for your setup.
