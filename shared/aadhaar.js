// Aadhaar number helpers – run on the server and in the browser.
//
// An Aadhaar number has 12 digits, never starts with 0 or 1, and its last
// digit is a Verhoeff check digit, so most typing mistakes are caught before
// any OTP is requested.

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** Keep digits only ("2345 6789 0123" → "234567890123"). */
export const cleanAadhaar = (v) => String(v ?? '').replace(/\D/g, '');

export function verhoeffValid(num) {
  let c = 0;
  const digits = String(num).split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = D[c][P[i % 8][digits[i]]];
  return c === 0;
}

/** Check digit to append to `partial` (used to make demo numbers). */
export function verhoeffDigit(partial) {
  let c = 0;
  const digits = String(partial).split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = D[c][P[(i + 1) % 8][digits[i]]];
  return INV[c];
}

/** null if valid, otherwise a short reason. */
export function aadhaarProblem(value) {
  const n = cleanAadhaar(value);
  if (n.length !== 12) return 'Aadhaar number must have 12 digits';
  if (/^[01]/.test(n)) return 'Aadhaar number cannot start with 0 or 1';
  if (!verhoeffValid(n)) return 'This is not a valid Aadhaar number – please check the digits';
  return null;
}

/** "XXXX XXXX 1234" – the only form in which an Aadhaar number is ever shown. */
export const maskAadhaar = (value) => `XXXX XXXX ${cleanAadhaar(value).slice(-4)}`;

/** Group digits as they are printed on the card: "2345 6789 0123". */
export const formatAadhaar = (value) => cleanAadhaar(value).slice(0, 12).replace(/(\d{4})(?=\d)/g, '$1 ');
