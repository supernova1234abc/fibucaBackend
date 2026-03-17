-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "userDeletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Submission_deletedAt_idx" ON "Submission"("deletedAt");

-- CreateIndex
CREATE INDEX "Submission_userDeletedAt_idx" ON "Submission"("userDeletedAt");
