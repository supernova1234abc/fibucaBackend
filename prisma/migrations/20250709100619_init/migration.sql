-- CreateTable
CREATE TABLE "Submission" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employeeName" TEXT NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "employerName" TEXT NOT NULL,
    "dues" TEXT NOT NULL,
    "witness" TEXT NOT NULL,
    "pdfPath" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
