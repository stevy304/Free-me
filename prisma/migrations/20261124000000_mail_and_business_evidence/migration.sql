CREATE TABLE "TransactionalMail" (
  "id" TEXT PRIMARY KEY,
  "recipient" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "paragraphs" TEXT[] NOT NULL,
  "actionPath" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3)
);
CREATE INDEX "TransactionalMail_sentAt_dueAt_idx" ON "TransactionalMail"("sentAt", "dueAt");
CREATE TABLE "BusinessCertificate" (
  "advertiserId" TEXT PRIMARY KEY REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "pdf" BYTEA NOT NULL
);
