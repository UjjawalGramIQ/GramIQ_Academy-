/**
 * Application-level replacement for the original Postgres
 * academy.module_publish_guard BEFORE UPDATE trigger — Prisma has no
 * trigger equivalent, so this check runs in the publish route handler
 * instead, with the exact same rule: every section needs content in both
 * languages, and (module 0 / front matter excepted) exactly 3 questions,
 * each with content in both languages.
 */
import { prisma } from "../../prisma/client";

export class PublishGuardError extends Error {}

export async function assertPublishable(moduleId: string): Promise<void> {
  const mod = await prisma.module.findUnique({
    where: { id: moduleId },
    select: { id: true, position: true },
  });
  if (!mod) throw new PublishGuardError(`No module with id "${moduleId}"`);

  const sectionCount = await prisma.section.count({ where: { moduleId } });
  if (sectionCount === 0) {
    throw new PublishGuardError(`Cannot publish a module with no sections`);
  }

  const sectionContentCount = await prisma.sectionContent.count({
    where: { section: { moduleId } },
  });
  if (sectionContentCount !== sectionCount * 2) {
    throw new PublishGuardError(
      `Every section needs content in both mr and en to publish (sections=${sectionCount}, content rows=${sectionContentCount})`,
    );
  }

  // Module 0 (front matter) has no Review Questions trailer and is exempt.
  if (mod.position > 0) {
    const questionCount = await prisma.question.count({ where: { moduleId } });
    if (questionCount !== 3) {
      throw new PublishGuardError(`Exactly 3 review questions are required to publish, found ${questionCount}`);
    }

    const questionContentCount = await prisma.questionContent.count({
      where: { question: { moduleId } },
    });
    if (questionContentCount !== questionCount * 2) {
      throw new PublishGuardError(`Every question needs content in both mr and en to publish`);
    }
  }
}
