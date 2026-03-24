-- CreateTable
CREATE TABLE "VotingSession" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "candidates" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "genesisHash" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VotingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoteRecord" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "voterHash" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "blockIndex" INTEGER NOT NULL,
    "prevHash" TEXT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoteRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VotingSession_status_idx" ON "VotingSession"("status");

-- CreateIndex
CREATE INDEX "VotingSession_createdById_idx" ON "VotingSession"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "VoteRecord_sessionId_voterHash_key" ON "VoteRecord"("sessionId", "voterHash");

-- CreateIndex
CREATE INDEX "VoteRecord_sessionId_idx" ON "VoteRecord"("sessionId");

-- CreateIndex
CREATE INDEX "VoteRecord_blockIndex_idx" ON "VoteRecord"("blockIndex");

-- AddForeignKey
ALTER TABLE "VotingSession" ADD CONSTRAINT "VotingSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoteRecord" ADD CONSTRAINT "VoteRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "VotingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
