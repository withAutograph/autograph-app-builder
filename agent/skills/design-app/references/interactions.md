# Prototype interactions

Use this reference when wiring routes and actions and when verifying a material
revision. A prototype must let the user evaluate the visible workflow, not just
its static arrangement. Keep all behavior fixture-backed and in memory. Do not
add network requests, persistence, providers, schemas, auth, security gates, or
production authority.

## Inventory the interaction contract

Inventory every visible control before presenting the revision. For each
control, record:

- the control and where it appears;
- any precondition for enabling it;
- its observable result;
- its cancel or dismissal behavior, when applicable;
- its validation or error behavior; and
- why it is unavailable, when the fixture cannot support it.

Cover primary and secondary buttons, linked rows, navigation items, menus,
dialogs, tabs, filters, selections, forms, and keyboard actions. An enabled
control must produce a meaningful fixture-backed result. Disable unavailable
actions and provide a product-facing reason. Never use no-op handlers, empty
links, dead destinations, or fake success messages.

## Route and state behavior

Register every destination used by a link or navigation control in the preview
manifest. Link to the exact registered hash route expected by the renderer,
preserving the preview's existing base URL. Do not replace the base URL or emit
a path that bypasses the hash router.

Keep the selected navigation item, visible page, URL, and in-memory state in
agreement. Browser Back and Forward must restore the corresponding route and
selection. A direct visit to any registered hash route must render the intended
screen with coherent fixture state. Unknown routes may use the renderer's
documented fallback; visible controls must never intentionally target one.

Use real public component or composition event APIs for links, menus, rows,
dialogs, selection, and forms. Do not place an inert wrapper over a component to
simulate interaction. Shared fixture state should live at the route shell or
other common in-memory owner so related screens show the same facts.

When an action changes data, update every dependent count, total, badge, table,
summary, or selection in the same interaction. Preserve those changes while
the user moves among prototype routes during the current preview session.

## Forms and consequential actions

Forms must accept input, validate required and invalid values, submit through
the public component handler, and expose cancel behavior. A successful submit
must cause a visible fixture change. Validation errors must identify the field
or condition and keep the entered values available for correction. Cancel must
dismiss or return predictably without committing the draft.

Consequential actions remain simulations. Label their prototype result in
product terms without claiming a provider call, durable save, notification, or
approval occurred. Do not add production code or broaden Build or publication
authority to make the prototype feel complete.

Concrete compensation examples:

- **Add employee:** submitting a valid employee adds the row, increments the
  employee total, and makes the new employee available to related selections.
  Cancel leaves the roster and total unchanged. Duplicate or missing required
  values show correctable validation.
- **Create salary band:** submitting valid bounds adds the band to its list and
  updates any coverage count or unassigned-employee summary. Cancel preserves
  the prior bands. An inverted or overlapping range shows a fixture-backed
  validation result rather than a success toast.
- **Submit for approval:** when its fixture preconditions are met, submission
  changes the item to a pending state and updates the relevant queue or badge.
  A cancel or unavailable path leaves the item unchanged and explains what is
  required. Never imply that a real approver was contacted.

## Browser acceptance

Exercise every enabled control in the Browser preview, including secondary
buttons, linked rows, menus, dialog confirm and cancel actions, and keyboard
operation. Do not stop after checking only the primary happy path. Verify:

1. each navigation action reaches its exact registered hash route;
2. Back and Forward restore the expected page and selected navigation state;
3. shared fixture changes and dependent totals remain consistent across routes;
4. forms validate, submit, and cancel with the documented observable results;
5. menus and dialogs open, move focus appropriately, and close by their public
   component behavior, including supported keyboard dismissal;
6. error and unavailable states explain the next useful action; and
7. no enabled control is inert, misleading, or dependent on a live system.

A successful compile, static handler scan, or presence of an `onClick` is not
proof that an interaction works. Behavior proof comes from exercising the
rendered control and observing its result. If Browser acceptance is unavailable
or a control cannot be exercised, report that limitation honestly and do not
claim the material revision is behavior-verified.
