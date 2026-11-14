-- One picture follows a person everywhere: a Space without its own picture shows its owner's profile picture.
ALTER TABLE "Channel" ADD COLUMN "avatarFromProfile" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Channel" c
SET "avatarUrl" = p."avatarUrl", "avatarFromProfile" = true
FROM "Profile" p
WHERE p."userId" = c."userId" AND c."avatarUrl" IS NULL AND p."avatarUrl" IS NOT NULL;
