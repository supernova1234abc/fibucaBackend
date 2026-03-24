-- CreateTable
CREATE TABLE "UserAuditLog" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" INTEGER,
    "actorName" TEXT,
    "actorRole" TEXT,
    "targetUserId" INTEGER,
    "targetName" TEXT,
    "targetUsername" TEXT,
    "targetEmployeeNumber" TEXT,
    "targetRole" TEXT,
    "details" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAuditLog_type_idx" ON "UserAuditLog"("type");

-- CreateIndex
CREATE INDEX "UserAuditLog_actorId_idx" ON "UserAuditLog"("actorId");

-- CreateIndex
CREATE INDEX "UserAuditLog_targetUserId_idx" ON "UserAuditLog"("targetUserId");

-- CreateIndex
CREATE INDEX "UserAuditLog_createdAt_idx" ON "UserAuditLog"("createdAt");
