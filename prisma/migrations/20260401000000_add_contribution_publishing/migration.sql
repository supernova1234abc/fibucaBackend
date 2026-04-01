-- Add publishing and visibility fields to Contribution table
ALTER TABLE "Contribution" ADD COLUMN "publishedAt" TIMESTAMP(3),
ADD COLUMN "visibleToStaffIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN "startDate" TIMESTAMP(3),
ADD COLUMN "endDate" TIMESTAMP(3);

-- Create index for published contributions
CREATE INDEX "Contribution_publishedAt_idx" ON "Contribution"("publishedAt");
