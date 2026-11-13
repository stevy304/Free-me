-- Whether "For you" may use what a person watches and likes (on by default; they can turn it off in Settings).
ALTER TABLE "Profile" ADD COLUMN "personalizedRecommendations" BOOLEAN NOT NULL DEFAULT true;
