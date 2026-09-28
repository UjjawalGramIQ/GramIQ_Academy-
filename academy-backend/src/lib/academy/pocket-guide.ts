import { prisma } from "../../prisma/client";
import type { Block, Run } from "./blocks";

export interface PocketGuideData {
  moduleId: string;
  moduleNo: number;
  moduleTitle: string;
  lang: "mr" | "en";
  courseTitle: string;
  summaryPoints: {
    sectionNo: string;
    title: string;
    keyTakeaway: string;
  }[];
  keyRules: string[];
  actionSteps: string[];
  printDate: string;
}

function extractTextFromRuns(runs: Run[]): string {
  return (runs || []).map((r) => r.t || "").join("").trim();
}

function extractFirstParagraphText(blocks: unknown[]): string {
  if (!Array.isArray(blocks)) return "";
  for (const b of blocks as Block[]) {
    if (b && b.type === "paragraph" && b.runs?.length) {
      const text = extractTextFromRuns(b.runs);
      if (text.length > 20) return text;
    }
  }
  return "";
}

const DEFAULT_KEY_RULES: Record<"mr" | "en", string[]> = {
  mr: [
    "उत्पादन खर्चाची (Cost of Cultivation) अचूक नोंद ठेवा.",
    "किमान आधारभूत किंमत (MSP) आणि बाजारभाव दररोज तपासा.",
    "मालाची प्रतवारी (Grading) करूनच बाजारात विक्री करा.",
    "कापणीनंतर लगेच विक्री न करता योग्य साठवणुकीचा विचार करा.",
  ],
  en: [
    "Keep strict and accurate records of cost of cultivation.",
    "Monitor Minimum Support Price (MSP) and local APMC mandi arrivals.",
    "Always grade and clean farm produce before market dispatch.",
    "Utilize scientific storage rather than distress-selling immediately.",
  ],
};

const DEFAULT_ACTION_STEPS: Record<"mr" | "en", string[]> = {
  mr: [
    "हंगाम सुरू होताना भांडवल व निविष्ठांचे आर्थिक बजेट तयार करा.",
    "एकत्रित खरेदी व विक्रीसाठी स्थानिक शेतकरी उत्पादक कंपनी (FPO) शी जोडा.",
    "जोखीम कमी करण्यासाठी पीक विम्याचे संरक्षण निश्चित करा.",
  ],
  en: [
    "Prepare an upfront working capital budget for inputs and labour.",
    "Leverage Farmer Producer Organizations (FPOs) for collective bargaining.",
    "Mitigate climate and price risks through timely insurance coverage.",
  ],
};

export async function getPocketGuideForModule(moduleId: string, lang: "mr" | "en" = "mr"): Promise<PocketGuideData | null> {
  const isMr = lang === "mr";
  const printDate = new Date().toLocaleDateString(isMr ? "mr-IN" : "en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const mod = await prisma.module.findUnique({
    where: { id: moduleId },
    include: {
      course: { select: { title: true } },
      sections: {
        orderBy: { position: "asc" },
        include: { content: { where: { lang } } },
      },
    },
  });

  if (!mod) return null;

  const title = mod.title as Record<string, string> | null;
  const courseTitle = mod.course.title as Record<string, string> | null;

  const summaryPoints = mod.sections.map((s, idx) => {
    const content = s.content[0];
    const blocks = (content?.blocks as unknown as Block[]) ?? [];
    const takeaway = content ? extractFirstParagraphText(blocks) : "";
    return {
      sectionNo: `${mod.position}.${idx + 1}`,
      title: content?.title || (isMr ? `विभाग ${idx + 1}` : `Section ${idx + 1}`),
      keyTakeaway: takeaway || (isMr ? "मूलभूत संकल्पना व आर्थिक नियोजन" : "Core concepts and economic planning"),
    };
  });

  return {
    moduleId: mod.id,
    moduleNo: mod.position,
    moduleTitle: title?.[lang] ?? title?.mr ?? `Module ${mod.position}`,
    lang,
    courseTitle: courseTitle?.[lang] ?? courseTitle?.mr ?? "Agri-Economics for Farmers",
    summaryPoints,
    keyRules: DEFAULT_KEY_RULES[lang],
    actionSteps: DEFAULT_ACTION_STEPS[lang],
    printDate,
  };
}
