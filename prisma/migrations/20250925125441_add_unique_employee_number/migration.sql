/*
  Warnings:

  - A unique constraint covering the columns `[employeeNumber]` on the table `Submission` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Submission_employeeNumber_key" ON "public"."Submission"("employeeNumber");
