import { z } from "zod";

/** Operator-supplied EEO / self-ID. Empty string = leave blank; never invent. */
export const sensitiveProfileSchema = z.object({
  /** Multi-select identity boards ("Man", "Woman", …). */
  gender_identity: z.string().default(""),
  /** Binary sex/gender select often labeled just "Gender" ("Male" / "Female"). */
  gender: z.string().default(""),
  race_ethnicity: z.array(z.string()).default([]),
  sexual_orientation: z.string().default(""),
  hispanic_latino: z.string().default(""),
  transgender: z.string().default(""),
  veteran_status: z.string().default(""),
  disability_status: z.string().default(""),
  self_identification_preferences: z.record(z.unknown()).default({}),
});

export type SensitiveProfile = z.infer<typeof sensitiveProfileSchema>;

export function parseSensitiveProfile(data: unknown): SensitiveProfile {
  return sensitiveProfileSchema.parse(data);
}
