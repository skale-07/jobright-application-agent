import { z } from "zod";

export const publicProfileSchema = z.object({
  legal_name: z.object({
    first: z.string(),
    middle: z.string().optional().default(""),
    last: z.string(),
  }),
  preferred_name: z.string().optional().default(""),
  email: z.string().email().or(z.literal("")).or(z.string()),
  phone: z.string().optional().default(""),
  address: z
    .object({
      line1: z.string().optional().default(""),
      line2: z.string().optional().default(""),
      city: z.string().optional().default(""),
      state: z.string().optional().default(""),
      postal_code: z.string().optional().default(""),
      country: z.string().optional().default("United States"),
    })
    .optional(),
  school: z.string().optional().default(""),
  degree: z.string().optional().default(""),
  major: z.string().optional().default(""),
  additional_fields_of_study: z.array(z.string()).optional().default([]),
  graduation_month: z.string().optional().default(""),
  graduation_year: z.union([z.number(), z.string(), z.null()]).optional(),
  /** Education start (optional; empty = field skipped, never invented). */
  start_month: z.string().optional().default(""),
  start_year: z.union([z.number(), z.string(), z.null()]).optional(),
  gpa: z.union([z.number(), z.string(), z.null()]).optional(),
  linkedin_url: z.string().optional().default(""),
  github_url: z.string().optional().default(""),
  personal_website: z.string().optional().default(""),
  work_authorization: z.string().optional().default(""),
  requires_sponsorship: z.union([z.string(), z.boolean()]).optional().default(""),
  relocation: z.string().optional().default(""),
  /** "How did you hear about this job?" — operator fact, not invented. */
  how_heard: z.string().optional().default(""),
  /**
   * Restrictive covenants / non-compete yes-no. Empty = leave blank;
   * never invent "No" for applicants who might be bound.
   */
  restrictive_covenants: z.string().optional().default(""),
  employment_history: z.array(z.unknown()).optional().default([]),
  education_history: z.array(z.unknown()).optional().default([]),
});

export type PublicProfile = z.infer<typeof publicProfileSchema>;

export function parsePublicProfile(data: unknown): PublicProfile {
  return publicProfileSchema.parse(data);
}

/** Resolve dotted canonical keys like legal_name.first from the profile. */
export function getProfileValue(
  profile: PublicProfile,
  canonical: string,
): unknown {
  if (canonical === "legal_name.first") return profile.legal_name.first;
  if (canonical === "legal_name.last") return profile.legal_name.last;
  if (canonical === "legal_name.middle") return profile.legal_name.middle ?? "";
  if (canonical === "email") return profile.email;
  if (canonical === "phone") return profile.phone;
  if (canonical === "school") return profile.school;
  if (canonical === "degree") return profile.degree;
  if (canonical === "major") return profile.major;
  if (canonical === "graduation_year") return profile.graduation_year;
  if (canonical === "graduation_month") return profile.graduation_month;
  if (canonical === "start_year") return profile.start_year;
  if (canonical === "start_month") return profile.start_month;
  if (canonical === "gpa") return profile.gpa;
  if (canonical === "linkedin_url") return profile.linkedin_url;
  if (canonical === "github_url") return profile.github_url;
  if (canonical === "personal_website") return profile.personal_website;
  if (canonical === "work_authorization") return profile.work_authorization;
  if (canonical === "requires_sponsorship") return profile.requires_sponsorship;
  if (canonical === "relocation") return profile.relocation;
  if (canonical === "how_heard") return profile.how_heard;
  if (canonical === "restrictive_covenants") return profile.restrictive_covenants;
  if (canonical === "preferred_name") return profile.preferred_name;

  const parts = canonical.split(".");
  let cur: unknown = profile;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
