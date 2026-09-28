/**
 * GramIQ Academy v5 — Phase 2: MCQ option generation for the author's
 * Review Questions.
 *
 * The course docx carries 3 genuine open-ended review questions per module
 * (see docx-parser.ts's extractReviewQuestions), authored independently in
 * English and Marathi. Requirement 9 needs multiple-choice questions, so
 * Gemini converts each open question into 4 options + an answer key + a
 * one-sentence explanation — it does NOT invent new questions, and it never
 * publishes anything on its own: every generated set carries `source: "ai"`
 * and is reviewed/edited by the admin before a module can publish (see the
 * Phase 3 publish-guard trigger).
 *
 * Must go through the circuit breaker (geminiManager.executeWithRetry) —
 * never a static-key GoogleGenerativeAI client, per .agents/AGENTS.md's
 * Gemini Key Manager Circuit Breaker Protocol.
 *
 * Options are generated ONCE in English, then translated into Marathi,
 * rather than generated independently per language. Two independent
 * generations could disagree on which option is correct — with a shared
 * generation pass, `correctIndex` is identical by construction, matching
 * the language-neutral `academy.questions.correct_index` column Phase 3
 * will use specifically so a cross-language answer-key mismatch can never
 * be persisted.
 */
import { z } from "zod";
import { geminiManager } from "../gemini/client";
import { extractJSON } from "../gemini/gemini-executor";
import type { ParsedReviewQuestion } from "./blocks";
import { buildGroundingText } from "./grounding";

export { buildGroundingText };

// Ordered by confirmed availability against this project's key pool, not by
// recency — "gemini-3.7-flash" (this repo's usual first choice) returned a
// transient 503 across all keys during testing, while these two responded
// reliably. Kept short (structured-JSON MCQ generation doesn't need the
// full PREFERRED_MODELS cascade) so a bad model name fails fast per key
// rather than burning the whole attempt budget on it before moving on.
const QUIZ_MODEL_CASCADE = ["gemini-2.5-flash", "gemini-3.5-flash-lite"];

const GeneratedOptionsSchema = z.object({
  options: z.array(z.string().trim().min(1).max(200)).length(4),
  correctIndex: z.number().int().min(0).max(3),
  explanation: z.string().trim().min(1).max(400),
});
type GeneratedOptions = z.infer<typeof GeneratedOptionsSchema>;

const TranslatedOptionsSchema = z.object({
  options: z.array(z.string().trim().min(1).max(200)).length(4),
  explanation: z.string().trim().min(1).max(400),
});

export interface GeneratedQuestion {
  position: number;
  promptEn: string;
  promptMr: string;
  optionsEn: string[];
  optionsMr: string[];
  correctIndex: number;
  explanationEn: string;
  explanationMr: string;
  /** Always "ai" today — carried through to the DB row so the admin UI can flag ungenerated/unreviewed content. */
  source: "ai";
}

export interface QuizGenerationError {
  position: number;
  message: string;
}

export interface QuizGenerationResult {
  questions: GeneratedQuestion[];
  errors: QuizGenerationError[];
}

