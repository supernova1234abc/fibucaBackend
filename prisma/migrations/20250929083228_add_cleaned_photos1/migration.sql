/*
  Warnings:

  - You are about to drop the column `photoUrl` on the `IdCard` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."IdCard" DROP COLUMN "photoUrl",
ADD COLUMN     "cleanPhotoUrl" TEXT,
ADD COLUMN     "rawPhotoUrl" TEXT;
