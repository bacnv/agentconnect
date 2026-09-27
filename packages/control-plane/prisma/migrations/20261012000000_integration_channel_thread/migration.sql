-- A Telegram forum topic's own trigger. NULL `trigger` = inherit the enclosing group's,
-- which is what every topic starts on and what clearing it returns the topic to — so the
-- column is nullable rather than defaulted, and no `triggerChosen` is needed: there is no
-- default a human did not choose.
--
-- The composite FK is the point: a topic must not outlive the group it belongs to, and
-- `replaceSnapshot` deletes the channel rows a bot has left. Nothing deletes a thread row
-- on its own — Telegram reports no topic deletion, so a quiet topic and a dropped one are
-- indistinguishable, and a tombstone would have to be permanent.
BEGIN;

CREATE TABLE "public"."integration_channel_thread" (
    "integrationId" UUID NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "name" TEXT,
    "trigger" "public"."ChannelTrigger",
    "firstSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_channel_thread_pkey" PRIMARY KEY ("integrationId","channelId","threadId")
);

ALTER TABLE "public"."integration_channel_thread"
  ADD CONSTRAINT "integration_channel_thread_integrationId_channelId_fkey"
  FOREIGN KEY ("integrationId", "channelId")
  REFERENCES "public"."integration_channel"("integrationId", "channelId")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
