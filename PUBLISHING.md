# Publishing checklist — Duplicate Tab Killer

## Before you upload
- [ ] Test the unpacked extension one more time (Load unpacked → click through).
- [ ] Confirm `manifest.json` version is correct (currently 1.0.0).
- [ ] Host `PRIVACY.md` somewhere public (GitHub Pages, a public Notion page,
      etc.) and copy its URL.
- [ ] Take at least one screenshot of the popup at 1280×800 or 640×400.

## The build
The upload zip is `../duplicate-tab-killer-1.0.0.zip` (sibling of this folder).
Its root contains `manifest.json` directly (not a wrapping folder). It includes:
manifest.json, background.js, popup.html, popup.js, chooser.html, chooser.js,
and the icons/ folder. Docs (*.md) are intentionally excluded.

To rebuild after changes, from inside this folder:
    zip -r ../duplicate-tab-killer-1.0.0.zip \
      manifest.json background.js popup.html popup.js \
      chooser.html chooser.js icons -x "*.DS_Store"

## Submit
1. https://chrome.google.com/webstore/devconsole  → pay one-time $5 if new.
2. New Item → upload the zip.
3. Fill listing from STORE-LISTING.md (short + detailed description, category).
4. Add the screenshot(s) and the 128px store icon.
5. Paste the 5 permission justifications.
6. Privacy tab: paste the privacy policy URL and answer the data questions.
7. Set visibility (Public / Unlisted / Private).
8. Submit for review (typically 1–5 days).

## Most likely rejection reason
Single-purpose policy — this does duplicate-killing + sessions + idle reminders.
The descriptions in STORE-LISTING.md frame all of it as one purpose ("tab
organization and cleanup"); keep that framing if asked to clarify.

## Updates after launch
Bump `version` in manifest.json → rebuild zip → upload new version → re-review.
