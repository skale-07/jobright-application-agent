import { z } from "zod";

export const sensitiveProfileSchema = z.object({
  gender_identity: z.string(),
  race_ethnicity: z.array(z.string()),
  sexual_orientation: z.string(),
  veteran_status: z.string(),
  disability_status: z.string(),
  self_identification_preferences: z.record(z.unknown()),
});

export type SensitiveProfile = z.infer<typeof sensitiveProfileSchema>;

export function parseSensitiveProfile(data: unknown): SensitiveProfile {
  return sensitiveProfileSchema.parse(data);
}
