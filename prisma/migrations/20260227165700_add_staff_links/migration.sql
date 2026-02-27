-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'STAFF';

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "staffId" INTEGER;

-- CreateTable
CREATE TABLE "StaffLink" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "staffId" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffLink_token_key" ON "StaffLink"("token");

-- CreateIndex
CREATE INDEX "StaffLink_staffId_idx" ON "StaffLink"("staffId");

-- CreateIndex
CREATE INDEX "Submission_staffId_idx" ON "Submission"("staffId");

-- AddForeignKey
ALTER TABLE "StaffLink" ADD CONSTRAINT "StaffLink_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
