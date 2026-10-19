# Mobile logo bounds and scrolling

Previous commit: 0bc148b895e46a2ed677e46e1c97f0ac0457529f. Revert this focused commit to roll back.

Measured alpha > 10 bounds of the exact PNG and adjusted CSS crop to width 122%, left -11%; full visible mark fits horizontally and vertically without changing header height or grid layout. Mobile sticky header already uses an opaque gradient: remove its invisible backdrop blur only. Other effects and images are unchanged. Stylesheet cache version incremented.

Validation: numeric visible-alpha bounds fit CSS viewport on both axes. No Firefox/Android device profiling or browser rendering available; improvement in frame rate is not measured or guaranteed.
