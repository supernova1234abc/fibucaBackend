-- AlterTable
ALTER TABLE "Submission" ALTER COLUMN "pdfPath" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ComplaintReply" (
    "id" SERIAL NOT NULL,
    "complaintId" INTEGER NOT NULL,
    "senderId" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplaintReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplaintReply_complaintId_idx" ON "ComplaintReply"("complaintId");

-- CreateIndex
CREATE INDEX "ComplaintReply_senderId_idx" ON "ComplaintReply"("senderId");

-- AddForeignKey
ALTER TABLE "ComplaintReply" ADD CONSTRAINT "ComplaintReply_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintReply" ADD CONSTRAINT "ComplaintReply_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
