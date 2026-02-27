/*
  Warnings:

  - Made the column `expiresAt` on table `StaffLink` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "StaffLink" ADD COLUMN     "maxUses" INTEGER,
ADD COLUMN     "usedCount" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "expiresAt" SET NOT NULL;
