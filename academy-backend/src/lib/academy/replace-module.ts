/**
 * Application-level replacement for the original Postgres
 * academy.replace_module RPC — atomically replaces a module's
 * sections/section_content/questions/question_content from the payload
 * produced by docx-parser.ts + quiz-generator.ts. Does NOT touch the
 * module row itself (title/intro/outro/source/parse_report) — the caller
 * upserts that separately.
 */
import { prisma } from "../../prisma/client";
import type { Lang } from "@prisma/client";

interface SectionPayload {
  position: number;
  displayNo: string;
  content: Partial<Record<Lang, { title: string; blocks: unknown }>>;
}

interface QuestionPayload {
  position: number;
  correctIndex: number;
  source?: "ai" | "admin";
  content: Partial<Record<Lang, { prompt: string; options: string[]; explanation?: string | null }>>;
}

export async function replaceModule(
  moduleId: string,
  payload: { sections: SectionPayload[]; questions: QuestionPayload[] },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // CASCADE (onDelete: Cascade on the FK) removes *_content with these.
    await tx.section.deleteMany({ where: { moduleId } });
    await tx.question.deleteMany({ where: { moduleId } });

    for (const section of payload.sections) {
      const created = await tx.section.create({
        data: { moduleId, position: section.position, displayNo: section.displayNo },
      });
      for (const [lang, content] of Object.entries(section.content) as [Lang, { title: string; blocks: unknown }][]) {
        await tx.sectionContent.create({
          data: { sectionId: created.id, lang, title: content.title, blocks: content.blocks as object },
        });
      }
    }

    for (const question of payload.questions) {
      const created = await tx.question.create({
        data: {
          moduleId,
          position: question.position,
          correctIndex: question.correctIndex,
          source: question.source ?? "ai",
        },
      });
      for (const [lang, content] of Object.entries(question.content) as [
        Lang,
        { prompt: string; options: string[]; explanation?: string | null },
      ][]) {
        await tx.questionContent.create({
          data: {
            questionId: created.id,
            lang,
            prompt: content.prompt,
            options: content.options,
            explanation: content.explanation ?? null,
          },
        });
      }
    }

    await tx.module.update({
      where: { id: moduleId },
      data: { sectionCount: payload.sections.length },
    });
  });
}
