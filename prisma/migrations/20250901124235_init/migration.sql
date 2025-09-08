-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CLIENT', 'ADMIN', 'SUPERADMIN');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "password" TEXT NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'CLIENT',
    "firstLogin" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" SERIAL NOT NULL,
    "employeeName" TEXT NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "employerName" TEXT NOT NULL,
    "dues" TEXT NOT NULL,
    "witness" TEXT NOT NULL,
    "pdfPath" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdCard" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "fullName" TEXT NOT NULL,
    "photoUrl" TEXT,
    "company" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cardNumber" TEXT NOT NULL,

    CONSTRAINT "IdCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeNumber_key" ON "User"("employeeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "IdCard_cardNumber_key" ON "IdCard"("cardNumber");

-- AddForeignKey
ALTER TABLE "IdCard" ADD CONSTRAINT "IdCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
