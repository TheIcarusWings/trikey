// Web and test version: a browser cannot keep a page out of screenshots, so this does nothing.
// `secure-screen.native.ts` is what iOS and Android load (Metro picks it by extension).

/** Keeps the app out of screenshots, recordings and the app switcher's picture while `secure` (where the phone can). */
export function setScreenSecure(_secure: boolean): void {}
