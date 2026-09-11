# UI preview review experiences

App Builder currently uses a **pure product preview**. The integrated Browser
renders only the fixture-backed product UI compiled from the accepted Arrusted
component catalog. The synchronized design manifest remains internal so
assumptions, questions, fixture facts, and production meaning can improve the
UI without turning the preview into an implementation-planning surface.

This is the selected default because it gives the clearest fidelity signal and
keeps App Builder's public conversation product-facing. Context, draft
functionality, implementation plans, receipts, and validation state must not be
injected into the preview document.

Two alternatives are documented for future product research, but are not
implemented:

1. **Optional review shell.** A separate review mode could let the user switch
   between the pure UI, visible assumptions, and draft behavior. The product UI
   would remain the default and its rendered asset would stay unchanged.
2. **Persistent three-view workbench.** Context, Prototype, and Draft spec could
   always appear as peer tabs. This makes decision state highly visible, but it
   also weakens direct visual comparison with production Arrusted apps and
   exposes internal planning material earlier than the current finalization
   boundary permits.

Either alternative requires a separate product decision, public contract
review, accessibility design, and eval coverage. It must not be introduced as
a renderer wrapper or inferred from the presence of internal manifest data.
