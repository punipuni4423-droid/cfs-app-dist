import type { HvacAssignment, HvacSeason, LocationMaster } from "../types";
import { createDefaultHvacSeasons } from "../lib/constants";
import { thermostatNumberForAssignment } from "../lib/tstatOccupancy";
import { tstatMasterReference } from "../lib/tstatMasterReference";
import SectionHeading from "./SectionHeading";

interface Props {
  assignments: HvacAssignment[];
  seasons: HvacSeason[];
  locations: LocationMaster[];
}

export default function TstatOverview({ assignments, seasons, locations }: Props) {
  const areaName = (id: string) => locations.find(location => location.id === id)?.name || "-";

  return (
    <section className="read-only-overview" aria-label="Thermostat overview">
      <SectionHeading>Thermostat Registration</SectionHeading>
      <div className="matrix-scroll">
        <table className="matrix-table master-table">
          <thead><tr><th>No</th><th>Control Type</th><th>Master / Slave</th><th>Area</th><th>Low End</th><th>High End</th><th>Summer / Winter</th><th>Note</th><th>Reference Master</th></tr></thead>
          <tbody>
            {assignments.map(row => (
              <tr key={row.id}>
                <td>{thermostatNumberForAssignment(assignments, row.id)}</td>
                <td>{row.protocol}</td><td>{row.thermostatRole}</td><td>{areaName(row.area)}</td>
                <td>{row.lowEnd ? `${row.lowEnd} C` : "-"}</td><td>{row.highEnd ? `${row.highEnd} C` : "-"}</td>
                <td>{row.summerWinterChange ? "Enabled" : "Disabled"}</td><td>{row.note || "-"}</td>
                <td>{tstatMasterReference(row, assignments, locations).label}</td>
              </tr>
            ))}
            {!assignments.length ? <tr><td colSpan={9} className="screen-empty">No Thermostats are registered.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <SectionHeading>Season Schedule</SectionHeading>
      <div className="matrix-scroll">
        <table className="matrix-table master-table">
          <thead><tr><th>Season</th><th>Start Date</th><th>End Date</th></tr></thead>
          <tbody>
            {(seasons.length ? seasons : createDefaultHvacSeasons()).map(season => (
              <tr key={season.id}><td>{season.name || "-"}</td><td>{season.startMonth}/{season.startDay}</td><td>{season.endMonth}/{season.endDay}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
