-- AlterTable
ALTER TABLE "VoteRecord"
ADD COLUMN "positionKey" TEXT NOT NULL DEFAULT 'default';

-- DropIndex
DROP INDEX IF EXISTS "VoteRecord_sessionId_voterHash_key";

-- CreateIndex
CREATE INDEX "VoteRecord_positionKey_idx" ON "VoteRecord"("positionKey");

-- CreateIndex
CREATE UNIQUE INDEX "VoteRecord_sessionId_voterHash_positionKey_key" ON "VoteRecord"("sessionId", "voterHash", "positionKey");
