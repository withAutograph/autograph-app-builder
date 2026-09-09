# Attribution investigation

This run scored **80/100 subjectively**. Its measured adherence score is **100 with only 1.16% evidence coverage**; this is not evidence of complete adherence. The earlier 85-point run assessed different rendered bytes and states and is not an isolated comparison.

The preview contains valid inline CSS source maps with the exact selected Arrusted theme in `sourcesContent`. A focused live CDP inspection confirmed that mappings resolve. However, all 271 matched declarations for the evaluator's measured property set mapped to Tailwind's stylesheet, not authored Arrusted theme declarations. For example, the generated `color: var(--color-text-primary)` utility mapped to Tailwind `index.css`, line 949, column 3.

Authored theme mappings also resolve: the Disclosure caret transform maps to `theme.css`, line 262, column 3. Transform is not an assessed styling category. Adding it merely to increase coverage would change the measurement rather than demonstrate better adherence.

Accordingly, the 5,166 browser styling observations remain unassessed. A Tailwind utility source location alone does not establish whether an Arrusted component or generated code introduced that utility. No attribution credit was manufactured and no denominator was changed.

The remaining visible findings concern severity/label legibility, narrow-desktop Back prominence, and the result-state Reset action below the short-window viewport. Shared palette observations do not authorize palette changes. Improvements should use supported composition and typography APIs; another identical judge run is not a repair.
