/**
 * Application-level replacement for the original Postgres
 * academy.reorder_modules RPC. The original relied on the
 * (course_id, position) unique constraint being DEFERRABLE INITIALLY
 * DEFERRED so a position swap could happen in one statement without
 * tripping uniqueness mid-transaction. Prisma has no DEFERRABLE support,
 * so this does the same reorder in two passes inside one transaction:
 * first move every affected row to a temporary negative position (which
 * can never collide with a real 0-based position), then set final
 * positions — the uniqueness check never sees a collision at either step.
 */
import { prisma } from "../../prisma/client";

export async function reorderModules(courseId: string, orderedIds: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await Promise.all(
      orderedIds.map((id, index) =>
        tx.module.updateMany({
          where: { id, courseId },
          data: { position: -(index + 1) },
        }),
      ),
    );
    await Promise.all(
      orderedIds.map((id, index) =>
        tx.module.updateMany({
          where: { id, courseId },
          data: { position: index },
        }),
      ),
    );
  });
}
