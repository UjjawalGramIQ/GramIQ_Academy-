/**
 * GET /api/v1/academy/course?slug=agri-economics&lang=mr
 *
 * Public. Returns the published course tree (modules + section list, no
 * block content). Never carries quiz content of any kind.
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
    const slug = typeof req.query.slug === "string" ? req.query.slug : null;
    const lang: AcademyLang = isAcademyLang(req.query.lang) ? req.query.lang : "mr";

    if (!slug) {
      return apiError(res, "INVALID_PARAMETERS", "Query parameter 'slug' is required", 400, null, req);
    }

    const course = await prisma.course.findFirst({
      where: { slug, isPublished: true },
    });

    if (!course) {
      return apiError(res, "COURSE_NOT_FOUND", `No published course with slug "${slug}"`, 404, null, req);
    }

    const modules = await prisma.module.findMany({
      where: { courseId: course.id, status: "published" },
      orderBy: { position: "asc" },
      include: {
        sections: {
          orderBy: { position: "asc" },
          include: { content: { where: { lang }, select: { title: true } } },
        },
      },
    });

    const responseModules = modules.map((m) => {
      const title = m.title as Record<string, string>;
      return {
        id: m.id,
        position: m.position,
        title: title?.[lang] ?? title?.mr ?? "",
        sectionCount: m.sectionCount,
        sections: m.sections.map((s) => ({
          id: s.id,
          position: s.position,
          displayNo: s.displayNo,
          title: s.content[0]?.title ?? "",
        })),
      };
    });

    const courseTitle = course.title as Record<string, string>;
    const subtitle = course.subtitle as Record<string, string> | null;
    const heroBullets = course.heroBullets as Record<string, string[]> | null;

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    apiSuccess(res, {
      course: {
        id: course.id,
        slug: course.slug,
        title: courseTitle?.[lang] ?? courseTitle?.mr ?? "",
        subtitle: subtitle?.[lang] ?? subtitle?.mr ?? null,
        heroBullets: heroBullets?.[lang] ?? heroBullets?.mr ?? [],
        heroImageUrl: course.heroImageUrl,
        defaultLang: course.defaultLang,
        estimatedMinutes: course.estimatedMinutes,
      },
      modules: responseModules,
    });
  }),
);

export default router;
