import { prisma } from "../../prisma/client";

export interface AcademyUserWithHash {
  id: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  role: "learner" | "admin";
  isDemo: boolean;
  passwordHash: string;
}

/** Looks up a user in the users table by email or phone. Returns null if not found — no fallback. */
export async function findUserByIdentifier(identifier: string): Promise<AcademyUserWithHash | null> {
  const clean = identifier.trim();

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: { equals: clean, mode: "insensitive" } }, { phone: clean }],
    },
  });

  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    displayName: user.displayName || (user.role === "admin" ? "Admin" : "Farmer"),
    role: user.role,
    isDemo: user.isDemo,
    passwordHash: user.passwordHash,
  };
}
