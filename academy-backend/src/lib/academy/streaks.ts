import { prisma } from "../../prisma/client";

export interface StreakInfo {
  currentStreak: number;
  recordedToday: boolean;
  totalDays: number;
  lastActiveDate: string | null;
}

function getTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getYesterdayString(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function calculateStreakDays(dates: string[]): { currentStreak: number; recordedToday: boolean } {
  if (!dates.length) {
    return { currentStreak: 0, recordedToday: false };
  }

  const sortedUnique = Array.from(new Set(dates)).sort().reverse();
  const today = getTodayString();
  const yesterday = getYesterdayString();

  const recordedToday = sortedUnique[0] === today;
  let streak = 0;

  const expectedDate = new Date();
  if (!recordedToday) {
    if (sortedUnique[0] !== yesterday) {
      return { currentStreak: 0, recordedToday: false };
    }
    expectedDate.setDate(expectedDate.getDate() - 1);
  }

  for (const dateStr of sortedUnique) {
    const expectedStr = expectedDate.toISOString().slice(0, 10);
    if (dateStr === expectedStr) {
      streak += 1;
      expectedDate.setDate(expectedDate.getDate() - 1);
    } else {
      break;
    }
  }

  return { currentStreak: streak, recordedToday };
}

export async function getStreakForActor(actor: { userId?: string | null; deviceId?: string | null }): Promise<StreakInfo> {
  const { userId, deviceId } = actor;
  if (!userId && !deviceId) {
    return { currentStreak: 0, recordedToday: false, totalDays: 0, lastActiveDate: null };
  }

  const rows = await prisma.streak.findMany({
    where: userId ? { userId } : { deviceId },
    select: { streakDate: true },
    orderBy: { streakDate: "desc" },
  });

  const dates = rows.map((r) => r.streakDate.toISOString().slice(0, 10));
  const { currentStreak, recordedToday } = calculateStreakDays(dates);
  return {
    currentStreak,
    recordedToday,
    totalDays: dates.length,
    lastActiveDate: dates[0] ?? null,
  };
}

export async function recordStreakForActor(actor: { userId?: string | null; deviceId?: string | null }): Promise<StreakInfo> {
  const { userId, deviceId } = actor;
  if (!userId && !deviceId) {
    return { currentStreak: 0, recordedToday: false, totalDays: 0, lastActiveDate: null };
  }

  const today = new Date(getTodayString());

  if (userId) {
    await prisma.streak.upsert({
      where: { userId_streakDate: { userId, streakDate: today } },
      create: { userId, streakDate: today },
      update: {},
    });
  } else if (deviceId) {
    await prisma.streak.upsert({
      where: { deviceId_streakDate: { deviceId, streakDate: today } },
      create: { deviceId, streakDate: today },
      update: {},
    });
  }

  return getStreakForActor(actor);
}
