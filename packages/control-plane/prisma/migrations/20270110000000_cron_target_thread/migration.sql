-- The forum/topic a cron's fire posts INTO, when the platform has such a container.
--
-- A cron's target was (channel, integration) and nothing else, which is complete on Slack: a
-- thread there is a sub-conversation of the channel, so a fire opening its own thread still
-- lands in the right place. On a Telegram forum the thread coordinate IS the topic — posting
-- without it files the trigger under General, a destination the conversation never chose and
-- one its own replies cannot follow, because an inbound message there canonicalizes to the
-- topic id and so opens a session the topic that asked cannot reach.
--
-- Null is correct for every existing row and for every platform whose threads are
-- sub-conversations: the daemon derives its key exactly as before. Only a container is stored.
BEGIN;

ALTER TABLE "cron_def"
  ADD COLUMN "targetThread" TEXT;

COMMIT;
