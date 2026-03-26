-- AlterTable
ALTER TABLE "IdCard"
ADD COLUMN "verificationToken" TEXT,
ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "revokedAt" TIMESTAMP(3),
ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Backfill existing cards with public verification tokens.
UPDATE "IdCard"
SET "verificationToken" = md5(random()::text || clock_timestamp()::text || "id"::text)
WHERE "verificationToken" IS NULL;

-- Enforce token presence after backfill.
ALTER TABLE "IdCard"
ALTER COLUMN "verificationToken" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "IdCard_verificationToken_key" ON "IdCard"("verificationToken");

-- CreateIndex
CREATE INDEX "IdCard_isActive_idx" ON "IdCard"("isActive");