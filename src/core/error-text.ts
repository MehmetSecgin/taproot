import { propertyOf } from './object-property.js';
import { nonEmptyOr, textUnlessFalsy } from './text-presence.js';

const UNKNOWN_ERROR_TEXT = 'Unknown error';

export function errorText(input: unknown): string {
  const messageText = textUnlessFalsy(propertyOf(input, 'message'));
  return messageText === '' ? textUnlessFalsy(input) : messageText;
}

export function errorTextOrUnknown(error: unknown): string {
  return nonEmptyOr(errorText(error), UNKNOWN_ERROR_TEXT);
}
