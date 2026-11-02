# Third-party notices and credits

## OpenReply

CommentFlow is a from-scratch implementation that uses
[OpenReply](https://github.com/diwenne/openreply) as its functional reference.
**OpenReply is built and maintained by Diwen Huang. It was originally forked
from [instagram-comment-to-dm](https://github.com/im-anishraj/instagram-comment-to-dm)
by Anish Raj.**

### Code reused from OpenReply

- `src/lib/keywords.ts`: the keyword matcher (Unicode-aware whole-word
  matching, Latin diacritic folding, Arabic-script normalization, O/0 folding
  for numeric keywords) is copied from OpenReply's
  `lib/utils/keyword-matcher.ts`, with a small `matchCampaign` wrapper added.
  The MIT notice is reproduced in that file's header.

### Behavior adapted from OpenReply (re-implemented, not copied)

- Webhook parsing rules: skip the account's own comments and message echoes,
  carry `original_media_id` for comments on ads, accept signatures from either
  the Instagram or the Facebook app secret.
- Delivery policy: claim a send before calling Instagram; treat Meta code 1/2,
  5xx and network errors as "delivery unconfirmed" and never auto-resend them;
  fall back from a button template to plain text only on an explicit template
  rejection; one private reply per comment across campaigns.
- Atomic per-account hourly rate limiting in Redis (reserve before send,
  release on confirmed rejection), defaulting to Meta's documented 750
  private replies per hour.
- Tracked links with a keyed per-recipient token (`?r=`) for unique clicks.
- Storing the professional account `user_id` (not the app-scoped `id`) from `/me`.
- Setup knowledge in `docs/META_SETUP.md` (tester invites, Live mode,
  conversation routing when migrating from another DM tool).

### OpenReply license

```
MIT License

Copyright (c) 2026 Anish Raj
Copyright (c) 2026 Diwen Huang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts

Public Sans (bundled via `@fontsource-variable/public-sans`) is licensed under
the SIL Open Font License 1.1.

## npm dependencies

Runtime dependencies (express, pg, ioredis, bullmq, zod, helmet,
cookie-parser, react, react-dom, react-router) are used under their own
licenses (MIT unless stated otherwise in each package).
