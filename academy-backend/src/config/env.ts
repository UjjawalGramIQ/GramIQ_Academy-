import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  ACADEMY_JWT_SECRET: z.string().min(32, "ACADEMY_JWT_SECRET must be at least 32 characters"),
  ACADEMY_JWT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),

  ACADEMY_ADMIN_EMAIL: z.string().optional(),
  ACADEMY_ADMIN_PASSWORD_HASH: z.string().optional(),

  GEMINI_API_KEY: z.string().optional(),

  GCS_PROJECT_ID: z.string().optional(),
  GCS_PUBLIC_BUCKET: z.string().optional(),
  GCS_PRIVATE_BUCKET: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  CORS_ORIGIN: z.string().default("http://localhost:3000"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}

export const env = loadEnv();

export function isAdminAuthConfigured(): boolean {
  return Boolean(env.ACADEMY_ADMIN_EMAIL && env.ACADEMY_ADMIN_PASSWORD_HASH);
}

export function isGeminiConfigured(): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

export function isGcsConfigured(): boolean {
  return Boolean(env.GCS_PROJECT_ID && env.GCS_PUBLIC_BUCKET && env.GCS_PRIVATE_BUCKET);
}
