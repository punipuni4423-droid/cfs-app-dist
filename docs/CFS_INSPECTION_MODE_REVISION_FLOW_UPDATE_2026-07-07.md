# CFS InspectionMode Revision Flow Update - 2026-07-07

## User Workflow

1. Before starting InspectionMode, the app checks whether the current Room Type differs from the latest saved revision.
2. If draft changes exist, the app asks whether to save them as a new revision before starting InspectionMode, continue on the current revision, or cancel.
3. During InspectionMode, the toolbar keeps the normal CFS controls on the first row and shows inspection-only controls on the second row.
4. `Linked` edits the linked Area Scene value. `Unlink` writes the selected cell as an override/direct value.
5. Cell editor popovers include:
   - `OK`: close the editor and keep the edited draft value.
   - `Reset`: cancel the current cell edit and restore the original value for that cell.
   - Whole-session rollback remains on the InspectionMode toolbar `Revert` button.
6. Turning InspectionMode off asks whether inspection is complete.
7. If the user confirms, unapplied drafts are written back, Inspection Marks are saved, and the user can finish as a new revision or finish on the current revision.
8. Manual `Save as New Revision` resets Inspection Marks so old inspection highlights do not accumulate.

## Highlight Rules

- Inspection Mark highlight defaults to ON after InspectionMode completion.
- The CFS Highlights menu includes `Inspection Marks`.
- Turning off `Inspection Marks` hides the saved inspection highlight without deleting the marks.
- The InspectionMode `Clear` button clears the current selection or copied range only. It does not delete saved Inspection Marks.
- The InspectionMode `Revert` button cancels the whole session and restores values to the pre-InspectionMode baseline.

## Validation Checklist

- Starting InspectionMode with draft differences prompts for new revision save, current revision continuation, or cancel.
- Cell editor `OK` closes the popover without reverting the edited draft value.
- Cell editor `Reset` restores the current cell to its original value.
- InspectionMode toolbar `Revert` restores values to the pre-InspectionMode baseline.
- Exiting InspectionMode asks for completion confirmation and writes drafts on finish.
- Manual `Save as New Revision` clears current Inspection Marks.
- Highlights menu can hide/show saved Inspection Marks.
- Existing CFS value resolution, Link Map, and Excel export paths are not changed.
