# CFS Switch Row Delete and Table Viewport Update - 2026-07-07

## Summary

- Switch tab now separates row-level deletion and switch-level operations into separate columns.
- The Row column minus icon deletes only the selected Function row.
- The Switch column copy/trash icons are row-spanned per switch group and vertically centered.
- The trash icon deletes the whole Switch / CCI / Palladiom / Pico / PIR group.
- Copy Switch remains a whole-switch copy operation.
- The last remaining Function row cannot be removed with the row-delete button; use whole-switch delete instead.
- The Switch table header label changed from `New Setting` to `Function Setting`.
- Circuit, Device Assign, and Switch tables now use a large resizable table workspace so rows can be reviewed with sticky headers inside the table area.

## Linkage Notes

- Function row deletion keeps the existing `switchGroupId` for the remaining rows.
- Deletion still passes through existing switch normalization so PIR/QSM assignment rules stay protected.
- No CFS value resolver, Link Map resolver, export path, or CCI/CCO Detail mapping was changed in this update.
- CFS fixed-base-column behavior remains separate from the general large table workspace used by Circuit / Device Assign / Switch.

## Verification Focus

- Confirm Switch CCI/Palladiom/Pico/PIR rows show both row delete and whole-switch delete actions.
- Confirm the Row column contains only row-delete controls.
- Confirm the Switch column is merged per switch group, not repeated per button row.
- Confirm QSM still shows QSM deletion only and preserves one-PIR-to-one-QSM assignment rules.
- Confirm Circuit / Device Assign / Switch table headers remain sticky while scrolling inside the table area.

## Planning Checklist

Before future CFS UI changes, list the required inspection items in the plan and evaluate against them after implementation:

- Visual layout and column meaning.
- Operation semantics and disabled states.
- Existing project API before/after state.
- CFS / Link Map / export impact.
- Accessibility labels for icon-only actions.
- Sticky header and scroll behavior.
- Browser console errors.
