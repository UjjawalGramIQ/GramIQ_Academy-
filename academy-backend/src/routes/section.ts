/**
 * GET /api/v1/academy/section?id=<uuid>&lang=mr
 *
 * Public. Returns one section's content blocks plus prev/next nav info.
 * Never carries correct_index or any quiz content.
 */
import { Router } from "express";
import { prisma } from "../prisma/client";
import { apiError, apiSuccess } from "../lib/response";
import { asyncHandler } from "../middleware/errorHandler";
import { isAcademyLang, type AcademyLang } from "../lib/academy/lang";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const id = typeof req.query.id === "string" ? req.query.id : null;
    const lang: AcademyLang = isAcademyLang(req.query.lang) ? req.query.lang : "mr";

    if (!id) {
      return apiError(res, "INVALID_PARAMETERS", "Query parameter 'id' is required", 400, null, req);
    }

    const section = await prisma.section.findUnique({
      where: { id },
      include: { module: true, content: { where: { lang } } },
    });

    if (!section || section.module.status !== "published") {
      return apiError(res, "SECTION_NOT_FOUND", `No published section with id "${id}"`, 404, null, req);
    }

    const content = section.content[0];
    if (!content) {
      return apiError(res, "SECTION_CONTENT_MISSING", `Section "${id}" has no ${lang} content`, 404, null, req);
    }

    const siblings = await prisma.section.findMany({
      where: { moduleId: section.moduleId },
      orderBy: { position: "asc" },
      select: { id: true },
    });

    const idx = siblings.findIndex((s) => s.id === section.id);
    const prevSectionId = idx > 0 ? siblings[idx - 1]!.id : null;
    const isLastSection = idx === siblings.length - 1;
    const nextSectionId = !isLastSection ? siblings[idx + 1]!.id : null;

    let nextModuleId: string | null = null;
    if (isLastSection) {
      const nextModule = await prisma.module.findFirst({
        where: { courseId: section.module.courseId, status: "published", position: { gt: section.module.position } },
        orderBy: { position: "asc" },
        select: { id: true },
      });
      nextModuleId = nextModule?.id ?? null;
    }

    const moduleTitle = section.module.title as Record<string, string>;

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    apiSuccess(res, {
      section: {
        id: section.id,
        position: section.position,
        displayNo: section.displayNo,
        title: content.title,
        blocks: content.blocks,
        module: {
          id: section.module.id,
          position: section.module.position,
          title: moduleTitle?.[lang] ?? moduleTitle?.mr ?? "",
        },
      },
      nav: {
        prevSectionId,
        nextSectionId,
        isLastSection,
        moduleId: section.module.id,
        nextModuleId,
      },
    });
  }),
);

export default router;
