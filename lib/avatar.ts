/**
 * Initial shown on an avatar with no image.
 *
 * Display names often start with an emoji, a decoration or a quotation mark
 * (`🌸 ana`, `"el rincón"`, `@casa`), and `[0]` can even cut a surrogate pair
 * in half. Take the first **letter or number** instead — iterating code points,
 * so an emoji is one character and is skipped — then the same from the
 * username, and only then `?`.
 */

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

function firstLetterOrNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const char of value) {
    if (LETTER_OR_NUMBER.test(char)) return char.toUpperCase();
  }
  return null;
}

export function avatarInitial(
  displayName: string | null | undefined,
  username: string | null | undefined
): string {
  return firstLetterOrNumber(displayName) ?? firstLetterOrNumber(username) ?? "?";
}
