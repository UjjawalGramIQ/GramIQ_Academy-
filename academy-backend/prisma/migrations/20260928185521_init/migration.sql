-- CreateEnum
CREATE TYPE "module_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "lang" AS ENUM ('mr', 'en');

-- CreateEnum
CREATE TYPE "question_source" AS ENUM ('ai', 'admin');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('learner', 'admin');

-- CreateEnum
CREATE TYPE "progress_kind" AS ENUM ('section', 'quiz');

-- CreateEnum
CREATE TYPE "progress_status" AS ENUM ('in_progress', 'completed');

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" JSONB NOT NULL,
    "subtitle" JSONB,
    "hero_bullets" JSONB,
    "hero_image_url" TEXT,
    "default_lang" "lang" NOT NULL DEFAULT 'mr',
    "estimated_minutes" INTEGER,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modules" (
    "id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "module_status" NOT NULL DEFAULT 'draft',
    "title" JSONB NOT NULL,
    "intro_blocks" JSONB,
    "outro_blocks" JSONB,
    "source" JSONB NOT NULL DEFAULT '{}',
    "parse_report" JSONB,
    "section_count" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "display_no" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_content" (
    "section_id" UUID NOT NULL,
    "lang" "lang" NOT NULL,
    "title" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,

    CONSTRAINT "section_content_pkey" PRIMARY KEY ("section_id","lang")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "correct_index" SMALLINT NOT NULL,
    "source" "question_source" NOT NULL DEFAULT 'ai',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_content" (
    "question_id" UUID NOT NULL,
    "lang" "lang" NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" TEXT[],
    "explanation" TEXT,

    CONSTRAINT "question_content_pkey" PRIMARY KEY ("question_id","lang")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'learner',
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "college_name" TEXT,
    "community_engagement_internship_credits" DECIMAL(65,30),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress" (
    "id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "user_id" UUID,
    "course_id" UUID NOT NULL,
    "section_id" UUID,
    "module_id" UUID,
    "kind" "progress_kind" NOT NULL DEFAULT 'section',
    "status" "progress_status" NOT NULL DEFAULT 'in_progress',
    "answers" INTEGER[],
    "score" SMALLINT,
    "time_spent_seconds" INTEGER,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_cursor" (
    "device_id" TEXT NOT NULL,
    "user_id" UUID,
    "course_id" UUID,
    "module_id" UUID,
    "section_id" UUID,
    "lang" "lang" NOT NULL DEFAULT 'mr',
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "progress_cursor_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "streaks" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "device_id" TEXT,
    "streak_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "streaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "device_id" TEXT,
    "course_slug" TEXT NOT NULL,
    "learner_name" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "total_questions" INTEGER NOT NULL DEFAULT 0,
    "hmac_signature" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "courses_slug_key" ON "courses"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "uq_academy_modules_position" ON "modules"("course_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "uq_academy_sections_position" ON "sections"("module_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "uq_academy_questions_position" ON "questions"("module_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "idx_academy_users_role" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "uq_academy_progress_section" ON "progress"("device_id", "section_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_academy_progress_module_quiz" ON "progress"("device_id", "module_id", "kind");

-- CreateIndex
CREATE INDEX "idx_academy_streaks_date" ON "streaks"("streak_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_academy_streaks_user" ON "streaks"("user_id", "streak_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_academy_streaks_device" ON "streaks"("device_id", "streak_date");

-- CreateIndex
CREATE INDEX "idx_academy_certificates_device_id" ON "certificates"("device_id");

-- CreateIndex
CREATE INDEX "idx_academy_certificates_course_slug" ON "certificates"("course_slug");

-- AddForeignKey
ALTER TABLE "modules" ADD CONSTRAINT "modules_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_content" ADD CONSTRAINT "section_content_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_content" ADD CONSTRAINT "question_content_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress" ADD CONSTRAINT "progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress" ADD CONSTRAINT "progress_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress" ADD CONSTRAINT "progress_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress" ADD CONSTRAINT "progress_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_cursor" ADD CONSTRAINT "progress_cursor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_cursor" ADD CONSTRAINT "progress_cursor_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_cursor" ADD CONSTRAINT "progress_cursor_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_cursor" ADD CONSTRAINT "progress_cursor_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streaks" ADD CONSTRAINT "streaks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
