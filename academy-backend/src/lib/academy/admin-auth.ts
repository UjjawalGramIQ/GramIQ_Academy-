/**
 * Admin credential verification — ported from lib/academy/admin-auth.ts's
 * verifyPassword(), adapted to Prisma. Checks the env-configured single
 * admin credential first (ACADEMY_ADMIN_EMAIL/ACADEMY_ADMIN_PASSWORD_HASH),
 * then falls back to any academy.users row with role='admin'.
 */
import { prisma } from "../../prisma/client";
import { env, isAdminAuthConfigured } from "../../config/env";
import { verifyPasswordAgainstHash } from "./password";

export { isAdminAuthConfigured };

export async function verifyAdminPassword(plain: string, emailOrIdentifier?: string): Promise<boolean> {
  const envStored = env.ACADEMY_ADMIN_PASSWORD_HASH;
  const envEmail = env.ACADEMY_ADMIN_EMAIL;
  const identifierMatchesEnvAdmin =
    envEmail && emailOrIdentifier && emailOrIdentifier.trim().toLowerCase() === envEmail.trim().toLowerCase();
  if (envStored && identifierMatchesEnvAdmin && (await verifyPasswordAgainstHash(plain, envStored))) {
    return true;
  }

  try {
    const clean = emailOrIdentifier?.trim();
    const admins = await prisma.user.findMany({
      where: {
        role: "admin",
        ...(clean
          ? { OR: [{ email: { equals: clean, mode: "insensitive" } }, { phone: clean }] }
          : {}),
      },
      select: { passwordHash: true },
      take: 10,
    });

    for (const row of admins) {
      if (await verifyPasswordAgainstHash(plain, row.passwordHash)) {
        return true;
      }
    }
  } catch {
    // Database unreachable — fail closed, not a bypass.
  }

  return false;
}
