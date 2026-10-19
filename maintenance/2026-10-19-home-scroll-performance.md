# Homepage mobile scrolling

Baseline/rollback parent: f60c2240cb6aa087334216cefc08d007377c3b3d. Revert this commit to remove the isolated stylesheet and its homepage include.

Mobile only: composite the masked decorative hero image independently; replace the continuously repainted WhatsApp box-shadow pulse with a separate circle animated by transform and opacity. Preserve 54px button, 15px pulse expansion, 2s ease cycle, green gradient, icon and hover behavior. Reduced-motion preferences suppress the decorative pulse. No logo, content, form, booking or image asset changes.

Validation: pulse radius math matches the old shadow at interpolated progress values. No device profiler or local browser binary is available: actual Firefox frame time and pixel equivalence have not been measured. User should compare on the affected phone after reload.