async function generateEnglishOptions(
  moduleTitle: string,
  questionPrompt: string,
  groundingText: string,
): Promise<GeneratedOptions> {
  const systemInstruction = [
    "You write multiple-choice quiz questions for an agricultural economics course aimed at Indian smallholder farmers.",
    "You are given ONE open-ended review question that a human course author already wrote, plus the course text it is based on.",
    "Convert it into a 4-option multiple-choice question. Do not change the meaning of the question.",
    "Exactly one option must be unambiguously correct according to the course text. The other three must be plausible but clearly wrong to someone who read the text.",
    "Keep every option under 20 words. Keep the explanation to one short sentence, in plain language a farmer with no formal economics training can follow.",
    'Respond with ONLY a JSON object: {"options": ["...","...","...","..."], "correctIndex": 0, "explanation": "..."}',
  ].join(" ");

  const prompt = [
    `Course module: ${moduleTitle}`,
    `Course text (for grounding — the correct answer and distractors must be consistent with this):`,
    groundingText,
    ``,
    `Review question to convert: ${questionPrompt}`,
  ].join("\n");

  let lastError: unknown;
  for (const modelName of QUIZ_MODEL_CASCADE) {
    try {
      const result = await geminiManager.executeWithRetry(async (aiClient) => {
        const model = aiClient.getGenerativeModel({
          model: modelName,
          systemInstruction,
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.3,
            maxOutputTokens: 1024,
          },
        });
        return model.generateContent(prompt);
      });
      const rawText = result.response.text();
      const extracted = extractJSON(rawText);
      const parsed = GeneratedOptionsSchema.safeParse(extracted);
      if (!parsed.success) {
        lastError = new Error(`Model output failed schema validation: ${parsed.error.message}`);
        continue;
      }
      return parsed.data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Quiz option generation failed on every model in the cascade.");
}

async function translateOptionsToMarathi(
  optionsEn: string[],
  explanationEn: string,
  questionPromptMr: string,
): Promise<z.infer<typeof TranslatedOptionsSchema>> {
  const systemInstruction = [
    "You translate multiple-choice quiz options and their explanation from English to Marathi, for Indian smallholder farmers.",
    "Use simple, conversational Marathi — the same register as a farmer-facing course, not formal/literary Marathi.",
    "Preserve the exact order of the options and their meaning. Do not add or remove options.",
    'Respond with ONLY a JSON object: {"options": ["...","...","...","..."], "explanation": "..."}',
  ].join(" ");

  const prompt = [
    `The Marathi version of the question these options answer (for terminology consistency): ${questionPromptMr}`,
    `English options to translate, in order:`,
    ...optionsEn.map((o, i) => `${i + 1}. ${o}`),
    `English explanation to translate: ${explanationEn}`,
  ].join("\n");

  let lastError: unknown;
  for (const modelName of QUIZ_MODEL_CASCADE) {
    try {
      const result = await geminiManager.executeWithRetry(async (aiClient) => {
        const model = aiClient.getGenerativeModel({
          model: modelName,
          systemInstruction,
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
            maxOutputTokens: 1024,
          },
        });
        return model.generateContent(prompt);
      });
      const rawText = result.response.text();
      const extracted = extractJSON(rawText);
      const parsed = TranslatedOptionsSchema.safeParse(extracted);
      if (!parsed.success) {
        lastError = new Error(`Translation output failed schema validation: ${parsed.error.message}`);
        continue;
      }
      return parsed.data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Option translation failed on every model in the cascade.");
}

/**
 * Generates MCQ options for every review question in a module. Failures are
 * per-question — one bad Gemini response does not abort the other two
 * questions' generation, matching the "a malformed response fails that
 * question, not the upload" rule.
 */
export async function generateModuleQuiz(params: {
  moduleTitleEn: string;
  questionsEn: ParsedReviewQuestion[];
  questionsMr: ParsedReviewQuestion[];
  groundingTextEn: string;
}): Promise<QuizGenerationResult> {
  const { moduleTitleEn, questionsEn, questionsMr, groundingTextEn } = params;
  const questions: GeneratedQuestion[] = [];
  const errors: QuizGenerationError[] = [];

  for (const qEn of questionsEn) {
    const qMr = questionsMr.find((q) => q.position === qEn.position);
    if (!qMr) {
      errors.push({ position: qEn.position, message: `No Marathi review question found at position ${qEn.position}` });
      continue;
    }
    try {
      const generated = await generateEnglishOptions(moduleTitleEn, qEn.prompt, groundingTextEn);
      const translated = await translateOptionsToMarathi(generated.options, generated.explanation, qMr.prompt);
      questions.push({
        position: qEn.position,
        promptEn: qEn.prompt,
        promptMr: qMr.prompt,
        optionsEn: generated.options,
        optionsMr: translated.options,
        correctIndex: generated.correctIndex,
        explanationEn: generated.explanation,
        explanationMr: translated.explanation,
        source: "ai",
      });
    } catch (err) {
      errors.push({
        position: qEn.position,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { questions, errors };
}
