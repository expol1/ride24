# Logo readability correction

Before this correction: b1e9ce41f1cbdc517330fa6161cb02b3b782c7c9, retained as backup/web-logo-sizing-before-2026-10-19.

Restore all pre-change references to the original r.png. The file itself is unchanged. Increase homepage logo width from 84 to 160 CSS pixels on mobile and 220 on desktop. Allow header controls to wrap on narrow screens. Increase small guide footer logos and panel logos; collapsed sidebars show the original compact mark. Shared stylesheet preserves image proportions. Results header can wrap instead of shrinking the logo.

Validation: all logo/stylesheet/icon references resolve; original r.png bytes preserved; git diff --check passes. No browser binary available, so layout has not been visually tested in this environment. Revert this correction commit to undo only these changes.
