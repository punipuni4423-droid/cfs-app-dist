// Count resolved name Unicode code points, including spaces, not visual wrapping.
export const PROGRAMMING_NAME_LIMIT = 50;
export const PROGRAMMING_NAME_WARNING_COLOR = "#dc2626";
export function programmingNameCharacterCount(name: string): number { return Array.from(name).length; }
export function programmingNameWarning(name: string): string | undefined {
  const count = programmingNameCharacterCount(name);
  return count > PROGRAMMING_NAME_LIMIT ? `${count} characters — shorten to ${PROGRAMMING_NAME_LIMIT} or fewer.` : undefined;
}
