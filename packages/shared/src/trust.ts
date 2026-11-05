/** Report reasons and limits shared by the API (validation) and the web app (report dialog). */

export const REPORT_REASONS = [
  { code: 'SEXUAL_CONTENT', label: 'Sexual content', hint: 'Nudity or sexual material.' },
  { code: 'CHILD_SAFETY', label: 'Child safety', hint: 'Anything that endangers or sexualises minors.' },
  { code: 'VIOLENT_OR_GRAPHIC', label: 'Violent or graphic content', hint: 'Gore, cruelty or promotion of violence.' },
  { code: 'HATE_OR_HARASSMENT', label: 'Hate or harassment', hint: 'Attacks on people or groups, bullying or threats.' },
  { code: 'DANGEROUS_ACTS', label: 'Harmful or dangerous acts', hint: 'Self-harm, dangerous challenges or instructions to hurt others.' },
  { code: 'MISINFORMATION', label: 'Misleading information', hint: 'False claims that can cause real harm.' },
  { code: 'SPAM_OR_SCAM', label: 'Spam or scam', hint: 'Misleading links, fraud or repetitive content.' },
  { code: 'PRIVACY', label: 'Privacy violation', hint: 'Shares personal information or images of someone without consent.' },
  { code: 'IMPERSONATION', label: 'Impersonation', hint: 'Pretends to be another person or organisation.' },
  { code: 'OTHER', label: 'Something else', hint: 'Tell us what is wrong.' },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]['code'] | 'COPYRIGHT';
export const REPORT_REASON_CODES: string[] = [...REPORT_REASONS.map((r) => r.code), 'COPYRIGHT'];

export const reportReasonLabel = (code: string) => code === 'COPYRIGHT' ? 'Copyright' : REPORT_REASONS.find((r) => r.code === code)?.label ?? code;

export const COMMENT_MAX = 2000;
export const REPORT_DETAILS_MAX = 2000;
export const COLLECTION_TITLE_MAX = 120;
export const COLLECTION_ITEMS_MAX = 5000;

/** A signature counts when it is the signer's full name as typed above it (spacing and case ignored). */
export const signatureMatches = (name: string, signature: string) => {
  const n = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return n(name).length >= 3 && n(name) === n(signature);
};
