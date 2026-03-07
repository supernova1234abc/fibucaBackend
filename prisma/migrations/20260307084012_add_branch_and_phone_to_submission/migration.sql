-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'RESOLVED', 'CLOSED');

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "branchName" TEXT,
ADD COLUMN     "phoneNumber" TEXT;

-- CreateTable
CREATE TABLE "Complaint" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferHistory" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "performedById" INTEGER NOT NULL,
    "oldEmployerName" TEXT,
    "newEmployerName" TEXT,
    "oldBranchName" TEXT,
    "newBranchName" TEXT,
    "oldPhoneNumber" TEXT,
    "newPhoneNumber" TEXT,
    "oldEmployeeNumber" TEXT NOT NULL,
    "newEmployeeNumber" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Complaint_userId_idx" ON "Complaint"("userId");

-- CreateIndex
CREATE INDEX "Complaint_status_idx" ON "Complaint"("status");

-- CreateIndex
CREATE INDEX "TransferHistory_userId_idx" ON "TransferHistory"("userId");

-- CreateIndex
CREATE INDEX "TransferHistory_performedById_idx" ON "TransferHistory"("performedById");

-- CreateIndex
CREATE INDEX "TransferHistory_newEmployerName_idx" ON "TransferHistory"("newEmployerName");

-- CreateIndex
CREATE INDEX "TransferHistory_newBranchName_idx" ON "TransferHistory"("newBranchName");

-- CreateIndex
CREATE INDEX "Submission_employerName_idx" ON "Submission"("employerName");

-- CreateIndex
CREATE INDEX "Submission_branchName_idx" ON "Submission"("branchName");

-- CreateIndex
CREATE INDEX "Submission_phoneNumber_idx" ON "Submission"("phoneNumber");

-- CreateIndex
CREATE INDEX "Submission_employeeName_idx" ON "Submission"("employeeName");

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferHistory" ADD CONSTRAINT "TransferHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferHistory" ADD CONSTRAINT "TransferHistory_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
