/** Application-level replacement for the original academy.claim_device RPC — back-fills device-scoped progress onto a newly authenticated user. */
import { prisma } from "../../prisma/client";

export async function claimDevice(userId: string, deviceId: string): Promise<void> {
  await prisma.$transaction([
    prisma.progress.updateMany({ where: { deviceId, userId: null }, data: { userId } }),
    prisma.progressCursor.updateMany({ where: { deviceId, userId: null }, data: { userId } }),
  ]);
}
