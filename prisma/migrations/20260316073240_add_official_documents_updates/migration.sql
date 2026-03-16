-- CreateTable
CREATE TABLE "OfficialDocument" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fileUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" INTEGER NOT NULL,

    CONSTRAINT "OfficialDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficialUpdate" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" INTEGER NOT NULL,

    CONSTRAINT "OfficialUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfficialDocument_createdById_idx" ON "OfficialDocument"("createdById");

-- CreateIndex
CREATE INDEX "OfficialDocument_createdAt_idx" ON "OfficialDocument"("createdAt");

-- CreateIndex
CREATE INDEX "OfficialUpdate_createdById_idx" ON "OfficialUpdate"("createdById");

-- CreateIndex
CREATE INDEX "OfficialUpdate_createdAt_idx" ON "OfficialUpdate"("createdAt");

-- AddForeignKey
ALTER TABLE "OfficialDocument" ADD CONSTRAINT "OfficialDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialUpdate" ADD CONSTRAINT "OfficialUpdate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
