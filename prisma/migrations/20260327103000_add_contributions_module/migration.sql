-- CreateEnum
CREATE TYPE "ContributionStatus" AS ENUM ('PAID', 'UNPAID');

-- CreateTable
CREATE TABLE "Contribution" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "dueDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContributionPayment" (
    "id" SERIAL NOT NULL,
    "contributionId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "ContributionStatus" NOT NULL DEFAULT 'UNPAID',
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "recordedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContributionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contribution_createdById_idx" ON "Contribution"("createdById");

-- CreateIndex
CREATE INDEX "Contribution_dueDate_idx" ON "Contribution"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "ContributionPayment_contributionId_userId_key" ON "ContributionPayment"("contributionId", "userId");

-- CreateIndex
CREATE INDEX "ContributionPayment_contributionId_idx" ON "ContributionPayment"("contributionId");

-- CreateIndex
CREATE INDEX "ContributionPayment_userId_idx" ON "ContributionPayment"("userId");

-- CreateIndex
CREATE INDEX "ContributionPayment_status_idx" ON "ContributionPayment"("status");

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionPayment" ADD CONSTRAINT "ContributionPayment_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionPayment" ADD CONSTRAINT "ContributionPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionPayment" ADD CONSTRAINT "ContributionPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
