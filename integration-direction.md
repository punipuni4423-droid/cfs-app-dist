# Integration Direction

The lighting fixture intake workflow should be integrated into the existing `cfs-app` rather than maintained as a separate application.

## Rationale

`cfs-app` already owns the project data model for Fixture, Circuit, Device Assign, Scene, Switch, Command, and Room Type. The final destination for imported fixture/circuit data is the same project record, so keeping the workflow inside this app avoids duplicate project state and copy/paste transfer steps.

## Boundary

Keep the UI-facing import/export features in the app, but keep heavier intake logic isolated from the main screens:

- PDF parsing
- VA validation
- manufacturer web lookup
- fixture normalization and matching

These should live as a separate intake pipeline module or service boundary that produces normalized records for the existing Fixture and Circuit screens.

## Current Integration

The Circuit screen supports CSV Import and CSV Export. CSV import accepts common column names such as:

- Designer #
- Code
- Symbol
- Fixture
- Qty
- Dimming Type
- Area
- Detail

Imported rows are converted into `CircuitEntry` records so they can flow into the existing Circuit, Device Assign, Scene, Switch, and Command workflow.

## Phased PDF Intake Plan

PDF intake should be added in stages, using the CSV import path as the first stable target format.

1. Extract text/tables from PDF into raw rows without mutating project data.
2. Normalize raw rows into the same columns accepted by CSV import.
3. Show a preview/validation screen for Designer #, Fixture, Qty, Dimming Type, Area, Detail, VA, and warnings.
4. Import approved rows into Fixture and Circuit records.
5. Add VA validation and fixture matching after the base import path is stable.
6. Keep manufacturer web lookup as a later optional step behind the same normalized intake boundary.

Each phase should be testable independently so PDF parsing issues do not break the main editing screens.
