import crypto from "node:crypto";
import { prisma } from "../../prisma/client";
import { env } from "../../config/env";

export interface CertificateData {
  id: string;
  userId?: string | null;
  deviceId?: string | null;
  courseSlug: string;
  courseTitle: string;
  learnerName: string;
  score: number;
  totalQuestions: number;
  hmacSignature: string;
  issuedAt: string;
  verifyUrl: string;
}

function getCertSecret(): string {
  return env.ACADEMY_JWT_SECRET;
}

export function computeCertHmac(id: string, courseSlug: string, issuedAt: string, learnerName: string): string {
  const secret = getCertSecret();
  const payload = `${id}|${courseSlug}|${issuedAt}|${learnerName}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function issueCertificate({
  userId,
  deviceId,
  courseSlug = "agri-economics",
  courseTitle = "Agri-Economics for Farmers",
  learnerName,
  score = 3,
  totalQuestions = 3,
}: {
  userId?: string | null;
  deviceId?: string | null;
  courseSlug?: string;
  courseTitle?: string;
  learnerName: string;
  score?: number;
  totalQuestions?: number;
}): Promise<CertificateData> {
  const id = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const hmacSignature = computeCertHmac(id, courseSlug, issuedAt, learnerName);
  const verifyUrl = `/academy/certificate/${id}?sig=${hmacSignature}`;

  await prisma.certificate.create({
    data: {
      id,
      userId: userId ?? null,
      deviceId: deviceId ?? null,
      courseSlug,
      learnerName,
      score,
      totalQuestions,
      hmacSignature,
      metadata: { courseTitle },
      issuedAt: new Date(issuedAt),
    },
  });

  return {
    id,
    userId: userId ?? null,
    deviceId: deviceId ?? null,
    courseSlug,
    courseTitle,
    learnerName,
    score,
    totalQuestions,
    hmacSignature,
    issuedAt,
    verifyUrl,
  };
}

export async function verifyCertificate(
  certId: string,
  providedSignature: string,
): Promise<{ valid: boolean; cert: CertificateData | null; error?: string }> {
  const data = await prisma.certificate.findUnique({ where: { id: certId } });
  if (!data) {
    return { valid: false, cert: null, error: "CERTIFICATE_NOT_FOUND" };
  }

  const issuedAtIso = data.issuedAt.toISOString();
  const expectedSig = computeCertHmac(data.id, data.courseSlug, issuedAtIso, data.learnerName);
  const isValid = expectedSig === providedSignature || data.hmacSignature === providedSignature;
  if (!isValid) {
    return { valid: false, cert: null, error: "SIGNATURE_MISMATCH" };
  }

  const cert: CertificateData = {
    id: data.id,
    userId: data.userId,
    deviceId: data.deviceId,
    courseSlug: data.courseSlug,
    courseTitle: (data.metadata as { courseTitle?: string } | null)?.courseTitle || "Agri-Economics for Farmers",
    learnerName: data.learnerName,
    score: data.score,
    totalQuestions: data.totalQuestions,
    hmacSignature: data.hmacSignature,
    issuedAt: issuedAtIso,
    verifyUrl: `/academy/certificate/${data.id}?sig=${data.hmacSignature}`,
  };
  return { valid: true, cert };
}
