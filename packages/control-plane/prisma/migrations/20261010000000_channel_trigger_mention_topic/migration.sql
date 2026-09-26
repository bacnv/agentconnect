-- By mention + reply joins the conversation trigger; a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "ChannelTrigger" ADD VALUE IF NOT EXISTS 'mention_topic';
