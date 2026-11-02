-- CommentFlow initial schema

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

-- id is sha256(session token); the raw token only lives in the cookie.
CREATE TABLE sessions (
  id          text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id);

CREATE TABLE workspace_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin','member')),
  token_hash   text NOT NULL UNIQUE,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_invites_ws ON workspace_invites (workspace_id);

-- Instagram professional accounts. ig_user_id is the professional account id
-- (the `user_id` from /me), which is what webhooks put in entry.id.
CREATE TABLE ig_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ig_user_id          text NOT NULL,
  username            text NOT NULL,
  name                text,
  profile_picture_url text,
  access_token_enc    text,            -- AES-256-GCM, never returned by the API
  token_expires_at    timestamptz,
  token_refreshed_at  timestamptz,
  is_demo             boolean NOT NULL DEFAULT false,
  webhook_subscribed  boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','token_expired','disconnected')),
  status_detail       text,
  connected_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ig_accounts_ig_user ON ig_accounts (ig_user_id);
CREATE INDEX ig_accounts_ws ON ig_accounts (workspace_id);

CREATE TABLE campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ig_account_id         uuid NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  trigger_comments      boolean NOT NULL DEFAULT true,
  trigger_dms           boolean NOT NULL DEFAULT false,
  trigger_story_replies boolean NOT NULL DEFAULT false,
  post_scope            text NOT NULL DEFAULT 'any' CHECK (post_scope IN ('any','specific')),
  post_ids              text[] NOT NULL DEFAULT '{}',
  keywords              text[] NOT NULL DEFAULT '{}',
  match_mode            text NOT NULL DEFAULT 'whole_word' CHECK (match_mode IN ('whole_word','contains','any_message')),
  dm_message            text NOT NULL,
  public_reply_enabled  boolean NOT NULL DEFAULT false,
  public_replies        text[] NOT NULL DEFAULT '{}',
  cooldown_hours        integer NOT NULL DEFAULT 0 CHECK (cooldown_hours >= 0),
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_ws ON campaigns (workspace_id);
CREATE INDEX campaigns_account ON campaigns (ig_account_id) WHERE status = 'active';

CREATE TABLE tracked_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  slug            text NOT NULL UNIQUE,
  destination_url text NOT NULL,
  button_label    text,
  position        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, position)
);

CREATE TABLE link_clicks (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tracked_link_id uuid NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
  recipient_hash  text,
  ip_hash         text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX link_clicks_campaign ON link_clicks (campaign_id, created_at);

-- Raw webhook deliveries. body_sha256 makes Meta's at-least-once redelivery
-- of an identical body a no-op.
CREATE TABLE webhook_deliveries (
  id          bigserial PRIMARY KEY,
  body_sha256 text NOT NULL UNIQUE,
  payload     jsonb NOT NULL,
  event_count integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Normalized trigger events. The unique key dedupes the same comment/message
-- arriving in different deliveries (retries, batching differences).
CREATE TABLE inbound_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ig_account_id   uuid NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('comment','dm','story_reply')),
  external_id     text NOT NULL,
  sender_id       text NOT NULL,
  sender_username text,
  text            text NOT NULL DEFAULT '',
  media_id        text,
  original_media_id text,
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  enqueued_at     timestamptz,
  processed_at    timestamptz,
  UNIQUE (ig_account_id, kind, external_id)
);
CREATE INDEX inbound_events_unenqueued ON inbound_events (received_at) WHERE enqueued_at IS NULL;

-- Tracks the 24-hour standard messaging window per (account, user).
CREATE TABLE conversations (
  ig_account_id   uuid NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  igsid           text NOT NULL,
  username        text,
  last_inbound_at timestamptz NOT NULL,
  PRIMARY KEY (ig_account_id, igsid)
);

-- One row per (campaign, triggering event). The DM leg and the public reply
-- leg have independent state machines:
--   pending -> sending -> sent | failed | unconfirmed ; or skipped
-- 'sending' is an atomic claim taken before the Graph API call. A crash or an
-- ambiguous API answer leaves it as 'unconfirmed' rather than retrying, because
-- a duplicate DM is worse than a missing one.
CREATE TABLE message_logs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id          uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  ig_account_id        uuid NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  inbound_event_id     uuid NOT NULL REFERENCES inbound_events(id) ON DELETE CASCADE,
  trigger_kind         text NOT NULL,
  recipient_id         text NOT NULL,
  recipient_username   text,
  trigger_text         text NOT NULL,
  matched_keyword      text,
  dm_status            text NOT NULL DEFAULT 'pending'
                        CHECK (dm_status IN ('pending','sending','sent','failed','unconfirmed','skipped')),
  skip_reason          text,
  dm_text              text,
  dm_message_id        text,
  attempts             integer NOT NULL DEFAULT 0,
  error                text,
  public_reply_status  text NOT NULL DEFAULT 'none'
                        CHECK (public_reply_status IN ('none','pending','sending','sent','failed','unconfirmed')),
  public_reply_text    text,
  public_reply_error   text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, inbound_event_id)
);
CREATE INDEX message_logs_ws_created ON message_logs (workspace_id, created_at DESC);
CREATE INDEX message_logs_campaign ON message_logs (campaign_id, created_at);
CREATE INDEX message_logs_recipient ON message_logs (campaign_id, recipient_id, sent_at);
-- Meta allows exactly ONE private reply per comment, across every campaign.
CREATE UNIQUE INDEX message_logs_one_private_reply
  ON message_logs (inbound_event_id)
  WHERE trigger_kind = 'comment' AND dm_status IN ('sending','sent','unconfirmed');

-- What demo-mode accounts "sent". Never used for real accounts.
CREATE TABLE demo_outbox (
  id            bigserial PRIMARY KEY,
  ig_account_id uuid NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  recipient     text NOT NULL,
  body          jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_events (
  id         bigserial PRIMARY KEY,
  level      text NOT NULL CHECK (level IN ('info','warning','error')),
  source     text NOT NULL,
  message    text NOT NULL,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_events_created ON system_events (created_at DESC);
