/**
 * Google Cloud Storage wrapper — replaces the original Supabase Storage
 * buckets. Two buckets: GCS_PUBLIC_BUCKET (course media, publicly
 * readable) and GCS_PRIVATE_BUCKET (admin DOCX source uploads, private —
 * the browser only ever gets a short-lived signed URL to it).
 */
import { Storage } from "@google-cloud/storage";
import { env } from "../../config/env";

const SIGNED_URL_TTL_MS = 15 * 60 * 1000; // 15 minutes

let cachedStorage: Storage | null = null;

function getStorage(): Storage {
  if (!cachedStorage) {
    cachedStorage = new Storage({
      projectId: env.GCS_PROJECT_ID,
      keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
    });
  }
  return cachedStorage;
}

function requireBucket(name: string | undefined, label: string): string {
  if (!name) throw new Error(`${label} is not configured.`);
  return name;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
}

/** Creates a v4 signed URL the browser can PUT a file directly to (bypasses the API's own body-size limits). */
export async function getSignedUploadUrl(
  path: string,
  contentType: string,
): Promise<{ signedUrl: string; bucket: string }> {
  const bucketName = requireBucket(env.GCS_PRIVATE_BUCKET, "GCS_PRIVATE_BUCKET");
  const [signedUrl] = await getStorage()
    .bucket(bucketName)
    .file(path)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + SIGNED_URL_TTL_MS,
      contentType,
    });
  return { signedUrl, bucket: bucketName };
}

/** Creates a v4 signed URL to read a private file (e.g. admin re-downloading a source docx). */
export async function getSignedDownloadUrl(path: string): Promise<string> {
  const bucketName = requireBucket(env.GCS_PRIVATE_BUCKET, "GCS_PRIVATE_BUCKET");
  const [signedUrl] = await getStorage()
    .bucket(bucketName)
    .file(path)
    .getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
  return signedUrl;
}

/** Downloads a private file's bytes directly (used server-side, e.g. to re-zip several module docs). */
export async function downloadPrivateFile(path: string): Promise<Buffer> {
  const bucketName = requireBucket(env.GCS_PRIVATE_BUCKET, "GCS_PRIVATE_BUCKET");
  const [buffer] = await getStorage().bucket(bucketName).file(path).download();
  return buffer;
}

/** Uploads a buffer to the public bucket (course media extracted from docx) and returns its public URL. */
export async function uploadPublicFile(
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const bucketName = requireBucket(env.GCS_PUBLIC_BUCKET, "GCS_PUBLIC_BUCKET");
  const file = getStorage().bucket(bucketName).file(path);
  await file.save(buffer, { contentType, resumable: false });
  return `https://storage.googleapis.com/${bucketName}/${path}`;
}
