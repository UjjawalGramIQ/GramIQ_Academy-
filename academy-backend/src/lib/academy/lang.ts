export type AcademyLang = "mr" | "en";

export function isAcademyLang(value: unknown): value is AcademyLang {
  return value === "mr" || value === "en";
}
