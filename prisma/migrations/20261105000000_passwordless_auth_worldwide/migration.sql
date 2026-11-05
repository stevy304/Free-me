-- Phase 1: passwordless sign-in (Google, email codes), server-side sessions, roles as a set, and worldwide
-- fields (no market-specific defaults). Required columns are added without defaults: no production data exists yet.
-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('SIGN_IN');

-- AlterEnum
BEGIN;
CREATE TYPE "PayoutMethod_new" AS ENUM ('MOBILE_MONEY', 'BANK_TRANSFER', 'CARD', 'DIGITAL_WALLET');
ALTER TABLE "public"."Payout" ALTER COLUMN "method" DROP DEFAULT;
ALTER TABLE "Payout" ALTER COLUMN "method" TYPE "PayoutMethod_new" USING ("method"::text::"PayoutMethod_new");
ALTER TYPE "PayoutMethod" RENAME TO "PayoutMethod_old";
ALTER TYPE "PayoutMethod_new" RENAME TO "PayoutMethod";
DROP TYPE "public"."PayoutMethod_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Video" DROP CONSTRAINT "Video_categoryId_fkey";

-- DropIndex
DROP INDEX "Campaign_targetCountry_idx";

-- DropIndex
DROP INDEX "User_email_idx";

-- DropIndex
DROP INDEX "User_role_idx";

-- AlterTable
ALTER TABLE "AdImpression" ADD COLUMN     "currency" TEXT NOT NULL,
ALTER COLUMN "viewerCountry" DROP NOT NULL,
ALTER COLUMN "viewerCountry" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Advertiser" DROP COLUMN "tinOrRegistrationNumber",
ADD COLUMN     "country" TEXT NOT NULL,
ADD COLUMN     "currency" TEXT NOT NULL,
ADD COLUMN     "registrationNumber" TEXT,
ALTER COLUMN "contactPhone" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "userAgent" TEXT;

-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "targetCountry",
ADD COLUMN     "currency" TEXT NOT NULL,
ADD COLUMN     "targetCountries" TEXT[];

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "country" TEXT,
ADD COLUMN     "defaultLanguage" TEXT;

-- AlterTable
ALTER TABLE "CreatorBalance" ALTER COLUMN "currency" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "provider" TEXT NOT NULL,
ALTER COLUMN "currency" DROP DEFAULT,
ALTER COLUMN "method" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "timezone" TEXT,
ALTER COLUMN "country" DROP NOT NULL,
ALTER COLUMN "country" DROP DEFAULT,
ALTER COLUMN "city" DROP DEFAULT;

-- AlterTable
ALTER TABLE "RevenueLedger" ADD COLUMN     "currency" TEXT NOT NULL,
ADD COLUMN     "splitBps" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "isEmailVerified",
DROP COLUMN "passwordHash",
DROP COLUMN "role",
DROP COLUMN "twoFactorEnabled",
DROP COLUMN "twoFactorSecret",
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "roles" "Role"[] DEFAULT ARRAY['VIEWER']::"Role"[],
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "language" TEXT,
ALTER COLUMN "categoryId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailOtp" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL DEFAULT 'SIGN_IN',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OAuthAccount_userId_idx" ON "OAuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_providerAccountId_key" ON "OAuthAccount"("provider", "providerAccountId");

-- CreateIndex
CREATE INDEX "EmailOtp_email_createdAt_idx" ON "EmailOtp"("email", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOtp_expiresAt_idx" ON "EmailOtp"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Campaign_targetCountries_idx" ON "Campaign" USING GIN ("targetCountries");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

