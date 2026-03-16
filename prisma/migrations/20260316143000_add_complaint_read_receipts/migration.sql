ALTER TABLE "Complaint"
ADD COLUMN "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "clientLastReadAt" TIMESTAMP(3),
ADD COLUMN "staffLastReadAt" TIMESTAMP(3);

UPDATE "Complaint"
SET "lastActivityAt" = COALESCE("updatedAt", "createdAt", CURRENT_TIMESTAMP)
WHERE "lastActivityAt" IS NULL;

UPDATE "Complaint"
SET "clientLastReadAt" = COALESCE("createdAt", CURRENT_TIMESTAMP)
WHERE "clientLastReadAt" IS NULL;

CREATE INDEX "Complaint_lastActivityAt_idx" ON "Complaint"("lastActivityAt");
